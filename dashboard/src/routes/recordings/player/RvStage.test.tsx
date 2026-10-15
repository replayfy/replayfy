/* Wiring test for a mobile recording on the dashboard (`yarn test`): RvStage →
   RvPlayer → RvMobilePlayer, real components end to end. Only the network is
   mocked — the /events, /frames and /timeline endpoints and the frames-archive
   download — so this checks the session's own length reaches the player and
   the player's skip ranges reach the scrubber. Fixture: the 6:27 session whose
   frames stop at 0:21. Then the /frames `pending` flag: the processing state
   (standing in for the whole player, with nothing playing under it), and a
   reopen — remounted, or selected again on the mounted stage — re-asking
   instead of serving a cached "not ready yet": once per open, never on focus
   or a timer. A failed ask is not a pending answer: focus still re-asks it.
   Last, an archive that cannot be loaded: the reference load-error copy,
   dated by the session's own start, standing in for the player. */
import { act, createRef, useState } from "react";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RvStage } from "./RvStage";
import { loadFramesArchive } from "./mobileFrames";
import type { FramesInfo, MobileFrame } from "./playerTypes";
import { Sessions } from "@/api/endpoints";
import { queryClient as appQueryClient } from "@/api/queryClient";
import type { RvSession } from "../recordings.data";
import {
  advanceFrames,
  flush,
  mount,
  resetPlayerEnvironment,
  stubPlayerEnvironment,
  type Mounted,
} from "@/test/dom";

vi.mock("./mobileFrames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mobileFrames")>()),
  loadFramesArchive: vi.fn(),
}));
vi.mock("@/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/endpoints")>()),
  Sessions: {
    events: async () => [],
    frames: vi.fn(async () => ({
      url: "https://frames.example/archive.gz",
      count: 83,
      startedAt: 1_760_000_000_000,
      fileFormat: "jpeg",
    })),
    timeline: async () => ({ events: [] }),
  },
}));

const SESSION_MS = 387_000; // 6:27
const LAST_FRAME_MS = 21_000;

const session = {
  id: "ses_mobile_627",
  name: "Ada",
  sub: null,
  initials: "A",
  picture: null,
  hueSeed: "ada",
  plan: null,
  live: false,
  st: "",
  plat: "ios",
  os: "iOS 18",
  flag: "",
  loc: "",
  dur: "6:27",
  durationMs: SESSION_MS,
  errs: 0,
  rage: 0,
  net: 0,
  when: "",
  url: "",
} satisfies RvSession;

let view: Mounted | null = null;

beforeEach(() => {
  stubPlayerEnvironment();
  localStorage.removeItem("rv:skipIdle");
  vi.mocked(loadFramesArchive).mockResolvedValue({
    frames: Array.from(
      { length: 83 },
      (_, i): MobileFrame => ({ time: 500 + i * 250, getBlobUrl: () => "blob:f" }),
    ),
  } as Awaited<ReturnType<typeof loadFramesArchive>>);
});
afterEach(() => {
  view?.unmount();
  view = null;
  resetPlayerEnvironment();
});

/** Select another session the way Recordings does: RvStage (and RvPlayer)
 *  stay mounted and only `s` changes. Set by StageHarness as it renders. */
let selectSession: (s: RvSession) => void = () => {};

function StageHarness({
  client,
  initial,
  onRealDuration,
  playing,
  onEnded,
}: {
  client: QueryClient;
  initial: RvSession;
  onRealDuration: (sec: number) => void;
  playing: boolean;
  onEnded?: () => void;
}) {
  const [s, setS] = useState(initial);
  selectSession = setS;
  const noop = () => {};
  return (
    <QueryClientProvider client={client}>
      <RvStage
        s={s}
        idx={0}
        sessions={[s]}
        isMobile
        theatre={false}
        setTheatre={noop}
        annotate={false}
        setAnnotate={noop}
        pos={0}
        setPos={noop}
        playing={playing}
        setPlaying={noop}
        speed={1}
        setSpeed={noop}
        speedOpen={false}
        setSpeedOpen={noop}
        bookmarks={[]}
        scrubRef={createRef()}
        onScrubDown={noop}
        fmtT={() => "0:00"}
        durSec={(s.durationMs ?? 0) / 1000}
        ticks={[]}
        onEnded={onEnded}
        onRealDuration={onRealDuration}
        addBookmark={noop}
        setCur={noop}
        setShareOpen={noop}
      />
    </QueryClientProvider>
  );
}

