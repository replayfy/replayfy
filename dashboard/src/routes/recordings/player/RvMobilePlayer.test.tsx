/* Component tests for the mobile player's clock and screen state (`yarn test`).
   The frames archive loader is mocked (no network / worker); everything else —
   duration, the rAF clock, skip inactivity, the idle-region report and the
   badge beside the device — is the real component in happy-dom. The recurring
   fixture is the session behind the bug: 6:27 long, frames only in its first
   21 s. */
import { act, createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RvMobilePlayer } from "./RvMobilePlayer";
import { loadFramesArchive } from "./mobileFrames";
import type { TimelineMark } from "./mobileTimeline";
import type {
  FramesInfo,
  MobileFrame,
  ReplayBatch,
  RvPlayerHandle,
} from "./playerTypes";
import {
  flush,
  advanceFrames,
  mount,
  resetPlayerEnvironment,
  run,
  stubPlayerEnvironment,
  stubStageSize,
  type Mounted,
} from "@/test/dom";

// Only the download is mocked; the rest of the module is the real one.
vi.mock("./mobileFrames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mobileFrames")>()),
  loadFramesArchive: vi.fn(),
}));

const SESSION_MS = 387_000; // 6:27
const FRAMES_INFO: FramesInfo = {
  url: "https://frames.example/archive.gz",
  count: 0,
  startedAt: 1_760_000_000_000,
  fileFormat: "jpeg",
};

function archiveFrames(times: number[]): MobileFrame[] {
  return times.map((time) => ({ time, getBlobUrl: () => `blob:f${time}` }));
}
/** Every 250 ms from 0.5 s to 21 s — capture stopped at 0:21. */
const EARLY = Array.from({ length: 83 }, (_, i) => 500 + i * 250);
/** Every second for the whole session. */
const FULL = (ms: number) =>
  Array.from({ length: Math.floor(ms / 1000) }, (_, i) => 500 + i * 1000);

type Props = Partial<Parameters<typeof RvMobilePlayer>[0]>;

let view: Mounted | null = null;
const ref = createRef<RvPlayerHandle>();

async function renderPlayer(frameTimes: number[], props: Props = {}) {
  vi.mocked(loadFramesArchive).mockResolvedValue({
    frames: archiveFrames(frameTimes),
  } as Awaited<ReturnType<typeof loadFramesArchive>>);
  const all = {
    batches: [],
    framesInfo: FRAMES_INFO,
    playing: false,
    speed: 1,
    platform: "ios",
    sessionDurationMs: SESSION_MS,
    ...props,
  };
  view = await mount(<RvMobilePlayer ref={ref} {...all} />, { stage: true });
  // Archive resolves, then the first frame's size is sniffed.
  await flush(5);
  await flush(5);
  return view;
}

/** The badge beside the device (role=status), or null. */
const badge = () => view?.container.querySelector('[role="status"]') ?? null;

beforeEach(() => {
  stubPlayerEnvironment();
});
afterEach(() => {
  view?.unmount();
  view = null;
  resetPlayerEnvironment();
});

describe("duration", () => {
  test("is the session's length, not the last frame's time", async () => {
    const onDuration = vi.fn();
    await renderPlayer(EARLY, { onDuration });
    expect(onDuration).toHaveBeenLastCalledWith(SESSION_MS / 1000);
  });

  test("the clock runs past the last frame instead of clamping to it", async () => {
    await renderPlayer(EARLY, { playing: true });
    await run(() => ref.current!.goto(200));
    await advanceFrames(3);
    const t = ref.current!.getCurrentTime();
    expect(t).toBeGreaterThanOrEqual(200);
    expect(t).toBeLessThan(SESSION_MS / 1000);
  });
});

