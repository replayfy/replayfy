import { useEffect } from "react";
import { rvHue } from "@/routes/recordings/helpers";
import { NavLink } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import { Icon } from "@/components/primitives";
import { Sk } from "@/components/feedback";
import { Playlists } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import type { Playlist } from "./nav.data";

type PlaylistsFlyoutProps = { open: boolean; onClose: () => void };

/* The library while it resolves. Eight rows — the shortlist you just clicked
   "See all" from, so the panel opens at no less than the height it came from.

   The rows are <a>, like the real ones, and that is load-bearing rather than
   incidental: a playlist row's geometry comes from `.nav a` (padding 6px 8px,
   gap 10px, 13px/510 — measured), which OUTRANKS the `.nav-sm` on the row. A
   div or span here would collect only `.nav-sm`'s 5px/10px and land 10px short,
   so the list would visibly jolt as the real rows replaced it. Same reason the
   list itself is a real `.nav` (see below).

   They carry no href, so they are not focusable, and pointer-events are off so
   `.nav a:hover` can't offer a highlight on a row that isn't there yet. */
function PlaylistsSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <a key={i} className="nav-sm" aria-hidden="true" style={{ pointerEvents: "none" }}>
          {/* 7×7 r2 — the real `.d` dot's measured box. */}
          <Sk w={7} h={7} r={2} style={{ flexShrink: 0 }} />
          {/* 1.5em is the row's OWN line box (its 13px against the inherited
              1.5), so the row keeps its 31.5px whatever the ramp does to the
              font — a hardcoded height would drift the next time it changes. */}
          <span
            style={{
              display: "flex",
              alignItems: "center",
              height: "1.5em",
              flex: 1,
              minWidth: 0,
            }}
          >
            {/* Deterministic, so titles read as a list rather than a stack of
                identical bars, and don't reshuffle on re-render. */}
            <Sk h={9} w={`${52 + ((i * 17) % 34)}%`} />
          </span>
        </a>
      ))}
    </>
  );
}

/* ============================================================================
   PlaylistsFlyout — the sidebar's "See all" panel.

   A SECOND nav that slides out flush against the main one and floats OVER the
   page, so the workspace never reflows (a resizing main column on every peek
   would be far more disruptive than the panel itself). The main nav's own
   border-right is the divider between the two.

   The list is a real `.nav`, not a div — a playlist row's type comes from
   `.nav a` (13px/480, and 510 under the type ramp), which OUTRANKS the
   `.nav-sm` on the row itself. Outside a `.nav` those rules drop and the rows
   silently fall back to `.nav-sm`'s 12.5px/400. Carrying the class over is what
   makes them identical here and in the sidebar; copying the numbers across
   would only hold until `.nav a` next changed.

   The only new surface is the panel itself, one tonal step between the nav
   (#F3F2EE) and the white page, so the three layers read as nav → panel →
   content.
   ========================================================================== */
export function PlaylistsFlyout({ open, onClose }: PlaylistsFlyoutProps) {
  const reduce = useReducedMotion();
  // The full library — fetched only while the panel is open, so the sidebar's
  // cheap 8-row read stays the cost of a normal page load.
  const { data, loading } = useApi<Playlist[]>(
    () => Playlists.list<Playlist[]>({ limit: 200 }),
    [],
    { enabled: open, key: "playlists-all" },
  );
  const all = data ?? [];
  /* Safe to read `loading` raw ONLY because this is inside `open`: the query is
     `enabled: open`, and a disabled query stays `isPending` forever — it has no
     data because nobody asked for any. Gated any higher, the panel would shimmer
     for eternity while closed. Reopening is warm (the key is stable and the
     cache survives), so the skeleton is the first open only. */
  const busy = loading;

  // Esc closes, matching every other overlay in the app.
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open, onClose]);

  return (
    <>
      {/* Click-anywhere-else to dismiss. Transparent: the panel is a peek, not a
          modal — dimming the page would overstate it. Deliberately OUTSIDE
          AnimatePresence: it has nothing to animate, and AnimatePresence tracks
          exits per keyed motion child — handing it a Fragment wrapping two
          elements makes it lose track of the exit and strand the panel open. */}
      {open && <div className="pl-fly-catch" onClick={onClose} />}
      {/* Deliberately NOT AnimatePresence. It ran the exit to completion but
          never unmounted the node, stranding an invisible 212px column with
          pointer-events:auto over the page that silently ate every click in
          that strip. An entrance-only animation costs one closing frame and
          removes that whole failure mode — the panel is a peek, and nobody
          misses 240ms of fade on the way out. */}
      {open && (
        <motion.aside
          className="pl-fly"
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: -14 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
        >
            <div className="pl-fly-h">
              <span>All playlists</span>
              <button
                className="pl-fly-x"
                onClick={onClose}
                title="Close"
                aria-label="Close all playlists"
              >
                <Icon name="x" size={13} />
              </button>
            </div>
            <nav
              className="nav pl-fly-list"
              aria-label="All playlists"
              aria-busy={busy || undefined}
            >
              {busy ? (
                <PlaylistsSkeleton />
              ) : (
                all.map((p) => (
                  <NavLink
                    key={p.id}
                    to={`/recordings?playlist=${p.id}`}
                    className="nav-sm"
                    onClick={onClose}
                  >
                    {/* Same hash as the sidebar's shortlist — a playlist keeps
                        its colour whether you see it in the nav or in here. */}
                    <span className="d" style={{ background: rvHue(p.title) }} />
                    {/* Same wrap as the sidebar shortlist — see Sidebar.tsx. */}
                    <span className="lbl" title={p.title}>
                      {p.title}
                    </span>
                  </NavLink>
                ))
              )}
            </nav>
          </motion.aside>
      )}
    </>
  );
}
