/**
 * Shared decoder for the raw `[uint64 ts][uint32 size][bytes]` frames archive
 * format (the reference mobile capture format — JPEG payloads). Extracted to a
 * util module because both the stream worker and the orphan finalizer summarise
 * batches, and the repo forbids free functions inside *.service.ts files.
 */

/** Bytes before each frame's payload: the uint64 timestamp + uint32 size. */
const FRAME_HEADER_BYTES = 12;

/**
 * Summarise one raw batch: total frame count + the last frame's absolute
 * timestamp (epoch ms). `lastTs − session.startedAt` is the playable duration —
 * the same value the player derives from the frames, so the session-list
 * duration matches exactly.
 */
export function framesSummary(buf: Buffer): { count: number; lastTs: number } {
  let off = 0;
  let count = 0;
  let lastTs = 0;
  while (off + 12 <= buf.length) {
    const ts = Number(buf.readBigUInt64LE(off));
    const size = buf.readUInt32LE(off + 8);
    off += 12 + size;
    if (off > buf.length) break;
    lastTs = ts;
    count += 1;
  }
  return { count, lastTs };
}

/** Capture timestamp (epoch ms, device clock) of one whole frame record. */
export function frameTs(record: Buffer): number {
  return Number(record.readBigUInt64LE(0));
}

/**
 * Split a raw batch into its whole `[ts][size][bytes]` records (views into
 * `buf`, no copies). A truncated trailing record is dropped, the same rule
 * framesSummary counts by.
 */
export function splitFrames(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let off = 0;
  while (off + FRAME_HEADER_BYTES <= buf.length) {
    const end = off + FRAME_HEADER_BYTES + buf.readUInt32LE(off + 8);
    if (end > buf.length) break;
    out.push(buf.subarray(off, end));
    off = end;
  }
  return out;
}

/**
 * Incremental splitFrames for a byte stream whose chunk edges fall anywhere
 * (a gunzip stream of a stored archive). Holds back only the bytes of the
 * record that is still incomplete, so an archive is read with memory bounded by
 * one frame rather than the whole session.
 */
export class FrameSplitter {
  private rest: Buffer = Buffer.alloc(0);

  /** Feed the next chunk; returns every record it completed. */
  push(chunk: Buffer): Buffer[] {
    const buf =
      this.rest.length > 0 ? Buffer.concat([this.rest, chunk]) : chunk;
    const out = splitFrames(buf);
    const used = out.reduce((n, r) => n + r.length, 0);
    // Copy the tail so it doesn't pin the (possibly large) chunk it came from.
    this.rest = Buffer.from(buf.subarray(used));
    return out;
  }
}