/** Open the session on the dashboard stage. `playing` is what Recordings sets
 *  on every session select; `onEnded` is its autoplay-next hook. */
async function openStage(
  client: QueryClient,
  onRealDuration: (sec: number) => void = () => {},
  opts: { s?: RvSession; playing?: boolean; onEnded?: () => void } = {},
): Promise<Mounted> {
  const mounted = await mount(
    <StageHarness
      client={client}
      initial={opts.s ?? session}
      onRealDuration={onRealDuration}
      playing={opts.playing ?? false}
      onEnded={opts.onEnded}
    />,
  );
  view = mounted;
  for (let i = 0; i < 4; i++) await flush(5);
  return mounted;
}

test("a mobile recording plays to the session's end, with its skippable stretch on the scrubber", async () => {
  const onRealDuration = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  view = await openStage(client, onRealDuration);

  // The player's real length is the session's 6:27, not the last frame's 0:21.
  expect(onRealDuration).toHaveBeenLastCalledWith(SESSION_MS / 1000);

  // The frameless tail after 0:21 is painted as a skippable band...
  const bands = view.container.querySelectorAll<HTMLElement>(".rv-scrub-idle");
  expect(bands).toHaveLength(1);
  expect(parseFloat(bands[0].style.left)).toBeCloseTo((LAST_FRAME_MS / SESSION_MS) * 100, 5);
  expect(parseFloat(bands[0].style.width)).toBeCloseTo((1 - LAST_FRAME_MS / SESSION_MS) * 100, 5);
  // ...and the Skip inactivity control is offered for mobile too.
  expect(
    view.container.querySelector('button[aria-pressed][data-tip^="Skip inactivity"]'),
  ).not.toBeNull();
});

