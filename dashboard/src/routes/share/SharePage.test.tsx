/* Wiring test for a shared mobile recording (`yarn test`): the public /s/:token
   page with the real share-data hook and the real mobile player. Only the
   network is mocked — the unauthenticated Share.* endpoints and the frames
   archive download. Fixture: the 6:27 session whose frames stop at 0:21,
   shared WITHOUT the Events panel — so /events answers 404, as the server
   does for a panel the sharer left off. Then the /frames `pending` flag: the
   processing state (standing in for the player, the clock idle under it), and
   a reopened link re-asking for a pending answer — once per open, never on
   focus. A failed ask is not a pending answer either: it gets the load-error
   copy, and focus / reconnect re-ask it. And an archive that cannot be
   loaded: the reference load-error copy, dated by the shared session's own
   start. */
import { act } from "react";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SharePage } from "./SharePage";
import { Share } from "@/api/endpoints";
import { queryClient as appQueryClient } from "@/api/queryClient";
import { loadFramesArchive } from "@/routes/recordings/player/mobileFrames";
import type {
  FramesInfo,
  MobileFrame,
} from "@/routes/recordings/player/playerTypes";
import {
  advanceFrames,
  flush,
  mount,
  resetPlayerEnvironment,
  stubPlayerEnvironment,
  type Mounted,
} from "@/test/dom";

const SESSION_MS = 387_000; // 6:27
const LAST_FRAME_MS = 21_000;

vi.mock("@/routes/recordings/player/mobileFrames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/routes/recordings/player/mobileFrames")>()),
  loadFramesArchive: vi.fn(),
}));
vi.mock("@/api/health", () => ({ useBackendReachable: () => true }));
vi.mock("./SharePanels", () => ({ ShareInspector: () => null }));
vi.mock("@/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/endpoints")>()),
  Share: {
    resolve: async () => ({
      session: {
        publicId: "ses_mobile_627",
        platform: "ios",
        status: "COMPLETED",
        durationMs: 387_000,
        startedAt: "2026-10-01T10:00:00.000Z",
        endedAt: "2026-10-01T10:06:27.000Z",
      },
      // The sharer left the Events panel off.
      panels: { events: false },
    }),
    // As the server answers with the Events panel off: 404, no batches.
    events: vi.fn(async () => {
      throw new Error("404 Not Found");
    }),
    frames: vi.fn(async () => ({
      url: "https://frames.example/archive.gz",
      count: 83,
      startedAt: 1_760_000_000_000,
      fileFormat: "jpeg",
    })),
    timeline: vi.fn(async () => ({ events: [] })),
  },
}));

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

