/* ===========================================================================
   Public shared-recording viewer  ·  route /s/:token  (NO auth shell)

   A recipient with a share link lands here — no login, no sidebar, no
   workspace chrome. We resolve the token to its bundle (session + the panels
   the sharer enabled) and replay the REAL recording by reusing the frozen
   players (RvWebPlayer over Share.events batches / RvMobilePlayer over the
   Share.frames archive + native overlays). Only the sharer-enabled panels are
   surfaced, read-only. Everything is real data via the unauthenticated Share.*
   client; invalid/expired/revoked tokens (resolve 4xx) show a clean message.

   The HUD⇄player clock bridge is ported verbatim from RvStage: while playing a
   rAF reads the player clock into pos%, and a user scrub/seek writes back
   through the imperative handle. We can't reuse RvStage itself — it embeds
   RvPlayer, which fetches through the authed Sessions client by publicId.
   ========================================================================== */
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "react-router-dom";
import { RvWebPlayer } from "@/routes/recordings/player/RvWebPlayer";
import { RvMobilePlayer } from "@/routes/recordings/player/RvMobilePlayer";
import type { RvPlayerHandle } from "@/routes/recordings/player/playerTypes";
import { RvGlyph } from "@/routes/recordings/glyphs";
import { rvHue, pct } from "@/routes/recordings/helpers";
import { adaptSession } from "@/routes/recordings/recordings.data";
import { useShareBundle } from "./shareData";
import { Share } from "@/api/endpoints";
import { useBackendReachable } from "@/api/health";
import { NetworkError } from "@/components/feedback/network/NetworkError";
import { ShareInspector } from "./SharePanels";

/* Tab order per platform — a subset of the Recordings inspector; only the keys
   the sharer enabled (bundle.panels[key]) are shown. */
const WEB_TABS: [string, string][] = [
  ["events", "Events"],
  ["console", "Console"],
  ["network", "Network"],
  ["perf", "Performance"],
  ["comments", "Comments"],
];
const MOBILE_TABS: [string, string][] = [
  ["events", "Events"],
  ["screens", "Screens"],
  ["console", "Console"],
  ["network", "Network"],
  ["crashes", "Crashes"],
  ["perf", "Performance"],
  ["comments", "Comments"],
];