describe("frames still being processed", () => {
  const ARCHIVE: FramesInfo = {
    url: "https://frames.example/archive.gz",
    count: 83,
    startedAt: 1_760_000_000_000,
    fileFormat: "jpeg",
  };
  /** What /frames answers while the session is LIVE or queued for finalize. */
  const PENDING: FramesInfo = {
    url: null,
    count: 0,
    startedAt: 0,
    fileFormat: "png",
    pending: true,
  };
  const PROCESSING_TITLE = "This session is still being processed.";
  /** Make /frames answer `info` — the body bare, as the mocked endpoint
   *  returns it (the client unwraps either shape). */
  const answerFrames = (info: FramesInfo) =>
    vi.mocked(Sessions.frames).mockImplementation(
      (async () => info) as unknown as typeof Sessions.frames,
    );
  const text = () => view?.container.textContent ?? "";
  const frameSrc = () =>
    view?.container.querySelector(".rv-screen img")?.getAttribute("src") ?? null;
  /** The HUD (scrubber + transport) is hidden from the viewer. */
  const hudHidden = () =>
    view?.container.querySelector<HTMLElement>(".rv-hud")?.style.display ===
    "none";
  /** A client with the app's own query defaults (30 s staleTime, 7-day
   *  gcTime) — what decides whether a reopen is served from cache. */
  const appClient = () =>
    new QueryClient({
      defaultOptions: {
        queries: { ...appQueryClient.getDefaultOptions().queries, retry: false },
      },
    });
  const reopen = async (client: QueryClient) => {
    view!.unmount();
    view = null;
    return openStage(client);
  };

  test("shows the reference processing copy, from one /frames request and no polling", async () => {
    answerFrames(PENDING);
    const client = appClient();
    await openStage(client);
    expect(view!.container.querySelector(".rv-mob-empty-title")?.textContent).toBe(
      PROCESSING_TITLE,
    );
    expect(text()).toContain("Please check it again in a few minutes.");
    expect(text()).not.toContain("No snapshots captured");
    expect(Sessions.frames).toHaveBeenCalledTimes(1);
    // Nothing re-asks on a timer: no observer of any query polls.
    const polling = client
      .getQueryCache()
      .getAll()
      .flatMap((q) => q.observers)
      .filter((o) => o.options.refetchInterval);
    expect(polling).toHaveLength(0);
    client.clear();
  });

  test("a reopen re-asks, and plays the archive once it is finalized", async () => {
    answerFrames(PENDING);
    const client = appClient();
    await openStage(client);
    expect(text()).toContain(PROCESSING_TITLE);

    // Finalize lands; the user opens the session again well inside the
    // client's 30 s staleTime.
    answerFrames(ARCHIVE);
    await reopen(client);
    for (let i = 0; i < 2; i++) await flush(5);
    expect(Sessions.frames).toHaveBeenCalledTimes(2);
    expect(frameSrc()).toBe("blob:f");
    expect(text()).not.toContain(PROCESSING_TITLE);
    expect(text()).not.toContain("No snapshots captured");
    client.clear();
  });

  test("a session still being processed never plays to its end or auto-advances", async () => {
    // Recordings opens every session playing, and its onEnded moves on to the
    // next recording. A clock running under the processing panel reached the
    // end and did exactly that.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 200));
    answerFrames(PENDING);
    const onEnded = vi.fn();
    const onRealDuration = vi.fn();
    const client = appClient();
    await openStage(client, onRealDuration, {
      s: { ...session, durationMs: 2_000, dur: "0:02" },
      playing: true,
      onEnded,
    });
    await advanceFrames(30);
    expect(text()).toContain(PROCESSING_TITLE);
    expect(onRealDuration).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
    expect(view!.container.querySelectorAll(".rv-scrub-idle")).toHaveLength(0);
    client.clear();
  });

  test("a reopen shows the spinner, not the cached processing copy, while it re-asks", async () => {
    answerFrames(PENDING);
    const client = appClient();
    await openStage(client);
    expect(text()).toContain(PROCESSING_TITLE);

    // Reopen with the re-ask held in flight: the cached "not ready yet" is
    // being re-checked, so it must not be shown as the answer.
    let answer!: (info: FramesInfo) => void;
    vi.mocked(Sessions.frames).mockImplementation((() =>
      new Promise<FramesInfo>((resolve) => {
        answer = resolve;
      })) as unknown as typeof Sessions.frames);
    const onRealDuration = vi.fn();
    view!.unmount();
    view = null;
    await openStage(client, onRealDuration, { playing: true });
    expect(Sessions.frames).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Loading frames");
    expect(text()).not.toContain(PROCESSING_TITLE);
    expect(onRealDuration).not.toHaveBeenCalled();

    await act(async () => answer(ARCHIVE));
    for (let i = 0; i < 3; i++) await flush(5);
    expect(frameSrc()).toBe("blob:f");
    expect(text()).not.toContain("Loading frames");
    expect(onRealDuration).toHaveBeenLastCalledWith(SESSION_MS / 1000);
    client.clear();
  });

  test("returning to the tab or reconnecting does not re-ask", async () => {
    // One request per open, as the reference: the body copy asks the user to
    // check again, which is a reopen.
    answerFrames(PENDING);
    const client = appClient();
    await openStage(client);
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });
      await flush(5);
    }
    expect(Sessions.frames).toHaveBeenCalledTimes(1);
    expect(text()).toContain(PROCESSING_TITLE);
    focusManager.setFocused(undefined);
    client.clear();
  });

  test("a final answer is still served from cache on reopen", async () => {
    // Not pending: no archive will ever come, so the default staleTime holds.
    answerFrames({ ...PENDING, pending: false });
    const client = appClient();
    await openStage(client);
    expect(text()).toContain("No snapshots captured");
    await reopen(client);
    expect(Sessions.frames).toHaveBeenCalledTimes(1);
    expect(text()).toContain("No snapshots captured");
    // A session that is simply frameless keeps its transport.
    expect(hudHidden()).toBe(false);
    client.clear();
  });

  test("the processing panel stands in for the whole player: no transport under it", async () => {
    // The reference shows the panel INSTEAD of the player, controls and all.
    // Here the scrubber and play/pause stayed live over a stage with nothing
    // to play: Recordings opens every session playing (a pause icon over a
    // still panel), and a scrub moved the head and the time label while the
    // stage stayed at 0:00.
    answerFrames(PENDING);
    const client = appClient();
    await openStage(client, () => {}, { playing: true });
    expect(text()).toContain(PROCESSING_TITLE);
    expect(hudHidden()).toBe(true);
    client.clear();
  });

  test("a failed ask is re-asked when the tab regains focus", async () => {
    // Only a PENDING answer is held to one ask per open. A request that failed
    // (its retry spent) holds no answer at all, so the client default re-asks
    // it on focus — a transient 502 used to leave "No snapshots captured" up
    // until the user switched sessions or reloaded.
    vi.mocked(Sessions.frames)
      .mockImplementationOnce((async () => {
        throw new Error("502 Bad Gateway");
      }) as unknown as typeof Sessions.frames)
      .mockImplementation((async () => ARCHIVE) as unknown as typeof Sessions.frames);
    const client = appClient();
    await openStage(client, () => {}, {
      s: { ...session, startedAtMs: Date.now() },
    });
    // No answer is not "nothing captured": the load-error copy, dated by the
    // session's start (just now), standing in for the player.
    expect(view!.container.querySelector(".rv-mob-empty-title")?.textContent).toBe(
      PROCESSING_TITLE,
    );
    expect(text()).not.toContain("No snapshots captured");
    expect(hudHidden()).toBe(true);
    expect(loadFramesArchive).not.toHaveBeenCalled();

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    for (let i = 0; i < 3; i++) await flush(5);
    expect(Sessions.frames).toHaveBeenCalledTimes(2);
    expect(frameSrc()).toBe("blob:f");
    expect(text()).not.toContain("No snapshots captured");
    expect(text()).not.toContain(PROCESSING_TITLE);
    expect(hudHidden()).toBe(false);
    focusManager.setFocused(undefined);
    client.clear();
  });

  test("selecting another session and back (stage kept mounted) re-asks the pending one", async () => {
    // What Recordings actually does: RvStage and RvPlayer stay mounted and the
    // selected session changes, so going back to A is a query-key change on a
    // live observer — not the unmount + remount the reopen tests above use.
    const A: RvSession = { ...session, id: "ses_A" };
    const B: RvSession = { ...session, id: "ses_B" };
    const answers: Record<string, FramesInfo | Promise<FramesInfo>> = {
      ses_A: PENDING,
      ses_B: ARCHIVE,
    };
    vi.mocked(Sessions.frames).mockImplementation((async (id: string) =>
      answers[id]) as unknown as typeof Sessions.frames);
    const askedFor = () => vi.mocked(Sessions.frames).mock.calls.map(([id]) => id);
    const client = appClient();
    await openStage(client, () => {}, { s: A });
    expect(text()).toContain(PROCESSING_TITLE);
    expect(hudHidden()).toBe(true);

    await act(async () => selectSession(B));
    for (let i = 0; i < 3; i++) await flush(5);
    expect(askedFor()).toEqual(["ses_A", "ses_B"]);
    expect(frameSrc()).toBe("blob:f");
    expect(text()).not.toContain(PROCESSING_TITLE);
    expect(hudHidden()).toBe(false);

    // A is finalized meanwhile. Back to it well inside the 30 s staleTime,
    // with the re-ask held in flight so the first render back is checked.
    let answerA!: (info: FramesInfo) => void;
    answers.ses_A = new Promise<FramesInfo>((resolve) => {
      answerA = resolve;
    });
    await act(async () => selectSession(A));
    await flush(5);
    expect(askedFor()).toEqual(["ses_A", "ses_B", "ses_A"]);
    expect(text()).toContain("Loading frames");
    expect(text()).not.toContain(PROCESSING_TITLE);

    await act(async () => answerA(ARCHIVE));
    for (let i = 0; i < 3; i++) await flush(5);
    expect(frameSrc()).toBe("blob:f");
    expect(text()).not.toContain(PROCESSING_TITLE);
    expect(text()).not.toContain("Loading frames");
    expect(hudHidden()).toBe(false);
    client.clear();
  });
});