describe("skip inactivity", () => {
  test("reports the frameless tail to the scrubber as an idle region", async () => {
    const onIdleRegions = vi.fn();
    await renderPlayer(EARLY, { onIdleRegions });
    expect(onIdleRegions).toHaveBeenLastCalledWith([
      { from: 21_000 / SESSION_MS, to: 1 },
    ]);
  });

  test("playing into a skip range jumps to its end", async () => {
    await renderPlayer(EARLY, { playing: true, skipIdle: true });
    // The tick right after a seek never jumps (seek guard); the next one does.
    await run(() => ref.current!.goto(25));
    await advanceFrames(3);
    expect(ref.current!.getCurrentTime()).toBe(SESSION_MS / 1000);
  });

  test("off: playback runs through the range", async () => {
    await renderPlayer(EARLY, { playing: true, skipIdle: false });
    await run(() => ref.current!.goto(25));
    await advanceFrames(3);
    const t = ref.current!.getCurrentTime();
    expect(t).toBeGreaterThanOrEqual(25);
    expect(t).toBeLessThan(30);
  });

  test("a capped /timeline does not turn the rest of the session idle", async () => {
    // A fully recorded hour with a tap every 5 s whose /timeline was cut at
    // its first 2000 rows (~18 min): nothing past the cut may read as idle.
    const hour = 3_600_000;
    const rows: TimelineMark[] = [];
    for (let t = 0; t < hour; t += 600) rows.push({ kind: "network", offsetMs: t });
    for (let t = 2_000; t < hour; t += 5_000)
      rows.push({ kind: "tap", eventType: "click", offsetMs: t });
    rows.sort((a, b) => a.offsetMs - b.offsetMs);
    // What the API returns: the first 2000 rows by time.
    const capped = rows.slice(0, 2000);
    expect(capped[capped.length - 1].offsetMs).toBeLessThan(hour / 2);
    const onIdleRegions = vi.fn();
    const onDuration = vi.fn();
    await renderPlayer(FULL(hour), {
      sessionDurationMs: hour,
      timeline: capped,
      onIdleRegions,
      onDuration,
    });
    // The archive has resolved (the length is only reported then), so the
    // last report is the real skip ranges, not the empty pre-load ones.
    expect(onDuration).toHaveBeenCalledWith(hour / 1000);
    expect(onIdleRegions).toHaveBeenLastCalledWith([]);
  });
});

describe("screen-state badge", () => {
  test("past the last frame: no screen recorded, with its range and the way past it", async () => {
    await renderPlayer(EARLY);
    await run(() => ref.current!.goto(100));
    const b = badge();
    expect(b?.textContent).toContain("No screen recorded");
    expect(b?.textContent).toContain("No frames from 0:21 to 6:27.");
    expect(b?.textContent).toContain("Skip inactivity jumps past it.");
    // At a real frame there is nothing to say.
    await run(() => ref.current!.goto(10));
    expect(badge()).toBeNull();
  });

  test("promises events only when the timeline has some in the stretch", async () => {
    // No timeline (a share link without the Events panel): no promise.
    await renderPlayer(EARLY);
    await run(() => ref.current!.goto(100));
    expect(badge()?.textContent).not.toContain("Events on the timeline");
    view!.unmount();
    await renderPlayer(EARLY, {
      timeline: [{ kind: "network", offsetMs: 200_000 }],
    });
    await run(() => ref.current!.goto(100));
    expect(badge()?.textContent).toContain("Events on the timeline still play.");
  });

  test("names the background stretch, not the whole frameless one", async () => {
    // Frames stop at 0:21; the app is in the background 3:00 → 5:00 only.
    await renderPlayer(EARLY, {
      timeline: [
        { kind: "perf", metric: "background", value: 0.001, offsetMs: 180_000 },
        { kind: "perf", metric: "background", value: 0, offsetMs: 300_000 },
      ],
    });
    await run(() => ref.current!.goto(240));
    expect(badge()?.textContent).toContain("In background");
    expect(badge()?.textContent).toContain("From 3:00 to 5:00.");
    await run(() => ref.current!.goto(330));
    expect(badge()?.textContent).toContain("No screen recorded");
  });

  test("shows the background badge for a short trip too, frames or not", async () => {
    // A 3 s trip to the app switcher in a fully recorded session: no
    // frameless stretch, but the app WAS in the background (reference badge).
    await renderPlayer(FULL(SESSION_MS), {
      timeline: [
        { kind: "perf", metric: "background", value: 0.001, offsetMs: 60_000 },
        { kind: "perf", metric: "background", value: 0, offsetMs: 63_000 },
      ],
    });
    await run(() => ref.current!.goto(61));
    expect(badge()?.textContent).toContain("In background");
    expect(badge()?.textContent).toContain("From 1:00 to 1:03.");
    await run(() => ref.current!.goto(64));
    expect(badge()).toBeNull();
  });

  test("on a stage too narrow for the column, the chip stays on screen", async () => {
    // A phone-width viewport: the device fills the stage, so a column beside
    // it would be clipped off. The chip sits over the bottom of the device.
    stubStageSize(360, 780);
    await renderPlayer(EARLY);
    await run(() => ref.current!.goto(100));
    const b = badge() as HTMLElement;
    expect(b.style.left).toBe("50%");
    const chip = b.querySelector(".rv-chip") as HTMLElement;
    expect(chip.textContent).toContain("No screen recorded");
    expect(chip.title).toBe("No frames from 0:21 to 6:27.");
  });

  test("sits beside the device as a light chip, not over the screen", async () => {
    await renderPlayer(EARLY);
    await run(() => ref.current!.goto(100));
    const b = badge() as HTMLElement;
    expect(b.querySelector(".rv-chip")).not.toBeNull();
    // Not inside the scaled device box, so it neither covers the held frame
    // nor shrinks with the phone.
    let el: HTMLElement | null = b;
    while (el && el !== view!.container) {
      expect(el.style.transform).not.toMatch(/scale/);
      expect(el.style.overflow).not.toBe("hidden");
      el = el.parentElement;
    }
  });
});

