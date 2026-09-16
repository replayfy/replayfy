import { createGzip, type Gzip } from "zlib";
import type { Redis } from "ioredis";
import { StorageService } from "../storage/storage.service";
import { framesGzKey, framesMpKey, PART_MIN_BYTES } from "./frames.constants";
import { framesSummary } from "./frames-codec";

/**
 * Per-session gzip → R2 multipart upload, held in worker memory while the
 * owning worker drains the session's Redis stream.
 *
 * ONE continuous gzip stream per session (NOT a gzip-per-batch): raw frame
 * bytes are written to a single `createGzip()`, and its compressed OUTPUT is
 * sliced into multipart parts at ≥5 MiB byte boundaries. The reassembled object
 * is therefore byte-identical to the legacy `createReadStream(file).pipe(
 * createGzip())` whole-file archive — a single-member gzip — so the dashboard
 * player and SDK contract need NO changes (a per-batch multi-member gzip would
 * have risked that).
 *
 * Because it's one continuous deflate stream, parts cannot be resumed across a
 * process restart (zlib state isn't serialisable). That's fine: the durable
 * Redis stream is retained until finalize, so a takeover worker / the orphan
 * finalizer just aborts this upload and rebuilds from scratch. The incremental
 * parts are the no-crash fast path ("upload as frames arrive, no disk"); the
 * rebuild is the rare recovery path.
 *
 * Not a *.service.ts — a plain helper class instantiated per owned session, so
 * it's exempt from the no-free-functions rule while keeping the worker lean.
 */
export class SessionUpload {
  private readonly gzKey: string;
  private readonly gzip: Gzip;
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private partNumber = 0;
  private readonly parts: Array<{ partNumber: number; etag: string }> = [];
  private uploadId: string | null = null;
  private gzipEnded = false;

  /** Running totals written to Postgres at finalize (no per-batch DB I/O). */
  count = 0;
  bytes = 0;
  lastTs = 0;
  /** Last Redis stream entry id consumed — the drain cursor. */
  lastId = "";

  constructor(
    readonly sid: string,
    private readonly storage: StorageService,
    private readonly redis: Redis,
  ) {
    this.gzKey = framesGzKey(sid);
    this.gzip = createGzip();
    // Collect compressed output as it's produced; we never let it buffer in the
    // stream itself, so there's no slow-consumer backpressure to manage.
    this.gzip.on("data", (chunk: Buffer) => {
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
    });
  }

  /** Feed one raw batch through the gzip stream + update running totals. */
  async writeBatch(raw: Buffer): Promise<void> {
    const summary = framesSummary(raw);
    this.count += summary.count;
    this.bytes += raw.length;
    if (summary.lastTs > this.lastTs) this.lastTs = summary.lastTs;
    await new Promise<void>((resolve, reject) => {
      this.gzip.write(raw, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Flush a part if ≥5 MiB of gzip output has accumulated (R2's non-final part
   * minimum). Called after each drain; mid-session parts realise "upload to R2
   * as data comes in" for long sessions. Small sessions flush their single
   * part at finish() instead.
   */
  async flushFullParts(): Promise<void> {
    while (this.pendingBytes >= PART_MIN_BYTES) {
      await this.uploadOnePart(this.takePending(PART_MIN_BYTES));
    }
  }

  /**
   * End the gzip stream, upload the trailing bytes as the final part (no size
   * minimum), and complete the multipart upload. Returns the object's public
   * URL, or null when storage is disabled or the session had no frames.
   */
  async finish(): Promise<string | null> {
    if (!this.gzipEnded) {
      this.gzipEnded = true;
      // Register the 'end' listener BEFORE end() so we can't miss it. 'end'
      // fires on the readable side after every compressed chunk has been
      // drained into `pending` (the 'data' handler keeps the stream flowing).
      await new Promise<void>((resolve, reject) => {
        this.gzip.once("error", reject);
        this.gzip.once("end", () => resolve());
        this.gzip.end();
      });
    }

    if (this.pendingBytes > 0) {
      await this.uploadOnePart(this.takePending(this.pendingBytes));
    }
    if (this.parts.length === 0 || !this.uploadId) {
      // Nothing was ever uploaded (no frames / storage disabled).
      return null;
    }
    const url = await this.storage.completeMultipartUpload({
      key: this.gzKey,
      uploadId: this.uploadId,
      parts: this.parts,
    });
    await this.redis.del(framesMpKey(this.sid));
    return url;
  }

  /** Abort the in-progress upload + clear its mirrored state (takeover /
   *  shutdown / failed finalize) so no staged parts are left dangling. */
  async abort(): Promise<void> {
    if (this.uploadId) {
      await this.storage.abortMultipartUpload(this.gzKey, this.uploadId);
    }
    await this.redis.del(framesMpKey(this.sid));
  }

  /** Pull up to `max` bytes off the pending output queue as one Buffer. */
  private takePending(max: number): Buffer {
    const out: Buffer[] = [];
    let taken = 0;
    while (this.pending.length > 0 && taken < max) {
      const head = this.pending[0];
      const need = max - taken;
      if (head.length <= need) {
        out.push(head);
        taken += head.length;
        this.pending.shift();
      } else {
        out.push(head.subarray(0, need));
        this.pending[0] = head.subarray(need);
        taken += need;
      }
    }
    this.pendingBytes -= taken;
    return Buffer.concat(out, taken);
  }

  private async uploadOnePart(body: Buffer): Promise<void> {
    if (body.length === 0) return;
    if (!this.uploadId) {
      this.uploadId = await this.storage.createMultipartUpload(this.gzKey);
      if (!this.uploadId) return; // storage disabled — nothing to upload
      // Mirror the uploadId so a takeover worker / the orphan finalizer can
      // abort this dangling upload before rebuilding.
      await this.redis.hset(framesMpKey(this.sid), "uploadId", this.uploadId);
    }
    const partNumber = this.partNumber + 1;
    const etag = await this.storage.uploadPart({
      key: this.gzKey,
      uploadId: this.uploadId,
      partNumber,
      body,
    });
    if (!etag) return;
    this.partNumber = partNumber;
    this.parts.push({ partNumber, etag });
  }
}
