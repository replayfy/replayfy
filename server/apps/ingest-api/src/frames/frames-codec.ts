/**
 * Shared decoder for the raw `[uint64 ts][uint32 size][bytes]` frames archive
 * format (the reference mobile capture format — JPEG payloads). Extracted to a
 * util module because both the stream worker and the orphan finalizer summarise
 * batches, and the repo forbids free functions inside *.service.ts files.
 */

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
