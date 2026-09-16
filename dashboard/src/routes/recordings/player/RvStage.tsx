/* ---------- Center: replay stage (stagebar + canvas + hover HUD) ---------- */
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  RefObject,
  SetStateAction,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/primitives";
import { RvGlyph, Step } from "../glyphs";
import { rvHue, pct } from "../helpers";
import { RvPlayer } from "./RvPlayer";
import { CreateIssueModal } from "../share/CreateIssueModal";
import { AddToPlaylistModal } from "../share/AddToPlaylistModal";
import type { RvPlayerHandle, RvTick } from "./playerTypes";
import { type RvSession } from "../recordings.data";
import { setHoverKey, useHoverKey } from "./hoverSync";

/* Stagebar toolbar icons — one Lucide family (24 grid, 2px round stroke), kept
   LOCAL so the global 16-grid `Icon` used across the app is untouched. Same
   system the share modal uses, so the two toolbars draw from one set. */

/** Hovered-marker state: the tick plus its on-screen anchor (viewport px) and
 *  scrubber percent, so the tooltip can position itself and its CTA can seek. */
type TipState = { tk: RvTick; x: number; y: number; p: number };

/** The enterprise event tooltip — portalled to <body>, positioned above the
 *  marker. AI-insight markers get a richer body (summary + bullet lines). The
 *  tooltip stays open while hovered (hover-bridge) so its CTA is clickable. */