/** Open the share link /s/tok. */
async function openShare(client: QueryClient): Promise<Mounted> {
  const mounted = await mount(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/s/tok"]}>
        <Routes>
          <Route path="/s/:token" element={<SharePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  view = mounted;
  for (let i = 0; i < 6; i++) await flush(5);
  return mounted;
}

test("a shared mobile recording runs to the session's end, with its skippable stretch on the scrubber", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  view = await openShare(client);

  // The band only exists if the player ran to 6:27 (to the last frame there is
  // nothing frameless) and reported its ranges up to this page's scrubber.
  const bands = view.container.querySelectorAll<HTMLElement>(".rv-scrub-idle");
  expect(bands).toHaveLength(1);
  expect(parseFloat(bands[0].style.left)).toBeCloseTo((LAST_FRAME_MS / SESSION_MS) * 100, 5);
  expect(parseFloat(bands[0].style.width)).toBeCloseTo((1 - LAST_FRAME_MS / SESSION_MS) * 100, 5);
  expect(
    view.container.querySelector('button[aria-pressed][data-tip^="Skip inactivity"]'),
  ).not.toBeNull();
  // The sharer's choice holds: no Events panel, no /timeline read for it.
  expect(Share.timeline).not.toHaveBeenCalled();
});

test("an archive that cannot be loaded is dated by the shared session's own start", async () => {
  // The download fails (a retention-pruned archive 404s). The descriptor's
  // start is on the device clock and a year old; the session started just
  // now — the reference tracker dates its copy by the session's start.
  vi.spyOn(Share, "resolve").mockImplementation((async () => ({
    session: {
      publicId: "ses_mobile_627",
      platform: "ios",
      status: "COMPLETED",
      durationMs: 387_000,
      startedAt: new Date().toISOString(),
    },
    panels: { events: false },
  })) as unknown as typeof Share.resolve);
  vi.mocked(loadFramesArchive).mockResolvedValue(null);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  view = await openShare(client);
  // The batches never come (/events 404s without the Events panel): that
  // settles the wait, rather than holding the spinner up for good.
  expect(Share.events).toHaveBeenCalled();
  expect(view.container.textContent).not.toContain("Loading frames");
  expect(view.container.querySelector(".rv-mob-empty-title")?.textContent).toBe(
    "This session is still being processed.",
  );
  expect(view.container.textContent).not.toContain("No snapshots captured");
  // The panel stands in for the player: the HUD is hidden behind it.
  expect(
    view.container.querySelector<HTMLElement>(".rv-hud")?.style.display,
  ).toBe("none");
  client.clear();
});

describe("frames still being processed", () => {
  /** What /frames answers while the session is LIVE or queued for finalize. */
  const PENDING: FramesInfo = {
    url: null,
    count: 0,
    startedAt: 0,
    fileFormat: "jpeg",
    pending: true,
  };
  const PROCESSING_TITLE = "This session is still being processed.";
  /** Make /frames answer `info` — the body bare, as the mocked endpoint
   *  returns it (the client unwraps either shape). */
  const answerFrames = (info: FramesInfo) =>
    vi.mocked(Share.frames).mockImplementation(
      (async () => info) as unknown as typeof Share.frames,
    );
  const text = () => view?.container.textContent ?? "";
  /** The HUD (scrubber + transport) is hidden from the viewer. */
  const hudHidden = () =>
    view?.container.querySelector<HTMLElement>(".rv-hud")?.style.display ===
    "none";
  /** The app's own query defaults (30 s staleTime) decide cache reuse. */
  const appClient = () =>
    new QueryClient({
      defaultOptions: {
        queries: { ...appQueryClient.getDefaultOptions().queries, retry: false },
      },
    });

  test("the shared player shows the reference processing copy", async () => {
    answerFrames(PENDING);
    const client = appClient();
    await openShare(client);
    expect(view!.container.querySelector(".rv-mob-empty-title")?.textContent).toBe(
      PROCESSING_TITLE,
    );
    expect(text()).toContain("Please check it again in a few minutes.");
    expect(text()).not.toContain("No snapshots captured");
    expect(Share.frames).toHaveBeenCalledTimes(1);
    // The panel stands in for the whole player, as the reference's does: no
    // scrubber or play/pause over a stage with nothing to play.
    expect(hudHidden()).toBe(true);
    client.clear();
  });

  test("the clock does not run under the processing state", async () => {
    // The share page opens playing; a clock under the panel ran the playhead
    // to the end of a session that has nothing to show yet.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 200));
    answerFrames(PENDING);
    const client = appClient();
    await openShare(client);
    await advanceFrames(30);
    expect(text()).toContain(PROCESSING_TITLE);
    const head = view!.container.querySelector<HTMLElement>(".rv-scrub-head");
    expect(head?.style.left).toBe("0%");
    expect(view!.container.querySelectorAll(".rv-scrub-idle")).toHaveLength(0);
    client.clear();
  });

  test("a reopened link shows the spinner, not the cached processing copy, while it re-asks", async () => {
    answerFrames(PENDING);
    const client = appClient();
    await openShare(client);
    expect(text()).toContain(PROCESSING_TITLE);
    view!.unmount();
    view = null;

    let answer!: (info: FramesInfo) => void;
    vi.mocked(Share.frames).mockImplementation((() =>
      new Promise<FramesInfo>((resolve) => {
        answer = resolve;
      })) as unknown as typeof Share.frames);
    await openShare(client);
    expect(Share.frames).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Loading frames");
    expect(text()).not.toContain(PROCESSING_TITLE);

    // Still not finalized: back to the processing copy, not a stuck spinner.
    await act(async () => answer(PENDING));
    for (let i = 0; i < 3; i++) await flush(5);
    expect(text()).toContain(PROCESSING_TITLE);
    expect(text()).not.toContain("Loading frames");
    client.clear();
  });

  test("returning to the tab does not re-ask the public endpoint", async () => {
    answerFrames(PENDING);
    const client = appClient();
    await openShare(client);
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });
      await flush(5);
    }
    expect(Share.frames).toHaveBeenCalledTimes(1);
    expect(text()).toContain(PROCESSING_TITLE);
    focusManager.setFocused(undefined);
    client.clear();
  });

  test("a not-pending answer with no URL keeps the no-snapshots state", async () => {
    answerFrames({ ...PENDING, pending: false });
    const client = appClient();
    await openShare(client);
    expect(text()).toContain("No snapshots captured");
    expect(text()).not.toContain(PROCESSING_TITLE);
    expect(hudHidden()).toBe(false);
    client.clear();
  });

  test("a failed ask is re-asked when the tab regains focus or the network comes back", async () => {
    // Only a PENDING answer is held to one ask per open. A failed request
    // holds no answer, so the client defaults re-ask it — this page has no
    // other way back from the failure short of a reload.
    const fail = (async () => {
      throw new Error("502 Bad Gateway");
    }) as unknown as typeof Share.frames;
    vi.mocked(Share.frames)
      .mockImplementationOnce(fail)
      .mockImplementationOnce(fail)
      .mockImplementation((async () => ({
        url: "https://frames.example/archive.gz",
        count: 83,
        startedAt: 1_760_000_000_000,
        fileFormat: "jpeg",
      })) as unknown as typeof Share.frames);
    const client = appClient();
    await openShare(client);
    // No answer is not "nothing captured": the load-error copy, dated by the
    // shared session's start (2026-10-01, past 2.5 days), standing in for
    // the player.
    const loadError = () => {
      expect(view!.container.querySelector(".rv-mob-empty-title")?.textContent).toBe(
        "Session not found.",
      );
      expect(text()).toContain("Please check your data retention policy.");
      expect(text()).not.toContain("No snapshots captured");
      expect(hudHidden()).toBe(true);
    };
    loadError();

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    for (let i = 0; i < 3; i++) await flush(5);
    expect(Share.frames).toHaveBeenCalledTimes(2);
    loadError();

    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    for (let i = 0; i < 3; i++) await flush(5);
    expect(Share.frames).toHaveBeenCalledTimes(3);
    expect(
      view!.container.querySelector(".rv-screen img")?.getAttribute("src"),
    ).toBe("blob:f");
    expect(view!.container.querySelector(".rv-mob-empty-title")).toBeNull();
    expect(hudHidden()).toBe(false);
    focusManager.setFocused(undefined);
    client.clear();
  });

  test("reopening the link re-asks, and plays the finalized archive", async () => {
    answerFrames(PENDING);
    const client = appClient();
    await openShare(client);
    expect(text()).toContain(PROCESSING_TITLE);
    view!.unmount();
    view = null;

    answerFrames({
      url: "https://frames.example/archive.gz",
      count: 83,
      startedAt: 1_760_000_000_000,
      fileFormat: "jpeg",
    });
    await openShare(client);
    expect(Share.frames).toHaveBeenCalledTimes(2);
    expect(
      view!.container.querySelector(".rv-screen img")?.getAttribute("src"),
    ).toBe("blob:f");
    expect(text()).not.toContain(PROCESSING_TITLE);
    expect(text()).not.toContain("No snapshots captured");
    client.clear();
  });
});