describe("frames descriptor states", () => {
  /** /frames for a session that is still LIVE or queued for finalize. */
  const PROCESSING: FramesInfo = {
    url: null,
    count: 0,
    startedAt: 0,
    fileFormat: "jpeg",
    pending: true,
  };
  const PROCESSING_TITLE = "This session is still being processed.";
  const PROCESSING_BODY = "Please check it again in a few minutes.";
  const text = () => view?.container.textContent ?? "";
  /** The painted frame's src, or null when the stage shows no frame. */
  const frameSrc = () =>
    view?.container.querySelector("img")?.getAttribute("src") ?? null;

  test("no archive URL while pending: the reference processing state", async () => {
    await renderPlayer([], { framesInfo: PROCESSING });
    const title = view!.container.querySelector(".rv-mob-empty-title");
    expect(title?.textContent).toBe(PROCESSING_TITLE);
    expect(text()).toContain(PROCESSING_BODY);
    expect(text()).not.toContain("No snapshots captured");
    expect(text()).not.toContain("Loading frames");
    expect(loadFramesArchive).not.toHaveBeenCalled();
  });

  test("while processing there is nothing to play: no length, no clock, no idle bands", async () => {
    // The reference shows its processing panel INSTEAD of a player. The host
    // hides its HUD, but still hands down `playing` (Recordings opens every
    // session playing), so the clock must not run under the panel: a
    // published length lets it run to the end, and RvStage then reports
    // "ended" and auto-advances off a session the user was told to check
    // again.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 200));
    const onDuration = vi.fn();
    const onIdleRegions = vi.fn();
    await renderPlayer([], {
      framesInfo: PROCESSING,
      playing: true,
      sessionDurationMs: 2_000,
      onDuration,
      onIdleRegions,
    });
    await advanceFrames(20);
    expect(text()).toContain(PROCESSING_TITLE);
    expect(onDuration).not.toHaveBeenCalled();
    expect(ref.current!.getCurrentTime()).toBe(0);
    // Nothing frameless is painted on the scrubber for a session not yet built.
    for (const [regions] of onIdleRegions.mock.calls) expect(regions).toEqual([]);
  });

  test("a pending session with legacy snapshots still paints and plays them", async () => {
    // Only the empty processing panel stops the clock: a legacy session's
    // per-event snapshots are something to watch while the archive is built.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 200));
    const onDuration = vi.fn();
    await renderPlayer([], {
      framesInfo: PROCESSING,
      playing: true,
      sessionDurationMs: 60_000,
      onDuration,
      batches: [
        {
          events: [
            {
              type: "native_snapshot",
              ts: 1_760_000_000_000,
              data: {
                width: 390,
                height: 844,
                root: { imageRef: "https://img.example/1.jpg", bounds: { x: 0, y: 0, w: 390, h: 844 } },
              },
            },
          ],
        },
      ],
    });
    await advanceFrames(5);
    expect(frameSrc()).toBe("https://img.example/1.jpg");
    expect(text()).not.toContain(PROCESSING_TITLE);
    expect(onDuration).toHaveBeenLastCalledWith(60);
    expect(ref.current!.getCurrentTime()).toBeGreaterThan(0);
  });

  test("no archive URL and not pending: the existing no-snapshots state", async () => {
    await renderPlayer([], { framesInfo: { ...PROCESSING, pending: false } });
    const title = view!.container.querySelector(".rv-mob-empty-title");
    expect(title?.textContent).toBe("No snapshots captured");
    expect(text()).toContain("Snapshot capture may be disabled");
    expect(text()).not.toContain(PROCESSING_TITLE);
  });

  test("an API without the flag reads as not pending", async () => {
    const legacy: FramesInfo = {
      url: null,
      count: 0,
      startedAt: 0,
      fileFormat: "jpeg",
    };
    await renderPlayer([], { framesInfo: legacy });
    expect(text()).toContain("No snapshots captured");
    expect(text()).not.toContain(PROCESSING_TITLE);
  });

  test("an archive URL plays the frames, pending or not", async () => {
    await renderPlayer(EARLY, { framesInfo: { ...FRAMES_INFO, pending: true } });
    expect(frameSrc()).toBe("blob:f500");
    expect(view!.container.querySelector(".rv-mob-empty-title")).toBeNull();
    expect(text()).not.toContain(PROCESSING_TITLE);
  });

  test("an archive that appears on a refetch loads, never reading as 'no snapshots'", async () => {
    // Opened while processing; the next answer (any caller that swaps the
    // descriptor without flagging a re-ask) has the finalized archive's URL.
    let finishDownload!: (frames: MobileFrame[]) => void;
    vi.mocked(loadFramesArchive).mockReturnValue(
      new Promise((resolve) => {
        finishDownload = (frames) =>
          resolve({ frames, count: frames.length } as Awaited<
            ReturnType<typeof loadFramesArchive>
          >);
      }),
    );
    let setInfo!: (info: FramesInfo) => void;
    function Harness() {
      const [info, set] = useState<FramesInfo>(PROCESSING);
      setInfo = set;
      return (
        <RvMobilePlayer
          ref={ref}
          batches={[]}
          framesInfo={info}
          playing={false}
          speed={1}
          platform="ios"
          sessionDurationMs={SESSION_MS}
        />
      );
    }
    view = await mount(<Harness />, { stage: true });
    await flush(5);
    expect(text()).toContain(PROCESSING_TITLE);

    await run(() => setInfo(FRAMES_INFO));
    // Downloading: the spinner, not a claim that nothing was captured.
    expect(text()).toContain("Loading frames");
    expect(text()).not.toContain("No snapshots captured");
    expect(text()).not.toContain(PROCESSING_TITLE);

    await act(async () => finishDownload(archiveFrames(EARLY)));
    await flush(5);
    await flush(5);
    expect(frameSrc()).toBe("blob:f500");
    expect(text()).not.toContain("Loading frames");
  });

  test("tells the host while the processing panel stands in for the player, and when it stops", async () => {
    // The host (RvStage / SharePage) hides its transport for exactly as long
    // as the panel shows — the reference shows the panel INSTEAD of a player.
    vi.mocked(loadFramesArchive).mockResolvedValue({
      frames: archiveFrames(EARLY),
    } as Awaited<ReturnType<typeof loadFramesArchive>>);
    const onProcessing = vi.fn();
    let setInfo!: (info: FramesInfo) => void;
    function Harness() {
      const [info, set] = useState<FramesInfo>(PROCESSING);
      setInfo = set;
      return (
        <RvMobilePlayer
          ref={ref}
          batches={[]}
          framesInfo={info}
          playing={false}
          speed={1}
          platform="ios"
          sessionDurationMs={SESSION_MS}
          onProcessing={onProcessing}
        />
      );
    }
    view = await mount(<Harness />, { stage: true });
    await flush(5);
    expect(onProcessing).toHaveBeenLastCalledWith(true);

    // The archive appears: the panel goes, and the host gets its HUD back.
    await run(() => setInfo(FRAMES_INFO));
    await flush(5);
    await flush(5);
    expect(frameSrc()).toBe("blob:f500");
    expect(onProcessing).toHaveBeenLastCalledWith(false);
  });

  test("never claims the panel for a frameless or a still-playable session, and withdraws it on unmount", async () => {
    const onProcessing = vi.fn();
    // Frameless, not pending: "No snapshots captured" keeps the transport.
    await renderPlayer([], {
      framesInfo: { ...PROCESSING, pending: false },
      onProcessing,
    });
    expect(text()).toContain("No snapshots captured");
    view!.unmount();
    // Pending with an archive URL: frames play.
    await renderPlayer(EARLY, {
      framesInfo: { ...FRAMES_INFO, pending: true },
      onProcessing,
    });
    expect(frameSrc()).toBe("blob:f500");
    view!.unmount();
    expect(onProcessing).not.toHaveBeenCalledWith(true);

    // A panel the host was told about is withdrawn when the player goes (a
    // session switch remounts it), so the next session starts with a HUD.
    await renderPlayer([], { framesInfo: PROCESSING, onProcessing });
    expect(onProcessing).toHaveBeenLastCalledWith(true);
    view!.unmount();
    view = null;
    expect(onProcessing).toHaveBeenLastCalledWith(false);
  });
});