export function SharePage() {
  const { token = "" } = useParams();
  const share = useShareBundle(token);
  const reachable = useBackendReachable();

  // ── playback transport (HUD owns pos%/playing/speed; player owns its clock) ──
  const playerRef = useRef<RvPlayerHandle>(null);
  const realDurRef = useRef(0);
  const followPosRef = useRef(0);
  const scrubRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [tab, setTab] = useState("events");
  // "Skip inactivity" toggle — persisted like the reference player (localStorage,
  // shared key with the dashboard HUD). Idle ranges (0..1 fractions) come up from
  // the web player via onIdleRegions so the scrubber can dim them.
  const [skipIdle, setSkipIdle] = useState(
    () => localStorage.getItem("rv:skipIdle") === "1",
  );
  const [idleRegions, setIdleRegions] = useState<
    { from: number; to: number }[]
  >([]);
  const toggleSkipIdle = useCallback(() => setSkipIdle((v) => !v), []);
  // Persist as a side-effect of the state change — not inside the setState
  // updater (updaters must be pure; a write there double-fires under StrictMode).
  useEffect(() => {
    try {
      localStorage.setItem("rv:skipIdle", skipIdle ? "1" : "0");
    } catch {
      /* storage blocked (private mode) — toggle still works this session */
    }
  }, [skipIdle]);

  const onDuration = useCallback((sec: number) => {
    if (sec > 0) realDurRef.current = sec;
  }, []);

  // follower: player clock → scrubber pos while playing.
  useEffect(() => {
    if (!playing) return undefined;
    const dur0 = realDurRef.current;
    const cur0 = playerRef.current?.getCurrentTime() ?? 0;
    // Pressing play AT the end restarts from 0. `armed` gates end-detection until
    // that goto(0) has propagated to the player's clock — getCurrentTime() lags a
    // frame behind goto(), so without this the first step() still reads the END
    // time and immediately re-pauses (the old two-click restart). Matches RvStage.
    const startedAtEnd = dur0 > 0 && cur0 >= dur0 - 0.05;
    if (startedAtEnd) {
      playerRef.current?.goto(0);
      followPosRef.current = 0;
      setPos(0);
    }
    let armed = !startedAtEnd;
    let raf = 0;
    const step = () => {
      const dur = realDurRef.current;
      const cur = playerRef.current?.getCurrentTime() ?? 0;
      if (dur > 0) {
        if (!armed) {
          // Hold until the restart seek lands (clock drops below the end); don't
          // touch pos meanwhile so the playhead doesn't flick end → 0.
          if (cur < dur - 0.05) armed = true;
        } else {
          const pr = +Math.max(0, Math.min(100, (cur / dur) * 100)).toFixed(2);
          followPosRef.current = pr;
          setPos(pr);
          if (cur >= dur - 0.03) {
            setPlaying(false);
            return;
          }
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // control: a user-driven pos change seeks the player (skips follower echoes).
  useEffect(() => {
    if (Math.abs(pos - followPosRef.current) < 0.02) return;
    followPosRef.current = pos;
    const dur = realDurRef.current;
    if (dur > 0) playerRef.current?.goto((pos / 100) * dur);
  }, [pos]);

  const { bundle, isMobile } = share;
  const s = useMemo(
    // `true` = public surface: no end-user email reaches this page, not as
    // the second line and not as a stand-in label for a nameless user.
    () => (bundle ? adaptSession(bundle.session, true) : null),
    [bundle],
  );
  const durSec = Math.max(
    1,
    Math.round((bundle?.session.durationMs ?? 0) / 1000),
  );

  // Enabled tab set — pick the first enabled tab once the bundle resolves.
  const enabledTabs = useMemo(() => {
    if (!bundle) return [] as [string, string][];
    const order = isMobile ? MOBILE_TABS : WEB_TABS;
    return order.filter(([k]) => bundle.panels[k]);
  }, [bundle, isMobile]);
  useEffect(() => {
    if (enabledTabs.length && !enabledTabs.some(([k]) => k === tab))
      setTab(enabledTabs[0][0]);
  }, [enabledTabs]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmtT = (p: number) => {
    const tt = Math.round((p / 100) * durSec);
    return `${Math.floor(tt / 60)}:${String(tt % 60).padStart(2, "0")}`;
  };
  const seekPct = (p: number) =>
    setPos(Math.max(0, Math.min(100, +p.toFixed(2))));
  const seekSec = (sec: number) => seekPct((sec / durSec) * 100);
  const seekAt = (e: { clientX: number }) => {
    const r = scrubRef.current?.getBoundingClientRect();
    if (!r) return;
    seekPct(((e.clientX - r.left) / r.width) * 100);
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

  /* Ordered BEFORE the error branch on purpose. A resolve that never landed is
     not a bad link, but "Share link unavailable / invalid, expired, or revoked"
     is what the recipient would have been told — a flatly false accusation
     about someone else's link, on the one page where the visitor has no way to
     know better. Offline is answered as offline.

     The probe re-resolves this token rather than the app default (Auth.me): a
     public viewer has no session and should never call /v1/me. */
  if (!reachable)
    return (
      <ShareShell>
        <NetworkError probe={() => Share.resolve(token)} />
      </ShareShell>
    );
  if (share.status === "loading")
    return (
      <ShareShell>
        <CenteredMessage>Loading shared recording…</CenteredMessage>
      </ShareShell>
    );
  if (share.status === "error" || !bundle || !s) {
    return (
      <ShareShell>
        <CenteredMessage>
          <div style={{ fontSize: "var(--text-lg)", fontWeight: "var(--fw-semibold)", marginBottom: "var(--sp-8)" }}>
            Share link unavailable
          </div>
          <div style={{ color: "var(--rv-mut, #6c727c)", fontSize: "var(--text-base)" }}>
            {share.error?.message ||
              "This link is invalid, expired, or has been revoked."}
          </div>
        </CenteredMessage>
      </ShareShell>
    );
  }

  return (
    <ShareShell>
      <div className="rv-wrap" style={{ flex: 1, minHeight: 0 }}>
        <section className="rv-main" style={{ minWidth: 0 }}>
          {/* Session identity — frozen stagebar markup, no admin actions. */}
          <div className="rv-stagebar">
            <span
              className="rv-stagebar-av"
              style={{ background: rvHue(s.hueSeed) }}
            >
              {s.initials ?? "∅"}
            </span>
            <div className="rv-who">
              <div className="rv-who-line">
                <span className="nm">{s.name}</span>
                {s.plan && <span className="rv-plan">{s.plan}</span>}
              </div>
              <div className="rv-who-meta">
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--sp-4)",
                  }}
                >
                  <RvGlyph p={s.plat} size={11} />
                  {s.os}
                </span>
                {(s.flag || s.loc) && (
                  <>
                    <span className="dot">·</span>
                    <span>
                      {s.flag} {s.loc}
                    </span>
                  </>
                )}
                <span className="dot">·</span>
                <span className="mono">{s.id}</span>
              </div>
            </div>
            <span className="sp" />
            <span
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--rv-faint)",
                fontWeight: "var(--fw-medium)",
              }}
            >
              Read-only · shared recording
            </span>
          </div>

          <div className={`rv-stage ${isMobile ? "is-mobile" : "is-web"}`}>
            <div className="rv-stage-vignette" />
            <div className="rv-canvas">
              <div className="rv-screen">
                {isMobile ? (
                  <RvMobilePlayer
                    ref={playerRef}
                    batches={share.batches}
                    framesInfo={share.framesInfo}
                    playing={playing}
                    speed={speed}
                    platform={s.plat}
                    // Stay in "loading" while EITHER the events batches or the
                    // /frames descriptor is still in flight, and flag the pending
                    // descriptor — otherwise the player reads "descriptor absent"
                    // as "no archive" and flashes "No snapshots captured" before
                    // the frames land (mirrors the dashboard RvPlayer wiring).
                    loading={!share.batches || share.framesPending}
                    framesPending={share.framesPending}
                    onDuration={onDuration}
                  />
                ) : (
                  <RvWebPlayer
                    ref={playerRef}
                    batches={share.batches}
                    playing={playing}
                    speed={speed}
                    focus={false}
                    loading={!share.batches}
                    onDuration={onDuration}
                    // Pass the real wall-clock duration so totalMs = the padded
                    // session length (not just the rrweb DOM span) — otherwise
                    // the trailing idle tail isn't part of the timeline here and
                    // the skip range never forms (dashboard passes this too).
                    sessionDurationMs={bundle?.session.durationMs}
                    skipIdle={skipIdle}
                    onIdleRegions={setIdleRegions}
                  />
                )}
              </div>
            </div>

            {/* Always-visible HUD (frozen markup + the `.show` opt-in). */}
            <div className="rv-hud show">
              <div
                className="rv-scrub"
                ref={scrubRef}
                onMouseDown={onScrubDown}
              >
                <div className="rv-scrub-track" />
                {/* Inactive stretches the "Skip inactivity" toggle collapses.
                    Web only — mobile share never reports regions. */}
                {!isMobile &&
                  idleRegions.map((r, i) => (
                  <div
                    key={`idle${i}`}
                    className={`rv-scrub-idle ${skipIdle ? "on" : ""}`}
                    style={{
                      left: pct(r.from * 100),
                      width: pct((r.to - r.from) * 100),
                    }}
                  />
                ))}
                <div className="rv-scrub-fill" style={{ width: pct(pos) }} />
                <div className="rv-scrub-head" style={{ left: pct(pos) }} />
              </div>
              <div className="rv-hud-row">
                <div className="rv-hud-g">
                  <button
                    className="rv-hud-btn"
                    data-tip="Step back"
                    onClick={() => seekPct(pos - 1)}
                  >
                    <svg width="13" height="13" viewBox="0 0 14 14">
                      <path
                        d="M11.5 3 6 7l5.5 4zM4 3v8"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        fill="none"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                  <button
                    className="rv-hud-play"
                    data-tip={playing ? "Pause" : "Play"}
                    onClick={() => setPlaying((p) => !p)}
                  >
                    {playing ? (
                      <svg width="13" height="13" viewBox="0 0 13 13">
                        <rect
                          x="2.5"
                          y="1.5"
                          width="2.6"
                          height="10"
                          rx="1"
                          fill="currentColor"
                        />
                        <rect
                          x="7.9"
                          y="1.5"
                          width="2.6"
                          height="10"
                          rx="1"
                          fill="currentColor"
                        />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 13 13">
                        <path
                          d="M3.5 1.8 11 6.5 3.5 11.2z"
                          fill="currentColor"
                        />
                      </svg>
                    )}
                  </button>
                  <button
                    className="rv-hud-btn"
                    data-tip="Step forward"
                    onClick={() => seekPct(pos + 1)}
                  >
                    <svg width="13" height="13" viewBox="0 0 14 14">
                      <path
                        d="M2.5 3 8 7l-5.5 4zM10 3v8"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        fill="none"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                  <span className="rv-hud-time">
                    <b>{fmtT(pos)}</b>
                    <span className="sl">/</span>
                    {s.dur}
                  </span>
                </div>
                <span className="sp" />
                <div className="rv-hud-g">
                  <div className="rv-speed">
                    <button
                      className="rv-hud-btn wtxt"
                      data-tip="Playback speed"
                      onClick={() => setSpeedOpen((o) => !o)}
                    >
                      {speed % 1 === 0 ? speed + ".0" : speed}×
                    </button>
                    {speedOpen && (
                      <>
                        <div
                          className="rv-speed-back"
                          onClick={() => setSpeedOpen(false)}
                        />
                        <div className="rv-speed-menu">
                          {[0.25, 0.5, 1, 1.5, 2, 4].map((v) => (
                            <button
                              key={v}
                              className={v === speed ? "on" : ""}
                              onClick={() => {
                                setSpeed(v);
                                playerRef.current?.setSpeed(v);
                                setSpeedOpen(false);
                              }}
                            >
                              {v % 1 === 0 ? v + ".0" : v}×
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  {/* Skip inactivity — fast-forwards over the frameless idle
                      stretches a page leaves when it goes quiet but keeps
                      polling. Web only; mobile frames use a different model. */}
                  {!isMobile && (
                    <button
                      className={`rv-hud-btn ${skipIdle ? "on" : ""}`}
                      data-tip={
                        skipIdle ? "Skip inactivity · On" : "Skip inactivity"
                      }
                      aria-pressed={skipIdle}
                      onClick={toggleSkipIdle}
                    >
                      <svg width="13" height="13" viewBox="0 0 14 14">
                        <path
                          d="M2.5 3 8 7l-5.5 4zM9 3v8"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          fill="none"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {enabledTabs.length > 0 && (
          <aside className="rv-inspect">
            <div className="rv-insp-tabs">
              {enabledTabs.map(([k, l]) => (
                <button
                  key={k}
                  className={k === tab ? "on" : ""}
                  onClick={() => setTab(k)}
                >
                  {l}
                </button>
              ))}
            </div>
            <ShareInspector
              tab={tab}
              isMobile={isMobile}
              durSec={durSec}
              pos={pos}
              onSeekSec={seekSec}
              os={s.os}
              url={s.url}
              timeline={share.timeline}
              console={share.console}
              network={share.network}
              errors={share.errors}
              screens={share.screens}
              performance={share.performance}
            />
          </aside>
        )}
      </div>
    </ShareShell>
  );
}

/* Branded, minimal top shell — the only chrome a recipient sees. */
function ShareShell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg, #fff)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-8)",
          padding: "var(--sp-10) var(--sp-16)",
          borderBottom: "1px solid var(--rv-line, #ededee)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: "var(--r-sm)",
            background: "#5b5ceb",
            display: "grid",
            placeItems: "center",
            color: "#fff",
            fontWeight: "var(--fw-bold)",
            fontSize: "var(--text-sm)",
          }}
        >
          R
        </span>
        <span
          style={{ fontWeight: "var(--fw-semibold)", fontSize: "var(--text-base)", letterSpacing: "-.2px" }}
        >
          Replayfy
        </span>
      </header>
      {children}
    </div>
  );
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div
      style={{ flex: 1, display: "grid", placeItems: "center", padding: "var(--sp-20)" }}
    >
      <div
        style={{
          width: 380,
          maxWidth: "92%",
          padding: "var(--sp-28)",
          border: "1px solid var(--rv-line, #ededee)",
          borderRadius: "var(--r-lg)",
          textAlign: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}
