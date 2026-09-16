/* ===========================================================================
   Public share viewer — data hook.

   Resolves a share token to its bundle (session summary + sharer-enabled
   panel map) and, ONLY for the panels the sharer turned on, fetches the
   backing data through the UNAUTHENTICATED `Share.*` client (v1/share/:token).

   Access pattern / scalability: every call is a single point read keyed by an
   indexed share token → session; the secondary fetches are `enabled`-gated on
   react-query so a panel the sharer disabled never hits the network. No list
   scans, no N+1 — one request per surfaced panel, each capped with `limit`.
   ========================================================================== */
import { Share } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import type {
  ApiSessionDetail,
  ApiLog,
  ApiScreen,
  ApiTimeline,
  ApiPerformance,
} from "@/routes/recordings/recordings.data";
import type {
  ReplayBatch,
  FramesInfo,
} from "@/routes/recordings/player/playerTypes";

/** Shape returned by GET /v1/share/:token — the session summary the reference
 *  ShareController resolves the token to, plus the key→boolean panel map the
 *  sharer picked in the drawer. */
export type ShareBundle = {
  session: ApiSessionDetail;
  panels: Record<string, boolean>;
};

/** ios/android/rn/flutter play through the native frames player; everything
 *  else is a web rrweb replay. Accept the reference `react_native` spelling. */
const MOBILE_PLATFORMS = new Set([
  "android",
  "ios",
  "react_native",
  "rn",
  "flutter",
]);
export function isMobilePlatform(platform: string | null | undefined): boolean {
  return MOBILE_PLATFORMS.has((platform || "").toLowerCase());
}

export type ShareData = {
  status: "loading" | "error" | "ok";
  error: Error | null;
  bundle: ShareBundle | undefined;
  isMobile: boolean;
  panels: Record<string, boolean>;
  // Playback streams (players consume these directly).
  batches: ReplayBatch[] | undefined;
  framesInfo: FramesInfo | undefined;
  /** The mobile /frames descriptor is still in flight — `framesInfo` being
   *  undefined does NOT yet mean "no archive". Mirrors the dashboard RvPlayer so
   *  RvMobilePlayer keeps showing the spinner (not the empty state) while frames
   *  resolve. Always false for web sessions (the frames query stays disabled). */
  framesPending: boolean;
  // Panel streams — only populated for enabled panels (else undefined).
  timeline: ApiTimeline | undefined;
  console: ApiLog[] | undefined;
  network: ApiLog[] | undefined;
  errors: ApiLog[] | undefined;
  screens: ApiScreen[] | undefined;
  performance: ApiPerformance | undefined;
};

/**
 * All hooks run every render (Rules of Hooks); each secondary fetch is gated by
 * `enabled` so it stays dormant until the token resolves AND the sharer enabled
 * that panel. The public GET client sends no auth header (see client.ts), so
 * these work with no logged-in workspace.
 */
export function useShareBundle(token: string): ShareData {
  const {
    data: bundle,
    loading,
    error,
  } = useApi<ShareBundle>(
    () => Share.resolve<ShareBundle>(token),
    [token],
    { retry: 0 }, // an invalid/expired/revoked token 4xx won't recover — fail fast to the error card
  );

  const panels = bundle?.panels ?? {};
  const platform = bundle?.session.platform ?? "";
  const isMobile = isMobilePlatform(platform);
  const has = (k: string) => !!bundle && !!panels[k];

  // Playback: the replay batches drive BOTH players (web rrweb events; mobile
  // native snapshots + tap overlays ride the same batches). Mobile additionally
  // needs the frames archive descriptor.
  const { data: batches } = useApi<ReplayBatch[]>(
    () => Share.events<ReplayBatch[]>(token),
    [token],
    { enabled: !!bundle },
  );
  const { data: framesInfo, loading: framesInfoLoading } = useApi<FramesInfo>(
    () => Share.frames<FramesInfo>(token),
    [token],
    { enabled: !!bundle && isMobile },
  );
  // Only "pending" once the request is genuinely enabled and in flight — a web
  // session (query disabled) must read as NOT pending so its player never waits
  // on a descriptor that will never load. `loading` is isPending, which settles
  // false on both success and error, so the spinner can't hang.
  const framesPending = isMobile && !!bundle && framesInfoLoading;

  // Structured activity log (events tab).
  const { data: timeline } = useApi<ApiTimeline>(
    () => Share.timeline<ApiTimeline>(token),
    [token],
    { enabled: has("events") },
  );
  const { data: consoleRows } = useApi<ApiLog[]>(
    () => Share.console<ApiLog[]>(token, { limit: 500 }),
    [token],
    { enabled: has("console") },
  );
  const { data: networkRows } = useApi<ApiLog[]>(
    () => Share.network<ApiLog[]>(token, { limit: 500 }),
    [token],
    { enabled: has("network") },
  );
  // Errors back BOTH the web perf tab (error rows) and the mobile crashes tab.
  const { data: errorRows } = useApi<ApiLog[]>(
    () => Share.errors<ApiLog[]>(token, { limit: 200 }),
    [token],
    { enabled: has("perf") || has("crashes") },
  );
  const { data: performance } = useApi<ApiPerformance>(
    () => Share.performance<ApiPerformance>(token),
    [token],
    { enabled: has("perf") },
  );
  const { data: screens } = useApi<ApiScreen[]>(
    () => Share.screens<ApiScreen[]>(token),
    [token],
    { enabled: has("screens") && isMobile },
  );

  const status: ShareData["status"] = error
    ? "error"
    : loading || !bundle
      ? "loading"
      : "ok";

  return {
    status,
    error,
    bundle,
    isMobile,
    panels,
    batches,
    framesInfo,
    framesPending,
    timeline,
    console: consoleRows,
    network: networkRows,
    errors: errorRows,
    screens,
    performance,
  };
}
