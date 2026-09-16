/* ============================================================================
   Page: Recordings v2 — "Investigation workspace"
   A production-debugging IDE. Ported verbatim from the prototype.
   BUG FIX (only non-verbatim structural change): the prototype called several
   hooks AFTER an early `if (empty) return`. All hooks are hoisted ABOVE every
   return here (same hooks, same order) so the Rules of Hooks hold.
   ========================================================================== */
import {
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
  useState,
  useRef,
  useEffect,
  useMemo,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EmptyState, EMPTY_ART } from "@/components/feedback";
import { Icon } from "@/components/primitives";
import { Sessions, Playlists, Settings, Dashboard } from "@/api/endpoints";
import { useApi, useApiInfinite } from "@/api/useApi";
import { RecordingsEmpty } from "./RecordingsEmpty";
import { RvWorkspaceSkeleton } from "./RvWorkspaceSkeleton";
import { RvRail, type RvGroup } from "./rail/RvRail";
import type { RvTick } from "./player/playerTypes";
import type { ApiRecording } from "@/routes/settings/settings.data";
import { RvStage } from "./player/RvStage";
import { RvShareModal } from "./share/RvShareModal";
import { AddToPlaylistModal } from "./share/AddToPlaylistModal";
import { CreateIssueModal } from "./share/CreateIssueModal";
import { RvContextMenu } from "@/components/overlays";
import { EventsPanel } from "./panels/EventsPanel";
import { ScreensPanel } from "./panels/ScreensPanel";
import { ConsolePanel } from "./panels/ConsolePanel";
import { NetworkPanel } from "./panels/NetworkPanel";
import { CrashesPanel } from "./panels/CrashesPanel";
import { PerformancePanel, type PerfHover } from "./panels/PerformancePanel";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { TracesPanel } from "./panels/TracesPanel";
import { CommentsPanel } from "./panels/CommentsPanel";
import type { FilterToken } from "./search/search.data";
import { tokensToParams } from "./search/tokens";
import { parseQuery } from "./search/recents";
import { useFacets } from "./search/suggest";
import {
  adaptTicks,
  type ApiTimeline,
  adaptSession,
  readTotal,
  rvClock,
  type ApiSession,
  type ApiSessionDetail,
  type RvSession,
} from "./recordings.data";