describe("an archive that cannot be loaded", () => {
  const DAY_MS = 86_400_000;
  const PROCESSING_TITLE = "This session is still being processed.";
  const PROCESSING_BODY = "Please check it again in a few minutes.";
  const NOT_FOUND_TITLE = "Session not found.";
  const NOT_FOUND_BODY = "Please check your data retention policy.";
  const text = () => view?.container.textContent ?? "";
  const title = () =>
    view?.container.querySelector(".rv-mob-empty-title")?.textContent ?? null;
  const frameSrc = () =>
    view?.container.querySelector("img")?.getAttribute("src") ?? null;

  /** Run the REAL loader against a stubbed fetch answering `status` with
   *  `body` (no Worker here, so it takes its main-thread path). A 404 is what
   *  a retention-pruned archive answers: /frames still hands out its URL. */
  async function archiveAnswers(status: number, body: BodyInit | null = null) {
    const actual =
      await vi.importActual<typeof import("./mobileFrames")>("./mobileFrames");
    const fetchMock = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Worker", undefined);
    vi.mocked(loadFramesArchive).mockImplementation(actual.loadFramesArchive);
    return fetchMock;
  }

  /** Open a session whose archive URL answers 404. `startedAt` is the
   *  session's own start (server clock); the descriptor's (device clock)
   *  matches it unless `framesInfo` says otherwise. */
  async function open404(startedAt: number, props: Props = {}) {
    const fetchMock = await archiveAnswers(404);
    view = await mount(
      <RvMobilePlayer
        ref={ref}
        batches={[]}
        framesInfo={{ ...FRAMES_INFO, startedAt }}
        playing={false}
        speed={1}
        platform="ios"
        sessionDurationMs={SESSION_MS}
        sessionStartedAtMs={startedAt}
        {...props}
      />,
      { stage: true },
    );
    await flush(5);
    await flush(5);
    return fetchMock;
  }

  test("a 404 on a session that started just now: still being processed", async () => {
    const fetchMock = await open404(Date.now());
    expect(fetchMock).toHaveBeenCalledWith(FRAMES_INFO.url);
    expect(title()).toBe(PROCESSING_TITLE);
    expect(text()).toContain(PROCESSING_BODY);
    expect(text()).not.toContain("No snapshots captured");
    expect(text()).not.toContain("Loading frames");
  });

  test("a 404 on a session 10 days old: not found, check the retention policy", async () => {
    // The descriptor carries no `pending` field — today's deployed /frames —
    // and still names the pruned archive's URL.
    await open404(Date.now() - 10 * DAY_MS);
    expect(title()).toBe(NOT_FOUND_TITLE);
    expect(text()).toContain(NOT_FOUND_BODY);
    expect(text()).not.toContain("No snapshots captured");
    expect(text()).not.toContain(PROCESSING_TITLE);
  });

  test("the age is rounded to whole days, so the switch is at 2.5 days", async () => {
    await open404(Date.now() - 2.4 * DAY_MS);
    expect(title()).toBe(PROCESSING_TITLE);
    view!.unmount();
    await open404(Date.now() - 2.6 * DAY_MS);
    expect(title()).toBe(NOT_FOUND_TITLE);
  });

  test("dated by the session's own start, not the device clock's", async () => {
    // A device whose clock ran 10 days behind: the descriptor's start (on
    // that clock) reads old, the session's server-side start does not.
    const now = Date.now();
    await open404(now, {
      framesInfo: { ...FRAMES_INFO, startedAt: now - 10 * DAY_MS },
    });
    expect(title()).toBe(PROCESSING_TITLE);
    view!.unmount();
    // Without the session's start, the descriptor's is all there is.
    await open404(now - 10 * DAY_MS, { sessionStartedAtMs: undefined });
    expect(title()).toBe(NOT_FOUND_TITLE);
  });

  test("stands in for the player: no length, no clock, no idle bands, and asked once", async () => {
    // Recordings opens every session playing; a clock under the panel would
    // run to the end and auto-advance off a session the user was told to
    // check again. Nothing re-asks the archive: no retry, no polling.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 200));
    const onDuration = vi.fn();
    const onIdleRegions = vi.fn();
    const onProcessing = vi.fn();
    const fetchMock = await open404(Date.now(), {
      playing: true,
      sessionDurationMs: 2_000,
      onDuration,
      onIdleRegions,
      onProcessing,
    });
    await advanceFrames(20);
    await flush(5);
    expect(title()).toBe(PROCESSING_TITLE);
    expect(onDuration).not.toHaveBeenCalled();
    expect(ref.current!.getCurrentTime()).toBe(0);
    for (const [regions] of onIdleRegions.mock.calls) expect(regions).toEqual([]);
    // The host hides its transport while the panel is up...
    expect(onProcessing).toHaveBeenLastCalledWith(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // ...and gets it back when the player goes.
    view!.unmount();
    view = null;
    expect(onProcessing).toHaveBeenLastCalledWith(false);
  });

  test("an archive that parses to zero frames: no snapshots captured", async () => {
    // Loaded fine, nothing in it — that IS "nothing was captured".
    await archiveAnswers(200, new Uint8Array(0));
    const onProcessing = vi.fn();
    view = await mount(
      <RvMobilePlayer
        ref={ref}
        batches={[]}
        framesInfo={{ ...FRAMES_INFO, startedAt: Date.now() }}
        playing={false}
        speed={1}
        platform="ios"
        sessionDurationMs={SESSION_MS}
        sessionStartedAtMs={Date.now()}
        onProcessing={onProcessing}
      />,
      { stage: true },
    );
    await flush(5);
    await flush(5);
    expect(title()).toBe("No snapshots captured");
    expect(text()).not.toContain(PROCESSING_TITLE);
    expect(text()).not.toContain(NOT_FOUND_TITLE);
    expect(onProcessing).not.toHaveBeenCalled();
  });

  test("a failure while legacy snapshots exist: they play, and no panel shows", async () => {
    const onDuration = vi.fn();
    await open404(Date.now() - 10 * DAY_MS, {
      onDuration,
      batches: [
        {
          events: [
            {
              type: "native_snapshot",
              ts: 1_760_000_000_000,
              data: {
                width: 390,
                height: 844,
                root: { imageRef: "https://img.example/1.jpg", bounds: { x: 0, y: 0, w: 390, h: 844 } },
              },
            },
          ],
        },
      ],
    });
    expect(frameSrc()).toBe("https://img.example/1.jpg");
    expect(view!.container.querySelector(".rv-mob-empty-title")).toBeNull();
    expect(onDuration).toHaveBeenLastCalledWith(SESSION_MS / 1000);
  });

  test("the old server's no-archive answer keeps 'No snapshots captured'", async () => {
    // What a /frames that predates `pending` answers for a session with no
    // archive: nothing to load, so nothing failed.
    await renderPlayer([], {
      framesInfo: { url: null, count: 0, startedAt: 0, fileFormat: "png" },
    });
    expect(title()).toBe("No snapshots captured");
    expect(text()).not.toContain(PROCESSING_TITLE);
    expect(text()).not.toContain(NOT_FOUND_TITLE);
    expect(loadFramesArchive).not.toHaveBeenCalled();
  });

  test("a new archive URL after a failed one shows the spinner while it downloads, then plays", async () => {
    await archiveAnswers(404);
    let setInfo!: (info: FramesInfo) => void;
    function Harness() {
      const [info, set] = useState<FramesInfo>({
        ...FRAMES_INFO,
        startedAt: Date.now(),
      });
      setInfo = set;
      return (
        <RvMobilePlayer
          ref={ref}
          batches={[]}
          framesInfo={info}
          playing={false}
          speed={1}
          platform="ios"
          sessionDurationMs={SESSION_MS}
          sessionStartedAtMs={Date.now()}
        />
      );
    }
    view = await mount(<Harness />, { stage: true });
    await flush(5);
    await flush(5);
    expect(title()).toBe(PROCESSING_TITLE);

    // A re-finalized archive: same object, a new ?v=.
    let finishDownload!: (frames: MobileFrame[]) => void;
    vi.mocked(loadFramesArchive).mockReturnValue(
      new Promise((resolve) => {
        finishDownload = (frames) =>
          resolve({ frames, count: frames.length } as Awaited<
            ReturnType<typeof loadFramesArchive>
          >);
      }),
    );
    await run(() => setInfo({ ...FRAMES_INFO, url: `${FRAMES_INFO.url}?v=2` }));
    expect(text()).toContain("Loading frames");
    expect(text()).not.toContain(PROCESSING_TITLE);

    await act(async () => finishDownload(archiveFrames(EARLY)));
    await flush(5);
    await flush(5);
    expect(frameSrc()).toBe("blob:f500");
    expect(view!.container.querySelector(".rv-mob-empty-title")).toBeNull();
  });

  /** Open a session whose archive download answers 200 with `body`. */
  async function open200(body: BodyInit, framesInfo: Partial<FramesInfo> = {}) {
    const fetchMock = await archiveAnswers(200, body);
    view = await mount(
      <RvMobilePlayer
        ref={ref}
        batches={[]}
        framesInfo={{ ...FRAMES_INFO, startedAt: Date.now(), ...framesInfo }}
        playing={false}
        speed={1}
        platform="ios"
        sessionDurationMs={SESSION_MS}
        sessionStartedAtMs={Date.now()}
      />,
      { stage: true },
    );
    await flush(5);
    await flush(5);
    return fetchMock;
  }

  /** One `[uint64 LE ts][uint32 LE size][bytes]` record of a frames archive;
   *  `size` defaults to the bytes' length (a larger one runs past the end). */
  function record(ts: number, bytes: number[], size = bytes.length): number[] {
    const head = new DataView(new ArrayBuffer(12));
    head.setUint32(0, ts % 0x100000000, true);
    head.setUint32(4, Math.floor(ts / 0x100000000), true);
    head.setUint32(8, size, true);
    return [...new Uint8Array(head.buffer), ...bytes];
  }

  test("a 200 whose body is not an archive (an error page): the load-error copy", async () => {
    // A proxy or CDN answering a missing key with its own page: nothing in it
    // parses as a frame, which is a failed load, not "nothing captured".
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await open200("<html><body>NoSuchKey</body></html>");
    expect(title()).toBe(PROCESSING_TITLE);
    expect(text()).not.toContain("No snapshots captured");
  });

  test("an empty archive where the descriptor counts frames: the load-error copy", async () => {
    // The server names an archive only once it holds `count` frames, so an
    // empty body (a partial upload) contradicts it: a failed load.
    await open200(new Uint8Array(0), { count: 83 });
    expect(title()).toBe(PROCESSING_TITLE);
    expect(text()).not.toContain("No snapshots captured");
  });

  test("a truncated archive plays the frames before the cut", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cut");
    const start = Date.now();
    const bytes = new Uint8Array([
      ...record(start + 500, [0xff, 0xd8, 0xff]),
      // The next record claims 1000 bytes and the body stops after 2.
      ...record(start + 750, [0xff, 0xd8], 1000),
    ]);
    await open200(bytes, { startedAt: start, count: 2 });
    expect(frameSrc()).toBe("blob:cut");
    expect(view!.container.querySelector(".rv-mob-empty-title")).toBeNull();
  });

  test("a failed /frames request: the load-error copy, not 'No snapshots captured'", async () => {
    // No descriptor at all (its retry spent): nothing says the session has no
    // archive, so it is a failed load, standing in for the player.
    const onProcessing = vi.fn();
    view = await mount(
      <RvMobilePlayer
        ref={ref}
        batches={[]}
        framesInfo={undefined}
        framesFailed
        playing={false}
        speed={1}
        platform="ios"
        sessionDurationMs={SESSION_MS}
        sessionStartedAtMs={Date.now() - 10 * DAY_MS}
        onProcessing={onProcessing}
      />,
      { stage: true },
    );
    await flush(5);
    await flush(5);
    expect(title()).toBe(NOT_FOUND_TITLE);
    expect(text()).toContain(NOT_FOUND_BODY);
    expect(text()).not.toContain("No snapshots captured");
    expect(onProcessing).toHaveBeenLastCalledWith(true);
    expect(loadFramesArchive).not.toHaveBeenCalled();
  });

  test("a re-load that fails keeps the archive that is playing", async () => {
    // A re-finalized archive (a new ?v=) whose download fails while the user
    // watches the old one: the frames stay, no panel replaces them.
    let setInfo!: (info: FramesInfo) => void;
    const onProcessing = vi.fn();
    function Harness() {
      const [info, set] = useState<FramesInfo>(FRAMES_INFO);
      setInfo = set;
      return (
        <RvMobilePlayer
          ref={ref}
          batches={[]}
          framesInfo={info}
          playing={false}
          speed={1}
          platform="ios"
          sessionDurationMs={SESSION_MS}
          sessionStartedAtMs={Date.now()}
          onProcessing={onProcessing}
        />
      );
    }
    vi.mocked(loadFramesArchive).mockResolvedValue({
      frames: archiveFrames(EARLY),
    } as Awaited<ReturnType<typeof loadFramesArchive>>);
    view = await mount(<Harness />, { stage: true });
    await flush(5);
    await flush(5);
    expect(frameSrc()).toBe("blob:f500");

    vi.mocked(loadFramesArchive).mockResolvedValue(null);
    await run(() => setInfo({ ...FRAMES_INFO, url: `${FRAMES_INFO.url}?v=2` }));
    await flush(5);
    expect(loadFramesArchive).toHaveBeenCalledTimes(2);
    expect(frameSrc()).toBe("blob:f500");
    expect(view!.container.querySelector(".rv-mob-empty-title")).toBeNull();
    expect(text()).not.toContain("Loading frames");
    expect(onProcessing).not.toHaveBeenCalledWith(true);
  });

  test("batches landing after a failure do not download the archive again", async () => {
    // They move the effect's `startTs`; a second download there would be a
    // retry, which the reference tracker never makes.
    const fetchMock = await archiveAnswers(404);
    let setBatches!: (b: ReplayBatch[]) => void;
    function Harness() {
      const [batches, set] = useState<ReplayBatch[]>([]);
      setBatches = set;
      return (
        <RvMobilePlayer
          ref={ref}
          batches={batches}
          framesInfo={{ ...FRAMES_INFO, startedAt: 0 }}
          playing={false}
          speed={1}
          platform="ios"
          sessionDurationMs={SESSION_MS}
          sessionStartedAtMs={Date.now()}
        />
      );
    }
    view = await mount(<Harness />, { stage: true });
    await flush(5);
    await flush(5);
    expect(title()).toBe(PROCESSING_TITLE);

    await run(() =>
      setBatches([{ events: [{ type: "tap", ts: Date.now(), data: {} }] }]),
    );
    await flush(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(title()).toBe(PROCESSING_TITLE);
  });
});
