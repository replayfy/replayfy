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
import { DEFAULT_STALE_MS } from "@/api/queryClient";
import type { FramesInfo, MobileFrame } from "./playerTypes";

type FramesResult = { frames: MobileFrame[]; count: number };

/** How long a PENDING /frames descriptor (`pending: true` — the session is
 *  LIVE or its frames are queued for finalize) may be served from cache: not
 *  at all. A finalized descriptor is immutable and keeps the client default.
 *
 *  The reference player fetches the descriptor once per open and never polls;
 *  this keeps that. It only stops a cached "not ready yet" from sticking — at
 *  the default 30 s staleTime (and a 7-day gcTime), reopening the session soon
 *  after got the cached null URL straight back, so the player kept saying it
 *  had no frames after the archive existed. Stale only means the NEXT open
 *  re-asks (framesRefetchOnReturn keeps focus / reconnect from re-asking a
 *  pending answer); nothing refetches on a timer, and an open that overlaps
 *  a request in flight shares it. */
export const FRAMES_PENDING_STALE_MS = 0;

/** staleTime for a cached /frames descriptor, from the descriptor itself
 *  (useApi `staleTime`; used by the dashboard player and the share page). */
export function framesStaleTime(info: FramesInfo | undefined): number {
  return info?.pending ? FRAMES_PENDING_STALE_MS : DEFAULT_STALE_MS;
}

/** Whether the tab regaining focus / the network coming back may re-ask a
 *  stale /frames descriptor, from the descriptor cached at that moment.
 *
 *  Not a PENDING one: it is stale at once (above), so the client defaults
 *  would re-ask it on every focus — the reference asks once per open, and
 *  the processing copy asks the user to check again, which is a reopen (each
 *  focus re-ask would also swap the panel for the spinner while in flight).
 *
 *  Everything else keeps the client default. With no descriptor cached the
 *  ask FAILED (retry spent): turning focus off for it too left a transient
 *  502's "No snapshots captured" up until the user switched sessions or
 *  reloaded — the share page has no other way back. A finalized descriptor
 *  is only re-asked once past the default staleTime, as before, and comes
 *  back with the same URL. */
export function framesRefetchOnReturn(info: FramesInfo | undefined): boolean {
  return !info?.pending;
}

/** useApi options for the /frames descriptor query, shared by the dashboard
 *  player and the share page: ONE request per open for a pending answer, as
 *  the reference player — never served from cache (the next open re-asks),
 *  never on a timer, focus or reconnect. */
export const FRAMES_QUERY_OPTS = {
  staleTime: framesStaleTime,
  refetchOnWindowFocus: framesRefetchOnReturn,
  refetchOnReconnect: framesRefetchOnReturn,
} as const;

/** Decompress a frames archive. Detects gzip (the format our backend emits)
 *  by magic bytes; passes through uncompressed input unchanged. */
function unpack(bytes: Uint8Array): Uint8Array {
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
  if (isGzip) return gunzipSync(bytes);
  return bytes;
}

/** Parse the decompressed `[ts][size][data]` stream into frames sorted by time.
 *  `time` is the offset from sessionStart (ms) — the player's playhead is also
 *  offset-based, so they line up directly.
 *
 *  A record whose size runs past the end stops the parse, so a truncated
 *  archive still plays the frames before the cut. Bytes that hold no whole
 *  record at all are not an archive — an HTML / XML error page served with a
 *  200, or a body cut inside its first frame — and throw: that is a failed
 *  load, not a session that captured nothing. An empty body is zero frames. */
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

  if (frames.length === 0 && backing.byteLength > 0)
    throw new Error("not a frames archive: no whole frame in the body");
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
 *  or null on any failure — a non-2xx (a retention-pruned archive 404s), a
 *  gunzip error, or a body that is not an archive (parseFrames). The caller
 *  keeps the two apart: null gets the reference tracker's load-error copy
 *  (unless per-event imageRef / wireframe content can paint), and so do zero
 *  frames from a descriptor that counts some; zero frames from one that
 *  counts none get "No snapshots captured".
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