function RvTickTip({
  tip,
  onKeep,
  onLeave,
  onOpen,
}: {
  tip: TipState;
  onKeep: () => void;
  onLeave: () => void;
  onOpen: () => void;
}) {
  const { tk, x, y } = tip;
  const isAi = tk.tone === "ai";
  return createPortal(
    <div
      className={`rv-tiptip rv-tt-${tk.tone}`}
      style={{ left: x, top: y }}
      role="tooltip"
      onMouseEnter={onKeep}
      onMouseLeave={onLeave}
    >
      <div className="rv-tt-eyebrow">
        <span className="rv-tt-dot" />
        <span className="rv-tt-kind">{tk.kind ?? "Event"}</span>
        {tk.time && <span className="rv-tt-time">{tk.time}</span>}
      </div>
      {tk.primary && <div className="rv-tt-head">{tk.primary}</div>}
      {isAi && tk.detail && tk.detail.length > 0 && (
        <ul className="rv-tt-list">
          {tk.detail.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
      {!isAi && tk.meta && <div className="rv-tt-meta">{tk.meta}</div>}
      <button className="rv-tt-cta" onClick={onOpen}>
        {isAi ? "Open investigation" : "Open event"}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </div>,
    document.body,
  );
}

type RvStageProps = {
  s: RvSession;
  idx: number;
  sessions: RvSession[];
  isMobile: boolean;
  theatre: boolean;
  setTheatre: Dispatch<SetStateAction<boolean>>;
  annotate: boolean;
  setAnnotate: Dispatch<SetStateAction<boolean>>;
  pos: number;
  setPos: Dispatch<SetStateAction<number>>;
  playing: boolean;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  speed: number;
  setSpeed: Dispatch<SetStateAction<number>>;
  speedOpen: boolean;
  setSpeedOpen: Dispatch<SetStateAction<boolean>>;
  bookmarks: number[];
  scrubRef: RefObject<HTMLDivElement>;
  onScrubDown: (e: ReactMouseEvent<HTMLDivElement>) => void;
  fmtT: (p: number) => string;
  /** Session length in seconds — the player's real duration once it reports. */
  durSec: number;
  /** Real session events, marked on the scrubber. */
  ticks: RvTick[];
  /** The recording reached its end on its own (not a pause or a seek). */
  onEnded?: () => void;
  /** Lifts the player's real duration to the page, so the clock and the
   *  timeline read the same seconds the player is actually playing. */
  onRealDuration: (sec: number) => void;
  addBookmark: () => void;
  setCur: (id: string) => void;
  setShareOpen: (v: boolean) => void;
};

export function RvStage(props: RvStageProps) {
  const {
    s,
    idx,
    sessions,
    isMobile,
    theatre,
    setTheatre,
    annotate,
    setAnnotate,
    pos,
    setPos,
    playing,
    setPlaying,
    speed,
    setSpeed,
    speedOpen,
    setSpeedOpen,
    bookmarks,
    scrubRef,
    onScrubDown,
    fmtT,
    durSec,
    ticks,
    onEnded,
    onRealDuration,
    addBookmark,
    setCur,
    setShareOpen,
  } = props;

  /* ── HUD ⇄ player clock bridge ────────────────────────────────────────────
     The frozen HUD owns pos (0–100 %), playing, and speed. The real player
     owns its own clock and reports its real duration (rrweb metadata / last
     mobile frame) via onDuration. We bridge in both directions:
       • follower: while playing, a rAF reads getCurrentTime() and writes pos%.
       • control : a *user* pos change (scrub / arrows / panel seek) seeks the
                   player via goto(pos/100 · realDuration). The follower's own
                   writes are ignored by comparing against followPosRef.
     playing/speed reach the concrete players as props (web internal effects /
     mobile rAF gate), so they need no imperative call here. */
  const playerRef = useRef<RvPlayerHandle>(null);
  const [issueOpen, setIssueOpen] = useState(false); // Create-issue integration picker
  const [playlistOpen, setPlaylistOpen] = useState(false); // Add-to-playlist picker
  // "Skip inactivity" toggle — persisted across sessions like the reference
  // player (localStorage). When on, the web player's master clock fast-forwards
  // over idle ranges; those ranges (0..1 fractions of the timeline) are reported
  // UP from the player via onIdleRegions so the scrubber can dim them.
  const [skipIdle, setSkipIdle] = useState(
    () => localStorage.getItem("rv:skipIdle") === "1",
  );
  const [idleRegions, setIdleRegions] = useState<
    { from: number; to: number }[]
  >([]);
  const toggleSkipIdle = useCallback(() => setSkipIdle((v) => !v), []);
  // Persist as a side-effect of the state change — NOT inside the setState
  // updater (an updater must be pure; a write there is double-invoked under
  // StrictMode and races rapid toggles). Idempotent write on mount is harmless.
  useEffect(() => {
    try {
      localStorage.setItem("rv:skipIdle", skipIdle ? "1" : "0");
    } catch {
      /* storage blocked (private mode) — toggle still works this session */
    }
  }, [skipIdle]);
  // Hovered marker → the enterprise tooltip. Hover-bridged: a short close delay
  // the tooltip itself cancels, so the cursor can travel marker → tooltip and
  // click its CTA without the tooltip vanishing underneath it.
  const [tip, setTip] = useState<TipState | null>(null);
  const tipClear = useRef<number | undefined>(undefined);
  const showTip = useCallback((t: TipState) => {
    window.clearTimeout(tipClear.current);
    setTip(t);
  }, []);
  const hideTip = useCallback(() => {
    // Generous close delay so the cursor can travel the gap from the marker up
    // to the tooltip (which then cancels this via keepTip) without it vanishing.
    tipClear.current = window.setTimeout(() => setTip(null), 260);
  }, []);
  const keepTip = useCallback(() => window.clearTimeout(tipClear.current), []);
  // Cross-highlight: which event is hovered anywhere (this timeline OR the
  // Events list). A marker whose key matches lights up, mirroring the row.
  const hoverKey = useHoverKey();
  const realDurRef = useRef(0); // real duration (seconds) from the player
  const followPosRef = useRef(pos); // last pos the follower wrote (self-update guard)
  // A user seek that arrived before the player knew its duration, held until it
  // does. pos is a PERCENTAGE, so it cannot be turned into a seek time without
  // one; dropping it (what the control effect used to do) lost the seek for
  // good, because followPosRef had already recorded it as applied.
  const pendingSeekRef = useRef<number | null>(null);
  // RvStage does NOT remount per session (only the concrete player does, via its
  // key), so realDurRef would otherwise still hold the PREVIOUS recording's
  // length while the new one loads — and every seconds-from-percent conversion
  // in here would silently use it. 0 is the honest value for "the new player
  // hasn't reported yet"; the control effect then holds seeks instead of
  // aiming them at the wrong session's timeline.
  useEffect(() => {
    realDurRef.current = 0;
    pendingSeekRef.current = null;
    // RvStage does NOT remount per session (only the concrete player does), so
    // the previous session's idle bands would linger — and leak onto a mobile
    // session's scrubber (RvMobilePlayer never reports regions). Clear them; the
    // new web player republishes its own on mount.
    setIdleRegions([]);
  }, [s.id]);
  // Kept in a ref: the follower effect only re-subscribes on `playing`, so a
  // captured callback would go stale as the selected session changes.
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);
  const onDuration = useCallback(
    (sec: number) => {
      if (sec > 0) {
        realDurRef.current = sec;
        onRealDuration(sec);
        // Now that seconds mean something, issue the seek we had to hold.
        const held = pendingSeekRef.current;
        if (held != null) {
          pendingSeekRef.current = null;
          playerRef.current?.goto((held / 100) * sec);
        }
      }
    },
    [onRealDuration],
  );

  // follower: player clock → scrubber pos while playing (also restarts from 0
  // when play is pressed at the very end).
  useEffect(() => {
    if (!playing) return undefined;
    const dur0 = realDurRef.current;
    const cur0 = playerRef.current?.getCurrentTime() ?? 0;
    // Pressing play AT the end restarts from 0. `armed` then gates end-detection
    // until that goto(0) has actually propagated to the player's clock: the
    // mobile clock lags a frame behind goto(), so without this the first step()
    // still reads the END time and immediately re-pauses — which is why it took
    // a SECOND click to actually start playing again.
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
          // Hold until the restart seek lands (clock drops below the end). Don't
          // touch pos meanwhile, so the playhead doesn't flick end → 0.
          if (cur < dur - 0.05) armed = true;
        } else {
          // Clamp low too: rrweb's getCurrentTime() reads negative until the
          // replayer's baseline starts, which drove the clock negative.
          const p = Math.max(0, Math.min(100, (cur / dur) * 100));
          const pr = +p.toFixed(2);
          followPosRef.current = pr;
          setPos(pr);
          if (cur >= dur - 0.03) {
            setPlaying(false);
            // Played to the end under its own steam — the only place "the
            // recording finished" is knowable (a pause or seek never lands here).
            onEndedRef.current?.();
            return;
          }
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // control: a user-driven pos change seeks the player (skips follower echoes).
  useEffect(() => {
    if (Math.abs(pos - followPosRef.current) < 0.02) return;
    followPosRef.current = pos;
    const dur = realDurRef.current;
    // Hold, don't drop: scrubbing while the player is still working out its
    // duration used to move the scrubber and the clock (both read `pos`) while
    // the player itself stayed put — the seek was silently discarded and never
    // retried. onDuration flushes this the moment the duration lands.
    if (dur > 0) playerRef.current?.goto((pos / 100) * dur);
    else pendingSeekRef.current = pos;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  return (
    <section className="rv-main">
      <div className="rv-stagebar">
        <span className="rv-stagebar-av" style={{ background: rvHue(s.hueSeed) }}>
          {/* Stored initials are derived from `name` only, so an email-only user
              has none — the resolver falls back to the address's local part
              rather than leaving this chip blank. The identify() avatar image
              overlays the initials when present; onError reveals them again. */}
          {s.initials ?? "∅"}
          {s.picture && (
            <img
              className="rv-stagebar-av-img"
              src={s.picture}
              alt=""
              referrerPolicy="no-referrer"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          )}
        </span>
        <div className="rv-who">
          <div className="rv-who-line">
            <span className="nm">{s.name}</span>
            {s.plan && <span className="rv-plan">{s.plan}</span>}
          </div>
          <div className="rv-who-meta">
            {/* The header has the room the 272px rail doesn't, so the address
                shows in full here. */}
            {s.sub && (
              <>
                <span>{s.sub}</span>
                <span className="dot">·</span>
              </>
            )}
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-4)" }}
            >
              <RvGlyph p={s.plat} size={11} />
              {s.os}
            </span>
            {(s.flag || s.loc) && (
              <>
                <span className="dot">·</span>
                <span>
                  {[s.flag, s.loc].filter(Boolean).join(" ")}
                </span>
              </>
            )}
            <span className="dot">·</span>
            <span>{s.id}</span>
          </div>
        </div>
        <span className="sp" />
        <div className="rv-acts">
          <div
            className="rv-navpill"
            role="group"
            aria-label="Session navigation"
          >
            <button
              className="rv-ico"
              data-tip="Previous · ["
              disabled={idx === 0}
              onClick={() => idx > 0 && setCur(sessions[idx - 1].id)}
            >
              <Icon name="chevL" size={14} strokeWidth={2.9} />
            </button>
            <button
              className="rv-ico"
              data-tip="Next · ]"
              disabled={idx === sessions.length - 1}
              onClick={() =>
                idx < sessions.length - 1 && setCur(sessions[idx + 1].id)
              }
            >
              <Icon name="chevR" size={14} strokeWidth={2.9} />
            </button>
          </div>
          {/* View / quick-action pill: focus toggle, add-to-playlist, and Share
              — Share is icon-only now, its data-tip names it. Grouped away from
              the one labelled action on the right. */}
          <div className="rv-navpill" role="group" aria-label="View and share">
            <button
              className={`rv-ico ${theatre ? "on" : ""}`}
              data-tip="Focus · F"
              onClick={() => setTheatre((t) => !t)}
            >
              <Icon name="focus" size={14} strokeWidth={2.9} />
            </button>
            <button
              className="rv-ico"
              data-tip="Add to playlist"
              onClick={() => setPlaylistOpen(true)}
            >
              <Icon name="listplus" size={14} strokeWidth={2.9} />
            </button>
            <button
              className="rv-ico"
              data-tip="Share"
              onClick={() => setShareOpen(true)}
            >
              <Icon name="share" size={14} strokeWidth={2.9} />
            </button>
          </div>
          {/* The stagebar's single labelled action. `data-tip` is kept only for
              the narrow width where the label collapses to an icon; CSS
              suppresses the (redundant) tooltip while the label is visible. */}
          <button
            className="rv-issue"
            data-tip="Create issue"
            onClick={() => setIssueOpen(true)}
          >
            <Icon name="issue" size={13} strokeWidth={2.9} />
            <span className="rv-lbl">Create issue</span>
          </button>
          <CreateIssueModal
            open={issueOpen}
            sessionPublicId={s.id}
            onClose={() => setIssueOpen(false)}
          />
          <AddToPlaylistModal
            open={playlistOpen}
            sessionPublicId={s.id}
            onClose={() => setPlaylistOpen(false)}
          />
        </div>
      </div>

      <div
        className={`rv-stage ${annotate ? "anno" : ""} ${isMobile ? "is-mobile" : "is-web"}`}
      >
        <div className="rv-stage-vignette" />
        <div className="rv-canvas">
          <div className="rv-screen">
            {/* Real playback: rrweb Replayer in a Safari-style window (web) /
                frames archive in a fitted device frame (mobile), fetched from
                GET /v1/sessions/:id/events (+ /frames for mobile). A frameless
                session shows the reference empty-state inside the player itself
                (never a fabricated mock), so the bezel never blanks. */}
            <RvPlayer
              ref={playerRef}
              s={s}
              isMobile={isMobile}
              focus={theatre}
              playing={playing}
              speed={speed}
              onDuration={onDuration}
              skipIdle={skipIdle}
              onIdleRegions={setIdleRegions}
            />
          </div>
        </div>

        {/* hover-reveal pro HUD (fades in only when the cursor is on the player) */}
        <div className="rv-hud">
          <div className="rv-scrub" ref={scrubRef} onMouseDown={onScrubDown}>
            <div className="rv-scrub-track" />
            {/* Inactive stretches the "Skip inactivity" toggle collapses —
                dimmed on the track, brighter once the toggle is armed, mirroring
                the reference player's inactive regions. Web only (mobile frames
                use a different idle model + never report regions). */}
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
            <div
              className="rv-scrub-buffer"
              style={{ width: pct(Math.min(100, pos + 22)) }}
            />
            <div className="rv-scrub-fill" style={{ width: pct(pos) }} />
            {/* Real session events, marked where they happened. Hovering names
                the event; clicking seeks to it (stopPropagation so the click
                doesn't also scrub to the raw cursor x). */}
            {durSec > 0 &&
              ticks.map((tk, i) => {
                const p = (tk.sec / durSec) * 100;
                if (!(p >= 0 && p <= 100)) return null;
                return (
                  <span
                    key={`${tk.sec}-${i}`}
                    /* `rv-tk-` prefix, not the bare tone: the tone names are
                       generic words and `.nav` is already the app's sidebar
                       rule in styles.css (padding:6px 8px 2px; display:flex).
                       A bare `nav` tick inherited that 16px of padding and,
                       being border-box, rendered as a 16px green slab instead
                       of a 2px mark. `data-w` drives the attention hierarchy. */
                    className={`rv-tick rv-tk-${tk.tone} ${
                      tk.key != null && tk.key === hoverKey ? "hot" : ""
                    }`}
                    data-w={tk.weight ?? "low"}
                    style={{ left: pct(p) }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseEnter={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      showTip({ tk, x: r.left + r.width / 2, y: r.top, p });
                      setHoverKey(tk.key ?? null);
                    }}
                    onMouseLeave={() => {
                      hideTip();
                      setHoverKey(null);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPos(+p.toFixed(2));
                    }}
                  />
                );
              })}
            {bookmarks.map((b) => (
              <span
                key={b}
                className="rv-scrub-bm"
                style={{ left: pct(b) }}
                title={`Bookmark ${fmtT(b)}`}
              />
            ))}
            <div className="rv-scrub-head" style={{ left: pct(pos) }} />
          </div>
          <div className="rv-hud-row">
            <div className="rv-hud-g">
              <button
                className="rv-hud-btn"
                data-tip="Step back · ←"
                onClick={() => setPos((p) => Math.max(0, p - 1))}
              >
                <Step dir="b" />
              </button>
              <button
                className="rv-hud-play"
                data-tip={playing ? "Pause · Space" : "Play · Space"}
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
                    <path d="M3.5 1.8 11 6.5 3.5 11.2z" fill="currentColor" />
                  </svg>
                )}
              </button>
              <button
                className="rv-hud-btn"
                data-tip="Step forward · →"
                onClick={() => setPos((p) => Math.min(100, p + 1))}
              >
                <Step dir="f" />
              </button>
              <span className="rv-hud-time">
                <b>{fmtT(pos)}</b>
                <span className="sl">/</span>
                {fmtT(100)}
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
              {/* Skip inactivity — fast-forwards over idle stretches (the
                  frameless "nothing happening" tail a page leaves when it goes
                  quiet but keeps polling). Web only for now; mobile frames use a
                  different idle model. */}
              {!isMobile && (
                <button
                  className={`rv-hud-btn ${skipIdle ? "on" : ""}`}
                  data-tip={skipIdle ? "Skip inactivity · On" : "Skip inactivity"}
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
              {/* Bookmark + annotate HUD controls removed for now — commented,
                  not deleted, so they're a one-line restore. The bookmark "B"
                  keyboard shortcut is likewise disabled in Recordings.tsx. */}
              {/*
              <span className="rv-hud-div" />
              <button
                className="rv-hud-btn"
                data-tip="Add bookmark · B"
                onClick={addBookmark}
              >
                <svg width="13" height="13" viewBox="0 0 14 14">
                  <path d="M3.5 2h7v10l-3.5-2.4L3.5 12z" fill="currentColor" />
                </svg>
              </button>
              <button
                className={`rv-hud-btn ${annotate ? "on" : ""}`}
                data-tip="Annotate frame"
                onClick={() => setAnnotate((a) => !a)}
              >
                <svg width="13" height="13" viewBox="0 0 14 14">
                  <path
                    d="M9.5 2.5 11.5 4.5 5 11l-2.6.6L3 9z"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    fill="none"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              */}
              <span className="rv-hud-div" />
              <button
                className="rv-hud-btn"
                data-tip="Focus mode"
                onClick={() => setTheatre((t) => !t)}
              >
                <svg width="13" height="13" viewBox="0 0 14 14">
                  <path
                    d="M2 5V2.5h2.5M12 5V2.5H9.5M2 9v2.5h2.5M12 9v2.5H9.5"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    fill="none"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      {tip && (
        <RvTickTip
          tip={tip}
          onKeep={keepTip}
          onLeave={hideTip}
          onOpen={() => {
            setPos(+tip.p.toFixed(2));
            setTip(null);
          }}
        />
      )}
    </section>
  );
}
