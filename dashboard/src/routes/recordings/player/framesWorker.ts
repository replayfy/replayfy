/* ===========================================================================
   Off-main-thread frames decompressor (Vite module worker).

   The expensive part of loading a mobile session is the gzip inflate of the
   frames archive (hundreds of JPEGs, often multi-MB) — running it on the main
   thread janks the player for the whole decode. This worker does the
   `fetch` + `gunzip` and transfers the decompressed buffer back, so the main
   thread only does the cheap offset-parse + lazy blob-URL creation.

   Message in:  { url }
   Message out: { ok: true, buffer: ArrayBuffer }   (buffer is transferred)
             |  { ok: false, status?, error? }
   ========================================================================== */
import { gunzipSync } from "fflate";

/** Minimal worker-scope surface; tsconfig uses the DOM lib (not webworker), so
 *  `self` is typed as a window — narrow it to just what we call. */
type FramesWorkerCtx = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<{ url?: string }>) => void) | null;
};

const ctx = self as unknown as FramesWorkerCtx;

ctx.onmessage = async (e) => {
  const url = e.data?.url;
  if (!url) {
    ctx.postMessage({ ok: false, error: "no url" });
    return;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) {
      ctx.postMessage({ ok: false, status: res.status });
      return;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
    const out = isGzip ? gunzipSync(bytes) : bytes;
    // Copy out to an exact, standalone ArrayBuffer so it can be transferred
    // (a view's backing buffer may be larger / shared with fflate internals).
    const buffer = out.buffer.slice(
      out.byteOffset,
      out.byteOffset + out.byteLength,
    ) as ArrayBuffer;
    ctx.postMessage({ ok: true, buffer }, [buffer]);
  } catch (err) {
    ctx.postMessage({
      ok: false,
      error: String((err as Error)?.message || err),
    });
  }
};
