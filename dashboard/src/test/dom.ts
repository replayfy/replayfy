/* Shared harness for component tests (vitest + happy-dom). happy-dom has a DOM
   but no layout engine and no image decoder, and the mobile player needs both
   before it paints: it fits the device shell to the `.rv-stage` box and sniffs
   the device size from the first frame. These stubs give it a 1200×900 stage
   (stubStageSize changes it) and a 390×844 frame so the stage renders as it
   does in a browser. */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

// Lets act() flush effects and state updates (React's test-environment flag).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** An Image whose every load "decodes" a 390×844 frame on the next task. */
class FrameImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  private current = "";
  get src() {
    return this.current;
  }
  set src(v: string) {
    this.current = v;
    setTimeout(() => {
      this.naturalWidth = 390;
      this.naturalHeight = 844;
      this.onload?.();
    }, 0);
  }
  decode() {
    return Promise.resolve();
  }
}

/** Layout + media stubs the players need, and a hand-cranked animation frame:
 *  the players' clocks re-schedule a rAF every frame, and a real one would
 *  keep act() flushing forever. Step them with `advanceFrames()`. Call in
 *  `beforeEach`; `resetPlayerEnvironment` in `afterEach` undoes it all. */
export function stubPlayerEnvironment() {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal("Image", FrameImage);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  stubStageSize(1200, 900);
}

/** Size of every `.rv-stage` box (px); other elements measure 0. */
export function stubStageSize(width: number, height: number) {
  for (const [prop, size] of [
    ["clientWidth", width],
    ["clientHeight", height],
  ] as const) {
    vi.spyOn(HTMLElement.prototype, prop, "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("rv-stage") ? size : 0;
      },
    );
  }
}

export function resetPlayerEnvironment() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

export type Mounted = {
  container: HTMLElement;
  unmount: () => void;
};

/** Render into a fresh container. `stage` wraps it in `.rv-stage > .rv-screen`
 *  for a player rendered on its own (RvStage / SharePage bring their own). */
export async function mount(
  el: ReactElement,
  opts: { stage?: boolean } = {},
): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let target = host;
  if (opts.stage) {
    host.className = "rv-stage";
    target = document.createElement("div");
    target.className = "rv-screen";
    host.appendChild(target);
  }
  const root: Root = createRoot(target);
  await act(async () => {
    root.render(el);
  });
  return {
    container: host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Let pending promises and timers run (`ms` of real time), flushing React's
 *  updates. Animation frames only advance through `advanceFrames()`. */
export async function flush(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** Run `fn` (e.g. an imperative seek) inside act(), then flush. */
export async function run(fn: () => void) {
  await act(async () => {
    fn();
  });
  await flush();
}

/** Run `n` animation frames (16 ms each), flushing React after each. */
export async function advanceFrames(n = 1) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      vi.advanceTimersByTime(16);
    });
  }
}
