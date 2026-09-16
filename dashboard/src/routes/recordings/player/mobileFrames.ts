/* ===========================================================================
   Mobile replay frames loader.

   The backend serves one per-session archive: a flat concatenation of

       [uint64 LE timestamp][uint32 LE size][image bytes]

   gzip-compressed. We fetch it once (directly from R2 — the API is never in
   the data path), decompress off the main thread, and split it into frames
   keyed by playhead offset (ts - sessionStart). Each frame holds a lazily
   created blob URL so we only allocate object URLs for frames we display.
   ========================================================================== */
import { gunzipSync } from "fflate";
import type { MobileFrame } from "./playerTypes";

type FramesResult = { frames: MobileFrame[]; count: number };

/** Decompress a frames archive. Detects gzip (the format our backend emits)
 *  by magic bytes; passes through uncompressed input unchanged. */
function unpack(bytes: Uint8Array): Uint8Array {
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
  if (isGzip) return gunzipSync(bytes);
  return bytes;
}

/** Parse the decompressed `[ts][size][data]` stream into frames sorted by time.
 *  `time` is the offset from sessionStart (ms) — the player's playhead is also
 *  offset-based, so they line up directly. */
function parseFrames(
  buffer: Uint8Array | ArrayBuffer,
  sessionStart: number,
  fileFormat: string,
): FramesResult {
  // A Uint8Array from the decompressor may be a view into a larger ArrayBuffer
  // with a non-zero byteOffset. Slice to an exact backing buffer so DataView
  // reads from the right position (otherwise the uint64 ts reads garbage).
  let backing: ArrayBuffer;
  if (buffer instanceof Uint8Array) {
    backing = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
  } else {
    backing = buffer;
  }
  const view = new DataView(backing);
  const frames: MobileFrame[] = [];
  let offset = 0;
  let prevTime = -Infinity;
  let sorted = true;

  while (offset + 12 <= backing.byteLength) {
    const tsLow = view.getUint32(offset, true);
    const tsHigh = view.getUint32(offset + 4, true);
    const ts = tsHigh * 0x100000000 + tsLow;
    offset += 8;

    const size = view.getUint32(offset, true);
    offset += 4;

    if (offset + size > backing.byteLength) break;

    const time = ts - sessionStart;
    // View into the original buffer; no copy until getBlobUrl().
    const dataView = new Uint8Array(backing, offset, size);

    frames.push({
      time,
      getBlobUrl(): string {
        return URL.createObjectURL(
          new Blob([dataView], { type: `image/${fileFormat}` }),
        );
      },
    });

    if (time < prevTime) sorted = false;
    prevTime = time;
    offset += size;
  }

  if (!sorted) frames.sort((a, b) => a.time - b.time);
  return { frames, count: frames.length };
}

/** Inline (main-thread) fetch + gunzip. Fallback for when a Worker can't be
 *  constructed (or crashes). Returns the decompressed bytes' ArrayBuffer, or
 *  null on a failed fetch. */
async function inlineDecompress(url: string): Promise<ArrayBuffer | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const out = unpack(new Uint8Array(await res.arrayBuffer()));
  return out.buffer.slice(
    out.byteOffset,
    out.byteOffset + out.byteLength,
  ) as ArrayBuffer;
}

/** Decompress the archive off the main thread; fall back to the inline path if
 *  Workers are unavailable or the worker errors. Resolves to the decompressed
 *  ArrayBuffer, or null on fetch failure. */
function decompressInWorker(url: string): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./framesWorker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      inlineDecompress(url).then(resolve, () => resolve(null));
      return;
    }
    const settle = (val: ArrayBuffer | null) => {
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
      resolve(val);
    };
    worker.onmessage = (
      ev: MessageEvent<{ ok?: boolean; buffer?: ArrayBuffer }>,
    ) => {
      const d = ev.data;
      if (d && d.ok && d.buffer) settle(d.buffer);
      else settle(null);
    };
    worker.onerror = () => {
      // Worker failed to load/run — degrade to the main-thread path.
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
      inlineDecompress(url).then(resolve, () => resolve(null));
    };
    worker.postMessage({ url });
  });
}

/** Fetch + decompress + parse a frames archive URL. Returns { frames, count }
 *  or null on any failure (caller falls back to the per-event imageRef path).
 *  `url` is the archive's direct R2 URL (edge-served, cached — the API is never
 *  in the data path); requires an open CORS policy on the R2 bucket. */
export async function loadFramesArchive(
  url: string,
  sessionStart: number,
  fileFormat = "png",
): Promise<FramesResult | null> {
  try {
    const buffer = await decompressInWorker(url);
    if (!buffer) return null;
    return parseFrames(new Uint8Array(buffer), sessionStart, fileFormat);
  } catch (e) {
    console.warn("[mobileFrames] failed to load frames archive", e);
    return null;
  }
}

/** Walk frames to the most-recent one whose `time` ≤ playhead. A linear scan is
 *  fine for the few-hundred-frame sessions mobile produces. Returns the frame
 *  index (or -1 before the first frame). */
export function frameIndexAt(
  frames: MobileFrame[],
  playheadMs: number,
): number {
  let idx = -1;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].time <= playheadMs) idx = i;
    else break;
  }
  return idx;
}