/* ===================================================================== */
export function Recordings({ empty }: { empty?: boolean }) {
  // The selected session lives in the URL (/recordings/:recordingId) so it can be
  // deep-linked and filtered later. setCur keeps the same (id: string) => void
  // signature the rail/stage expect, but drives navigation instead of local state.
  const { recordingId } = useParams();
  const navigate = useNavigate();
  // Playlist deep-link scope: the sidebar links each playlist to
  // /recordings?playlist=<id>. When present we forward it to Sessions.list so
  // the rail shows only that playlist's recordings (server-side, indexed join),
  // and surface a dismissible banner that clears the scope.
  const [sp] = useSearchParams();
  const playlistScope = sp.get("playlist") ?? undefined;
  // /recordings?sessionIds=<csv>&fnstep=<label> — the funnel-step drill-down
  // ("View sessions"): scope the list to those exact sessions + a banner.
  const idScope = sp.get("sessionIds") ?? undefined;
  const fnLabel = sp.get("fnstep") ?? undefined;
  /* /recordings?incident=<id> — "View sessions" on an Overview signal. A single
     named param the SERVER resolves to session ids: an incident's session set is
     unbounded, so it cannot ride in the URL as a CSV the way a funnel step's
     sample does. Additive — every existing funnel link is untouched. */
  const incidentScope = sp.get("incident") ?? undefined;
  const issueScope = sp.get("issue") ?? undefined;
  /* /recordings?funnel=<id>&fstep=<i>&ffrom=<ms>&fto=<ms> — the funnel-step
     "View sessions" drill-down for a SAVED funnel. Server-resolved (one
     windowFunnel pass → ≤5,000 reached ids, newest first) and keyset-paged like
     `incident`, so it scrolls past the old fixed 200-id sample. `fnstep` still
     carries the human label for the banner. */
  const funnelScope = sp.get("funnel") ?? undefined;
  const fstepScope = sp.get("fstep") ?? undefined;
  const ffromScope = sp.get("ffrom") ?? undefined;
  const ftoScope = sp.get("fto") ?? undefined;
  const scoped =
    !!playlistScope ||
    !!idScope ||
    !!incidentScope ||
    !!issueScope ||
    !!funnelScope;
  // Scoped-playlist name for the banner. Only fetched while a scope is active.
  const { data: scopePl } = useApi<{ title: string }>(
    () => Playlists.get<{ title: string }>(playlistScope!),
    [playlistScope],
    { enabled: !!playlistScope },
  );
  /* Scoped-incident header for the banner, same shape as the playlist above.
     `attributedSessions` is the count the SCOPE resolves to right now, which is
     not the same number as the incident's headline sessionCount — see the empty
     state below for why they legitimately differ. */
  const { data: scopeInc, error: scopeIncError } = useApi<{
    title: string;
    sessionCount: number;
    attributedSessions: number;
    scopeCapped: boolean;
    scopeCap: number;
  }>(() => Dashboard.incidentDetail(incidentScope!), [incidentScope], {
    enabled: !!incidentScope,
  });
  /* Issue header for the ?issue= banner — the issue's real title, so the strip
     names the actual problem ("TypeError: …") instead of a generic "this issue".
     The investigation payload already carries `issue.title`/`issue.sessionCount`,
     so no extra endpoint; only fetched when an issue actually scopes the list. */
  const { data: scopeIssue } = useApi<{
    issue?: { title?: string; sessionCount?: number };
  }>(() => Dashboard.issueInvestigation(issueScope!), [issueScope], {
    enabled: !!issueScope,
  });
  const [searchParams] = useSearchParams();
  const seekParam = searchParams.get("t"); // deep-link from Comments: seconds to seek to
  // Selecting a recording keeps the current filter scope (?issue / ?sessionIds
  // / ?incident / ?playlist / ?fnstep) so the list stays filtered — dropping it
  // reset the page to ALL recordings. The one-time seek deep-link (?t) is not a
  // scope, so it's stripped.
  const setCur = (id: string) => {
    const q = new URLSearchParams(searchParams);
    q.delete("t");
    const qs = q.toString();
    navigate("/recordings/" + id + (qs ? "?" + qs : ""));
  };
  // Seed the filter chips from ?q= once, so a deep-link like
  // /recordings?q=platform:web (from the Segments band) lands pre-filtered.
  // parseQuery only keeps keys that exist in PROPS, so junk is dropped.
  const [tokens, setTokens] = useState<FilterToken[]>(() => {
    const q = sp.get("q");
    if (!q) return [];
    return parseQuery(q).map((t, i) => ({
      ...t,
      id: `q${i}`,
      join: i ? "and" : null,
    }));
  });
  /* The search chips, resolved to the params /v1/sessions already accepts.
     `unapplied` is every chip with no param behind it — the rail names them, so
     the list can never come back wider than the filter bar claims. */
  const { params: tokenParams, unapplied } = useMemo(
    () => tokensToParams(tokens),
    [tokens],
  );
  // Serialised so the query key changes on VALUE change, not on the new array
  // identity `tokensToParams` returns for every keystroke elsewhere on the page.
  const tokenKey = useMemo(() => JSON.stringify(tokenParams), [tokenParams]);
  /* Warm the search's bounded value sets (browsers / devices / countries) NOW,
     so the dropdown opens instantly instead of paying a request on first use.
     The return is deliberately unused: RvSearch calls useFacets() itself, and
     with a fixed key and no deps that is the SAME TanStack entry — this call
     only decides WHEN it is fetched. It has to live here rather than in the
     search: RvSearch mounts inside the rail, which this component skeletons
     behind until the list resolves, so a preload down there would queue after
     the list instead of racing alongside it. One request per mount, and the
     endpoint is cached server-side. */
  // Truly-empty workspace (never captured a session) — decided from the shared
  // dashboard counts (already fetched on load, no refetch), so we never fire the
  // sessions/facets fetches on an empty workspace: it goes straight to the
  // install onboarding with no fetch → skeleton → empty flash. A scope
  // (playlist/incident/issue/funnel) is a DIFFERENT empty (its own state) and
  // always fetches.
  const hasScope = !!(
    playlistScope ||
    idScope ||
    incidentScope ||
    issueScope ||
    funnelScope
  );
  const {
    data: wsCounts,
    loading: wsCountsLoading,
    stale: wsCountsStale,
  } = useApi<{ recordings: number }>(
    () => Dashboard.counts<{ recordings: number }>(),
    [],
    { key: "dashboard-counts" },
  );
  const emptyWorkspace =
    !wsCountsLoading &&
    !wsCountsStale &&
    !!wsCounts &&
    wsCounts.recordings === 0 &&
    !hasScope;
  useFacets(!emptyWorkspace);
  // Recordings list → rail + stage. workspace id is auto-keyed by useApi.
  const {
    items: listData,
    page: listPage,
    loading: listLoading,
    loadingMore: listLoadingMore,
    stale: listStale,
    hasMore: listHasMore,
    fetchMore: listFetchMore,
    error: listError,
    refetch: refetchList,
  } = useApiInfinite<ApiSession>(
    (cursor) =>
      Sessions.list<ApiSession[]>({
        limit: 50,
        playlistId: playlistScope,
        sessionIds: idScope,
        incident: incidentScope,
        issue: issueScope,
        funnel: funnelScope,
        fstep: fstepScope,
        ffrom: ffromScope,
        fto: ftoScope,
        ...tokenParams,
        cursor: cursor ?? undefined,
      }),
    // Hand-maintained dep list — the scope keys MUST be here. Omitting one
    // serves the previous scope's cached rows underneath the new banner.
    [
      playlistScope,
      idScope,
      incidentScope,
      issueScope,
      funnelScope,
      fstepScope,
      tokenKey,
    ],
    // Don't fetch the list at all for a truly-empty workspace — the install
    // onboarding renders straight from counts (see `emptyWorkspace`).
    { enabled: !emptyWorkspace },
  );
  /* No fixture fallback. This used to be `apiSessions.length ? apiSessions :
     RV_SESS`, which meant a failed request rendered invented recordings that
     were indistinguishable from real ones — the workspace looked populated
     while the API was down. An unresolved list now renders the skeleton below.
     Consequence: `sessions` can legitimately be empty and `s` undefined, so
     every hook above the early returns has to tolerate that. */
  // Wrapped, not point-free: adaptSession's 2nd arg is `isPublic`, and map would
  // hand it the array index — making every row but the first a "public" one.
  const sessions: RvSession[] = (listData ?? []).map((x) => adaptSession(x));
  /* Sessions matching the CURRENT filter, from the list envelope — server-side,
     so it describes the whole result set rather than the page we happen to hold.
     Counting `sessions` here instead would report the page size (50) as the
     total, which is the same lie as the fixture literal it replaces, just
     arithmetically derived.

     While a new filter is in flight `listStale` is true and this is the PREVIOUS
     filter's total (keepPreviousData) — the rail is told, and shows it as
     pending rather than as the current answer. */
  const total = readTotal(listPage);
  // "" (not a fixture id) until the list reports one — every session-scoped
  // query below is disabled while it's empty rather than fetching /sessions/c9d.
  const cur = recordingId ?? sessions[0]?.id ?? "";
  // Opened session's real metadata (header + custom-properties tab). Falls back
  // to the list row while the detail fetch is in flight.
  const { data: detailData, refetch: refetchDetail } = useApi<ApiSessionDetail>(
    () => Sessions.get<ApiSessionDetail>(cur),
    [cur],
    { enabled: !!cur },
  );
  const [tab, setTab] = useState("events");
  const [playing, setPlaying] = useState(false);
  const [theatre, setTheatre] = useState(false);
  const [clOpen, setClOpen] = useState<number | null>(null);
  const [evOpen, setEvOpen] = useState<number | null>(null);
  const [clevel, setClevel] = useState("all");
  const [netOpen, setNetOpen] = useState(-1);
  const [propShut, setPropShut] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [perfHover, setPerfHover] = useState<PerfHover | null>(null);
  const [crashOpen, setCrashOpen] = useState<Record<number, boolean>>({});
  /* Viewport coords for the "Coming soon" tab tooltip. It has to be portalled
     to <body>: `.rv-insp-tabs` is `overflow-x:auto` in the approved sheet, and
     per spec that forces overflow-y to a non-visible value, so a tip drawn
     inside the strip is clipped wherever it's placed. */
  const [soonTip, setSoonTip] = useState<{ x: number; y: number } | null>(null);
  // Share / add-to-playlist / create-issue all act on the session they were
  // opened FOR, which the rail's context menu makes distinct from the one
  // currently playing — so each holds its target rather than a bare boolean.
  const [shareFor, setShareFor] = useState<RvSession | null>(null);
  const [playlistFor, setPlaylistFor] = useState<RvSession | null>(null);
  const [issueFor, setIssueFor] = useState<RvSession | null>(null);
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    s: RvSession;
  } | null>(null);
  // ── replay player state ──
  // Playhead as % of the session. Starts at 0 — it used to seed at 16%, which
  // is what showed "0:06" on a cold load before anything had played.
  const [pos, setPos] = useState(0);
  // Real duration (seconds) reported by the player itself (rrweb metadata /
  // last mobile frame). `s.dur` is the LIST's rounded label and disagrees with
  // it, so every clock read from `s.dur` drifted; 0 until the player reports.
  const [realDur, setRealDur] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [bookmarks, setBookmarks] = useState<number[]>([]);
  const [annotate, setAnnotate] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const scrubRef = useRef<HTMLDivElement>(null);
  /* Autoplay next: the rail's toggle persists `autoplayNextRecording`, but
     nothing consumed it — the setting was write-only, which is why enabling it
     did nothing. Same "settings/recording" cache key the rail uses, so the two
     stay in sync without a second fetch. */
  const { data: recSettings } = useApi<ApiRecording>(
    () => Settings.recording.get<ApiRecording>(),
    [],
    { key: "settings/recording" },
  );
  const autoplayNext = recSettings?.autoplayNextRecording ?? false;

  // resizable panels (persisted) — defaults give replay ~60% of a desktop width
  const [railW, setRailW] = useState(
    () => +localStorage.getItem("rv-railw")! || 272,
  );
  // Key bumped to -v2 so the approved 336px default takes effect even in browsers
  // that already auto-persisted the previous 304px default.
  const [inspW, setInspW] = useState(
    () => +localStorage.getItem("rv-inspw-v2")! || 336,
  );
  // debounce the width writes so a drag doesn't hammer localStorage every frame
  // (behavior-preserving: the latest value still lands once the drag settles).
  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem("rv-railw", String(railW));
    }, 200);
    return () => clearTimeout(t);
  }, [railW]);
  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem("rv-inspw-v2", String(inspW));
    }, 200);
    return () => clearTimeout(t);
  }, [inspW]);
  // keyboard transport (pro video-editor style): space=play, ←→ step, J/L speed
  useEffect(() => {
    if (empty) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      const k = e.key.toLowerCase();
      if (e.key === " " || k === "k") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPos((p) => Math.max(0, +(p - (e.shiftKey ? 5 : 1)).toFixed(2)));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setPos((p) => Math.min(100, +(p + (e.shiftKey ? 5 : 1)).toFixed(2)));
      } else if (k === "j")
        setSpeed(
          (v) => (v <= 0.5 ? 1 : v === 1 ? 1 : 1) && (v === 2 ? 1 : 0.5),
        );
      else if (k === "l") setSpeed((v) => (v === 0.5 ? 1 : 2));
      // Bookmark shortcut disabled with its HUD icon (removed for now).
      // else if (k === "b")
      //   setBookmarks((b) => {
      //     const m = Math.round(pos);
      //     return b.includes(m) ? b : [...b, m].sort((a, c) => a - c);
      //   });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pos, empty]);

  const detailSession = detailData ? adaptSession(detailData) : undefined;
  /* `s` drives the player: RvStage → RvPlayer key={s.id}, so `s.id` changing is
     what remounts the player and kicks off "Loading replay" + the events/frames
     fetch. On a session SWITCH `detailData` is still the PREVIOUS session —
     useApi keeps the prior key's data as a placeholder until Sessions.get(cur)
     resolves — so a bare `detailSession ||` pinned `s` (and the player's key) to
     the OLD recording until that metadata request returned: the player kept
     showing the previous replay with no loading state, while the Events panel
     (keyed on `cur`) had already skeletoned. So only take `detailSession` once it
     actually IS this session (its id === cur); otherwise use the fresh list row
     for `cur` immediately, so the player switches the instant you click. `s`
     still upgrades to the richer detail (header, custom props) once it matches.
     Undefined until the list resolves; the early returns below narrow it away,
     but every hook ABOVE them runs first and must stay optional. */
  const s: RvSession | undefined =
    (detailSession?.id === cur ? detailSession : undefined) ||
    sessions.find((x) => x.id === cur) ||
    sessions[0];
  const isMobile =
    s?.plat === "ios" ||
    s?.plat === "android" ||
    s?.plat === "rn" ||
    s?.plat === "flutter";
  /* Tab badge counts come from the session summary. `undefined` renders NO
     badge, which is the honest state before the detail lands — these used to
     fall back to fixture literals (7 console lines, 6 requests, 2 comments,
     RV_EVENTS.length), so a session with 0 of something advertised someone
     else's numbers until the real ones arrived. Worse while offline: TanStack
     pauses queries, so `detailData` stays undefined and the invented counts
     just sat there. The events count isn't precomputed server-side at all, so
     Events carries no badge rather than a made-up one. */
  const TABS: [string, string, number?, boolean?][] = [
    ["events", "Events"],
    ...(isMobile
      ? ([["screens", "Screens", detailData?.pageCount]] as [
          string,
          string,
          number?,
          boolean?,
        ][])
      : []),
    ["console", "Console", detailData?.consoleCount],
    ["network", "Network", detailData?.networkCount],
    ...(isMobile
      ? ([["crashes", "Crashes", detailData?.errorCount ?? 0]] as [
          string,
          string,
          number?,
          boolean?,
        ][])
      : []),
    ["performance", "Performance"],
    ["properties", "Custom properties"],
    // Distributed traces have no backend yet — the tab is shown but inert.
    ["traces", "Traces", undefined, true],
    ["comments", "Comments", detailData?.commentCount],
  ];
  const idx = sessions.findIndex((x) => x.id === cur);

  /* ── Timeline ticks on the scrubber ───────────────────────────────────────
     The marks on the progress bar are the session's real events (the legacy
     player's `timeline-marker`s). One /timeline read lives here so the
     scrubber and the Events panel agree on the same stream; each tick carries
     its own seconds so it can be placed and seeked exactly.
     The explicit `key` (rather than the default djb2-of-source key) makes THIS
     read and the Events panel's read collapse onto ONE React Query cache entry:
     two components asking for the same session's timeline now cost a single
     network round-trip, which matters over a slow link where the redundant
     fetch was stealing bandwidth from the /events replay stream. */
  const { data: timelineData } = useApi<ApiTimeline>(
    () => Sessions.timeline<ApiTimeline>(s?.id ?? ""),
    [s?.id],
    { enabled: !!s?.id, key: `session-timeline:${s?.id ?? ""}` },
  );
  const ticks: RvTick[] = useMemo(
    () => (timelineData ? adaptTicks(timelineData.events).slice(0, 400) : []),
    [timelineData],
  );
  useEffect(() => {
    // Fall back to events if the tab vanished for this session (web/mobile
    // differ) or is inert (traces has no backend yet).
    const t = TABS.find((x) => x[0] === tab);
    if (!t || t[3]) setTab("events");
  }, [cur]);
  // cursor appearance (web only — playback visualization, never modifies the recording)
  const [cursorMode, setCursorMode] = useState(
    () => localStorage.getItem("rv-cursor") || "halo",
  );
  useEffect(() => {
    try {
      localStorage.setItem("rv-cursor", cursorMode);
    } catch (e) {}
  }, [cursorMode]);
  // Selecting a session starts it: rewind to 0, drop the stale duration (the
  // new player reports its own) and roll. A deep-link ?t= seek lands after
  // this, so it still wins.
  useEffect(() => {
    setPos(0);
    setRealDur(0);
    setPlaying(true);
  }, [cur]);

  /* Deep-link seek: Comments' "Open at" opens /recordings/:id?t=<seconds>.

     This waits for `realDur` (the player's own duration) instead of deriving a
     percentage from the list's rounded `s.dur` label, because the old version
     never actually seeked. It ran while the player was still loading, and
     RvStage's control effect only seeks `if (dur > 0)` — with the real duration
     still 0 the goto was silently dropped, playback reported position 0, and
     the playhead snapped back to the start. Hence "always starts from the
     beginning".

     Waiting also makes it land exactly: `s.dur` is rounded to the second, so a
     percentage computed from it missed the mark by up to ~1% of the recording.

     It re-pins on every `realDur` change rather than latching after the first
     one, because the mobile player reports its duration PROGRESSIVELY as frames
     load — the first report is a partial (~11s of a 38s session). Pinning once
     against that partial put `?t=10` at 0:33: 10/11.7 = 85% of the bar, and 85%
     of the real 38s is 0:33. Re-pinning converges as the duration settles.
     Nothing re-runs this once it does — `pos` is deliberately not a dep, so the
     follower advancing the playhead can't drag it back to the deep link. */
  useEffect(() => {
    if (seekParam == null) return;
    if (realDur <= 0) return; // player hasn't reported its duration yet
    const secs = Number(seekParam);
    if (!Number.isFinite(secs) || secs < 0) return;
    setPos(Math.max(0, Math.min(100, +((secs / realDur) * 100).toFixed(2))));
  }, [cur, seekParam, realDur]);
  // [ / ] navigate prev/next session
  useEffect(() => {
    if (empty) return;
    const onNav = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (e.key === "[") {
        e.preventDefault();
        if (idx > 0) setCur(sessions[idx - 1].id);
      } else if (e.key === "]") {
        e.preventDefault();
        if (idx < sessions.length - 1) setCur(sessions[idx + 1].id);
      } else if (e.key.toLowerCase() === "f") {
        const a = document.activeElement;
        if (!a || (a.tagName !== "INPUT" && a.tagName !== "TEXTAREA"))
          setTheatre((v) => !v);
      } else if (e.key === "Escape" && theatre) {
        // In focus (theatre) mode, Esc exits it — the expected way out of a
        // fullscreen-style view. Only claims Esc while focus mode is on, so it
        // never swallows Esc for closing drawers/modals otherwise.
        e.preventDefault();
        setTheatre(false);
      }
    };
    document.addEventListener("keydown", onNav);
    return () => document.removeEventListener("keydown", onNav);
  }, [idx, empty, theatre]);

  /* One descriptor per scope KIND, so the banner JSX below has a single shape
     and is rendered identically at every one of its four call sites. Adding a
     scope means adding a branch here, never a second banner or a new ternary
     inside the markup. Precedence playlist → incident → funnel-step matches the
     order the params are read above. */
  const scopeInfo: { icon: string; body: React.ReactNode } = playlistScope
    ? {
        icon: "rec",
        body: (
          <>
            Scoped to playlist{" "}
            <b style={{ color: "var(--t1)" }}>{scopePl?.title ?? "…"}</b>
          </>
        ),
      }
    : incidentScope
      ? {
          // "warn" is what the Overview assigns a critical signal's icon, so the
          // banner matches the row the user clicked to get here.
          icon: "warn",
          body: (
            <>
              Sessions in{" "}
              <b style={{ color: "var(--t1)" }}>
                {/* A 404 here is reachable — the id can be stale, deleted, from
                    another workspace, or hand-typed garbage. Settle on a neutral
                    noun rather than spinning on "…" forever. */}
                {scopeInc?.title ?? (scopeIncError ? "this incident" : "…")}
              </b>
              {/* A capped scope must say so, or the count under it is a lie. */}
              {scopeInc?.scopeCapped
                ? ` — newest ${scopeInc.scopeCap.toLocaleString()} sessions`
                : ""}
            </>
          ),
        }
      : issueScope
        ? {
            // Alert glyph for an issue scope — matches the incident banner. (Was
            // "err", which isn't a real icon in the set, so nothing rendered.)
            icon: "warn",
            body: (
              <>
                Sessions affected by{" "}
                <b style={{ color: "var(--t1)" }}>
                  {scopeIssue?.issue?.title ?? "this issue"}
                </b>
              </>
            ),
          }
        : {
            icon: "funnel",
            body: (
              <>
                Sessions that reached{" "}
                <b style={{ color: "var(--t1)" }}>
                  {fnLabel || "this funnel step"}
                </b>
              </>
            ),
          };

  // Dismissible scope banner shown whenever a playlist, an incident OR a funnel
  // step scopes the list. A thin strip above the workspace; clearing navigates
  // to /recordings, which drops every scope param at once.
  const scopeBanner = scoped ? (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-8)",
        padding: "var(--sp-8) var(--sp-14)",
        fontSize: "var(--text-sm)",
        color: "var(--t2)",
        background: "var(--rv-acc-tint, var(--panel))",
        borderBottom: "1px solid var(--line)",
        flexShrink: 0,
      }}
    >
      <Icon name={scopeInfo.icon} size={13} />
      <span>{scopeInfo.body}</span>
      <span style={{ flex: 1 }} />
      <button
        className="btn q sm"
        onClick={() => navigate("/recordings")}
        title="Clear filter"
      >
        Clear
        <Icon name="x" size={12} />
      </button>
    </div>
  ) : null;

  // Real empty workspace (list LOADED with zero sessions) → same empty state as
  // the router's `empty` prop, rather than falling through to fixtures.
  // `!listLoading` is the load gate, and it matters: useApiInfinite's `items` is
  // `[]` (never undefined) DURING the cold fetch too, so the old
  // `listData !== undefined` check was always true — a workspace that has
  // recordings flashed the install/onboarding page for a beat on every load
  // before the skeleton (below) took over. Gating on the cold load means a
  // populated workspace shows its skeleton while loading, and only a genuinely
  // empty one reaches the install page.
  // `emptyWorkspace` (counts say 0, no scope) shows the install onboarding
  // WITHOUT waiting on the now-disabled list query (whose isPending never
  // resolves) — so a brand-new workspace never hangs on a skeleton.
  const noSessions = emptyWorkspace || (!listLoading && listData.length === 0);
  /* A filter that matched nothing is NOT an empty workspace, and it is not a
     page-level event either — it is the LIST's answer to the LIST's question.
     So the rail stays and says so (see RvRail), and only the player is dropped,
     because there is no session to play. That is what narrows `s` below.

     This used to return a full-page illustrated EmptyState, which replaced the
     entire workspace — including the search bar, which lives in the rail. That
     left "Clear filters" as the only move available: you could not loosen the
     filter that got you here, only throw it away. Keeping the rail keeps the
     way out on screen.

     Ordered before `noSessions` because both are "listData is empty" and only
     this one knows why — falling through would tell someone whose SDK has been
     shipping for months to go install it. `listStale` is deliberately NOT a
     condition: the rail renders its skeleton while refetching, so changing a
     filter over an already-empty list no longer flashes the install page. */
  if (tokens.length > 0 && noSessions)
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: 0,
        }}
      >
        {scopeBanner}
        <div
          className="rv-wrap"
          style={{ flex: 1, height: "auto", minHeight: 0 }}
        >
          <RvRail
            railW={railW}
            groups={[]}
            cur=""
            setCur={setCur}
            tokens={tokens}
            setTokens={setTokens}
            listBusy={listStale}
            total={total}
            unapplied={unapplied}
          />
        </div>
      </div>
    );
  if (empty || noSessions)
    // A scoped list with no matches (playlist / funnel step) is a different story
    // from a brand-new workspace (the SDK is already installed) — keep that a
    // simple empty state. A truly empty workspace gets the install-onboarding.
    return scoped ? (
      <div className="wrap">
        {scopeBanner}
        <EmptyState
          art={EMPTY_ART?.recordings}
          title={
            playlistScope
              ? "No recordings in this playlist yet"
              : incidentScope
                ? "No sessions still attributed to this incident"
                : issueScope
                  ? "No sessions affected by this issue yet"
                  : "No recordings for this step"
          }
          /* The incident case is NOT an error and NOT a rare edge — say what
             actually happened rather than leaving a bare empty list under a
             banner that names an incident. TWO independent mechanisms empty
             this list while the incident card still reads "340 sessions":

             1. RETENTION (the dominant one). Short throwaway sessions are
                DELETED by the settle sweep, not hidden, and Signal cascades on
                Session — so the rows that resolved the scope are physically
                gone while `Incident.sessionCount`, a stored column, still reads
                what it read the night it was counted.
             2. ATTRIBUTION WINDOW. The clusterer stamps Signal.incidentId for
                the current window only, and only onto signals not already
                stamped, so a recurrence opens a fresh incident beside an
                ACK'd/RESOLVED predecessor.

             The copy names retention first because it is the likelier cause and
             the only one the user can act on (retention settings). Both are
             "these recordings no longer exist", which is why neither is phrased
             as a failure — and why the investigation, which reads aggregates
             rather than replayable sessions, is offered as the way forward. */
          desc={
            playlistScope
              ? "No sessions match this playlist so far. Recordings you add — or that match its filters — will show up here."
              : incidentScope
                ? `The recordings behind this incident are no longer available to replay — short sessions are cleared by your retention settings, and attribution only covers the most recent window. That is why its headline count${
                    scopeInc?.sessionCount
                      ? ` (${scopeInc.sessionCount.toLocaleString()})`
                      : ""
                  } can outlive the sessions themselves. The incident's investigation still has the full breakdown.`
                : issueScope
                  ? "No recordings are currently attributed to this issue — the affected sessions may have been cleared by your retention settings, or the issue's occurrences aren't yet linked to replayable sessions."
                  : "None of the sampled sessions for this funnel step are available to replay right now."
          }
          actions={[
            {
              label: "Browse all recordings",
              primary: true,
              icon: "rec",
              onClick: () => navigate("/recordings"),
            },
          ]}
        />
      </div>
    ) : (
      <RecordingsEmpty onEventLanded={refetchList} />
    );

  /* List not resolved yet → skeleton, never fixtures. Ordered AFTER the empty
     check on purpose: `noSessions` (loaded, zero rows) also leaves `s`
     undefined, and a real empty workspace must get the install-onboarding
     rather than a skeleton that never resolves.

     `listError` is included so a failed fetch degrades to a loading state
     instead of fabricated recordings. React Query retries underneath, so this
     also covers the API being restarted — the rail fills in on its own once it
     answers. `!s` is the type-level guard that lets everything below treat the
     session as defined.

     `listStale` is NOT part of this condition any more. It used to be, which
     meant applying a filter — a new query key, so `stale` until it lands — tore
     down the whole workspace: player, inspector, the recording you were part
     way through. Re-filtering only changes the LIST, so `listStale` now rides
     down to the rail as `listBusy` and the skeleton is scoped to the rail's
     rows. It still never renders the previous filter's sessions: the rail swaps
     them for the skeleton rather than showing rows the chips don't describe. */
  if (listLoading || listError || !s)
    return (
      // Deliberately classless, exactly like the real workspace's outer div
      // below: the generic `.wrap` carries 22px/80px padding, which would make
      // the skeleton 102px shorter than the page it stands in for.
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: 0,
        }}
      >
        {scopeBanner}
        <RvWorkspaceSkeleton railW={railW} inspW={inspW} />
      </div>
    );

  const liveItems = sessions.filter((x) => x.live);
  const groups: RvGroup[] = [
    // Only surface the LIVE group when something is actually live.
    ...(liveItems.length ? [{ t: "Live", live: true, items: liveItems }] : []),
    { t: "Earlier today", items: sessions.filter((x) => !x.live) },
  ];

  // Prefer the player's real duration; fall back to the list's raw durationMs
  // until it reports (and only then to 1s, so we never divide by zero). Reads
  // s.durationMs directly — s.dur is now a human label ("1h 40m"), not m:ss.
  const durSec = (() => {
    if (realDur > 0) return realDur;
    return Math.max(1, Math.round((s.durationMs || 0) / 1000));
  })();
  const fmtT = (p: number) => {
    // Clamp: rrweb's getCurrentTime() can read negative before playback starts,
    // and a negative tt formatted as-is printed clocks like "-1:-5".
    const safe = Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
    const tt = Math.max(0, Math.round((safe / 100) * durSec));
    // Shared clock format: m:ss under an hour, h:mm:ss past it (so the total on
    // a long session reads "1:40:50", not "100:50").
    return rvClock(tt * 1000);
  };
  const seekAt = (e: { clientX: number }) => {
    const r = scrubRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = ((e.clientX - r.left) / r.width) * 100;
    setPos(Math.max(0, Math.min(100, +x.toFixed(2))));
  };
  const onScrubDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    seekAt(e);
    const mv = (ev: MouseEvent) => seekAt(ev);
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  };
  const addBookmark = () =>
    setBookmarks((b) => {
      const m = Math.round(pos);
      return b.includes(m) ? b : [...b, m].sort((a, c) => a - c);
    });
  const copyVal = (k: string, v: string) => {
    try {
      navigator.clipboard?.writeText(v);
    } catch (e) {}
    setCopied(k);
    setTimeout(() => setCopied((c) => (c === k ? null : c)), 1100);
  };
  const cycleSpeed = () => setSpeed((v) => (v === 1 ? 2 : v === 2 ? 0.5 : 1));
  // panel drag handles — thin hit area, clamped, persisted via state effects
  const dragPanel = (which: string) => (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX,
      start = which === "rail" ? railW : inspW;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const mv = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const w = Math.max(
        212,
        Math.min(440, which === "rail" ? start + dx : start - dx),
      );
      which === "rail" ? setRailW(w) : setInspW(w);
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  };

  const trackRows = [
    ["Pointer", "var(--rv-acc)"],
    ["Clicks", "var(--rv-vio)"],
    ["Keys", "var(--rv-mut)"],
    ["Console", "var(--rv-net)"],
    ["Network", "var(--rv-net)"],
    ["Errors", "var(--rv-err)"],
    ["Jank", "var(--rv-warn)"],
    ["Nav", "var(--rv-net)"],
    ["Comments", "var(--rv-acc)"],
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      {scopeBanner}
      <div
        className={`rv-wrap ${theatre ? "theatre" : ""}`}
        style={{ flex: 1, height: "auto", minHeight: 0 }}
      >
        {/* ───────── LEFT RAIL ───────── */}
        <RvRail
          railW={railW}
          groups={groups}
          cur={cur}
          setCur={setCur}
          tokens={tokens}
          setTokens={setTokens}
          listBusy={listStale}
          hasMore={listHasMore}
          loadingMore={listLoadingMore}
          onMore={listFetchMore}
          total={total}
          unapplied={unapplied}
          onRowContextMenu={(e, x) => {
            e.preventDefault();
            setCtx({ x: e.clientX, y: e.clientY, s: x });
          }}
        />

        {/* ───────── CENTER ───────── */}
        <div
          className="rv-resize rail"
          onMouseDown={dragPanel("rail")}
          title="Drag to resize"
        />
        <RvStage
          s={s}
          idx={idx}
          sessions={sessions}
          isMobile={isMobile}
          theatre={theatre}
          setTheatre={setTheatre}
          annotate={annotate}
          setAnnotate={setAnnotate}
          pos={pos}
          setPos={setPos}
          playing={playing}
          setPlaying={setPlaying}
          speed={speed}
          setSpeed={setSpeed}
          speedOpen={speedOpen}
          setSpeedOpen={setSpeedOpen}
          bookmarks={bookmarks}
          scrubRef={scrubRef}
          onScrubDown={onScrubDown}
          fmtT={fmtT}
          durSec={durSec}
          ticks={ticks}
          onEnded={() => {
            // Advance only when the setting is on and there IS a next one;
            // the per-session effect above rewinds and starts it playing.
            if (!autoplayNext) return;
            const next = sessions[idx + 1];
            if (next) setCur(next.id);
          }}
          onRealDuration={setRealDur}
          addBookmark={addBookmark}
          setCur={setCur}
          setShareOpen={(v) => setShareFor(v ? s : null)}
        />

        {/* ───────── RIGHT: INVESTIGATION ───────── */}
        <div
          className="rv-resize insp"
          onMouseDown={dragPanel("insp")}
          title="Drag to resize"
        />
        <aside className="rv-inspect" style={{ width: inspW }}>
          <div className="rv-insp-tabs">
            {TABS.map(([k, l, n, soon]) => (
              <button
                key={k}
                className={(k === tab ? "on" : "") + (soon ? " soon" : "")}
                onClick={soon ? undefined : () => setTab(k)}
                /* aria-disabled, NOT `disabled`: a disabled button receives no
                   pointer events, so the hover tooltip below could never open.
                   There's no onClick to guard, so nothing is lost. */
                aria-disabled={soon || undefined}
                onMouseEnter={
                  soon
                    ? (e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setSoonTip({
                          x: r.left + r.width / 2,
                          y: r.bottom + 7,
                        });
                      }
                    : undefined
                }
                onMouseLeave={soon ? () => setSoonTip(null) : undefined}
              >
                {l}
                {n != null && <span className="ct">{n}</span>}
              </button>
            ))}
          </div>

          {tab === "events" && (
            <EventsPanel
              publicId={cur}
              pos={pos}
              durSec={durSec}
              setPos={setPos}
              evOpen={evOpen}
              setEvOpen={setEvOpen}
            />
          )}

          {tab === "screens" && (
            <ScreensPanel
              publicId={cur}
              pos={pos}
              durSec={durSec}
              setPos={setPos}
            />
          )}

          {tab === "console" && (
            <ConsolePanel
              publicId={cur}
              clevel={clevel}
              setClevel={setClevel}
              clOpen={clOpen}
              setClOpen={setClOpen}
            />
          )}

          {tab === "network" && (
            <NetworkPanel
              publicId={cur}
              netOpen={netOpen}
              setNetOpen={setNetOpen}
              seek={(secs) =>
                setPos(
                  Math.max(
                    0,
                    Math.min(100, +((secs / (durSec || 1)) * 100).toFixed(2)),
                  ),
                )
              }
            />
          )}

          {tab === "crashes" && (
            <CrashesPanel
              publicId={cur}
              appVersion={detailData?.appVersion}
              appBuild={detailData?.appBuild}
              startMs={
                detailData?.startedAt
                  ? new Date(detailData.startedAt).getTime()
                  : undefined
              }
              crashOpen={crashOpen}
              setCrashOpen={setCrashOpen}
            />
          )}

          {tab === "performance" && (
            <PerformancePanel
              publicId={cur}
              isMobile={isMobile}
              s={s}
              perfHover={perfHover}
              setPerfHover={setPerfHover}
              pos={pos}
              fmtT={fmtT}
            />
          )}

          {tab === "properties" && (
            <PropertiesPanel
              detail={detailData}
              propShut={propShut}
              setPropShut={setPropShut}
              copyVal={copyVal}
              copied={copied}
            />
          )}

          {tab === "traces" && <TracesPanel />}

          {tab === "comments" && (
            <CommentsPanel
              publicId={cur}
              pos={pos}
              durSec={durSec}
              onPosted={refetchDetail}
            />
          )}
        </aside>
        <RvShareModal
          open={!!shareFor}
          onClose={() => setShareFor(null)}
          s={shareFor ?? s}
        />
        <AddToPlaylistModal
          open={!!playlistFor}
          sessionPublicId={playlistFor?.id}
          onClose={() => setPlaylistFor(null)}
        />
        <CreateIssueModal
          open={!!issueFor}
          sessionPublicId={issueFor?.id}
          onClose={() => setIssueFor(null)}
        />
        {ctx && (
          <RvContextMenu
            x={ctx.x}
            y={ctx.y}
            onClose={() => setCtx(null)}
            items={[
              {
                label: "Add to playlist",
                icon: "listplus",
                onClick: () => setPlaylistFor(ctx.s),
              },
              {
                label: "Create issue",
                icon: "issue",
                onClick: () => setIssueFor(ctx.s),
              },
              {
                label: "Share recording",
                icon: "share",
                onClick: () => setShareFor(ctx.s),
              },
            ]}
          />
        )}
        {soonTip &&
          createPortal(
            <div
              className="rv-soontip"
              role="tooltip"
              style={{ left: soonTip.x, top: soonTip.y }}
            >
              Coming soon
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}
