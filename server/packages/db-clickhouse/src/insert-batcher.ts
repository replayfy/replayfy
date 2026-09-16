/**
 * Coalesce many small ClickHouse inserts into few large ones.
 *
 * ClickHouse is built for a low rate of large inserts, not a high rate of tiny
 * ones: every INSERT — even a 2-row async_insert — costs per-request parsing +
 * async-buffer bookkeeping on the server. Under ingest load (thousands of
 * session batches/sec, each ~2 rows) that per-request overhead saturates the
 * CH node (measured: CH CPU pinned at ~800%, insert latency ballooning from
 * ~15ms to ~1000ms) and becomes the single wall on worker drain throughput.
 *
 * This batcher accepts rows from many concurrent callers, buffers them, and
 * flushes ONE bulk insert per time/size window. Each caller's promise resolves
 * (or rejects) with the flush that carried its rows, so the durability contract
 * is unchanged: the caller still knows when its rows hit (or failed to hit) CH,
 * and the existing best-effort try/catch around the insert keeps CH failures
 * non-fatal + recoverable by backfill — exactly as before, just batched.
 *
 * BACKPRESSURE: callers may fire-and-forget (the replay worker does), so the
 * batcher cannot rely on the caller awaiting to bound growth. If ClickHouse
 * stalls, buffered + in-flight rows would otherwise grow at ingest-rate ×
 * stall-duration until the worker OOMs. `maxOutstandingRows` caps the TOTAL
 * rows the batcher will hold (buffered + in-flight); once over it, enqueue()
 * SHEDS the batch (resolves without inserting) rather than growing the heap —
 * safe because CH is best-effort with Mongo as the durable backstop and the
 * nightly backfill re-derives. Dropped rows are counted and logged.
 *
 * Generic over the row type so it carries no dependency on the projection shape
 * (avoids an import cycle with index.ts).
 */
export interface InsertBatcherOptions {
  /** Flush once this many rows have accumulated (bounds buffer growth + insert
   *  size). */
  maxRows: number;
  /** Flush at most this long after the first row of a window arrives (bounds
   *  the visibility delay a row can incur). */
  maxWaitMs: number;
  /** Hard ceiling on buffered + in-flight rows. Over this, enqueue() sheds
   *  (drops) rather than growing the heap during a CH stall. */
  maxOutstandingRows: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class ClickHouseInsertBatcher<Row> {
  private buffer: Row[] = [];
  private waiters: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Rows currently held: buffered (awaiting flush) + in-flight (insert not yet
   *  settled). The backpressure ceiling is enforced against this. */
  private outstandingRows = 0;
  private droppedRows = 0;
  private lastDropLogMs = 0;
  /** Inserts fired but not yet settled — so flushNow() (shutdown) can await
   *  inserts triggered by a PRIOR timer/size flush, not just the current
   *  buffer. Each entry always resolves (never rejects). */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly insertFn: (rows: Row[]) => Promise<void>,
    private readonly opts: InsertBatcherOptions,
  ) {}

  /**
   * Buffer `rows`; resolves when the flush that carries them completes. Rejects
   * with the flush error if that bulk insert fails (callers keep their existing
   * swallow/retry policy — this method does not decide it). If the batcher is
   * saturated (CH stalled), the batch is SHED: enqueue resolves immediately
   * without inserting, so a fire-and-forget caller can't grow the heap.
   */
  enqueue(rows: Row[]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    // Load-shed under a CH stall. Resolve (not reject): shedding is an
    // intentional best-effort drop, not an error the caller should retry.
    if (this.outstandingRows + rows.length > this.opts.maxOutstandingRows) {
      this.droppedRows += rows.length;
      this.maybeLogDrops();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      for (const r of rows) this.buffer.push(r);
      this.outstandingRows += rows.length;
      this.waiters.push({ resolve, reject });
      if (this.buffer.length >= this.opts.maxRows) {
        // Size trigger — flush now, don't wait out the timer.
        void this.flush();
      } else if (this.timer === null) {
        // First row of a new window — arm the time trigger.
        this.timer = setTimeout(() => {
          void this.flush();
        }, this.opts.maxWaitMs);
      }
    });
  }

  /** Flush the current buffer AND wait for every already in-flight insert to
   *  settle — used on shutdown so the process doesn't exit while a prior
   *  timer/size-triggered insert's socket is still open (which would drop those
   *  rows). All tracked promises resolve (never reject), so this can't throw. */
  flushNow(): Promise<void> {
    void this.flush();
    return Promise.all([...this.inFlight]).then(() => undefined);
  }

  /** How many rows have been dropped by load-shedding (for observability). */
  droppedRowCount(): number {
    return this.droppedRows;
  }

  /** Swap the buffer out synchronously (so rows arriving DURING the insert
   *  start a fresh window rather than racing this flush) and fire ONE bulk
   *  insert. Returns a promise that RESOLVES once the insert settles — even on
   *  failure — so `flushNow()` can be awaited; per-caller waiters still get the
   *  real resolve/reject. Concurrent flushes are allowed (each owns a disjoint
   *  row set), and total in-flight rows stay bounded by maxOutstandingRows. */
  private flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return Promise.resolve();
    const rows = this.buffer;
    const waiters = this.waiters;
    const n = rows.length;
    this.buffer = [];
    this.waiters = [];
    // rows stay counted in outstandingRows while in-flight; released on settle.
    const settle = this.insertFn(rows).then(
      () => {
        this.outstandingRows -= n;
        for (const w of waiters) w.resolve();
      },
      (err) => {
        this.outstandingRows -= n;
        for (const w of waiters) w.reject(err);
        // Swallow here so the promise flush() itself returns always RESOLVES —
        // callers that fire-and-forget (or await flushNow) never see an
        // unhandled rejection; the per-caller waiters already carry the error.
      },
    );
    // Track until settled so flushNow() can await it even after the buffer moved on.
    this.inFlight.add(settle);
    void settle.finally(() => this.inFlight.delete(settle));
    return settle;
  }

  private maybeLogDrops(): void {
    const now = Date.now();
    if (now - this.lastDropLogMs < 5000) return;
    this.lastDropLogMs = now;
    process.stderr.write(
      `[ch-batcher] load-shedding projection rows (CH saturated): ${this.droppedRows} dropped total; Mongo + backfill are the backstop\n`,
    );
  }
}