describe("an archive that cannot be loaded", () => {
  const text = () => view?.container.textContent ?? "";
  const hudHidden = () =>
    view?.container.querySelector<HTMLElement>(".rv-hud")?.style.display ===
    "none";

  test("is dated by the session's own start, and stands in for the whole player", async () => {
    // The download fails (a retention-pruned archive 404s). The descriptor's
    // start is on the device clock and a year old; the session started just
    // now — the reference tracker dates its copy by the session's start.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 200));
    vi.mocked(loadFramesArchive).mockResolvedValue(null);
    const onEnded = vi.fn();
    const onRealDuration = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await openStage(client, onRealDuration, {
      s: { ...session, durationMs: 2_000, dur: "0:02", startedAtMs: Date.now() },
      playing: true,
      onEnded,
    });
    await advanceFrames(30);
    expect(view!.container.querySelector(".rv-mob-empty-title")?.textContent).toBe(
      "This session is still being processed.",
    );
    expect(text()).toContain("Please check it again in a few minutes.");
    expect(text()).not.toContain("No snapshots captured");
    // Nothing to play under it: no transport, no clock to reach the end and
    // auto-advance to the next recording, and the archive is asked for once.
    expect(hudHidden()).toBe(true);
    expect(onRealDuration).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
    expect(loadFramesArchive).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
