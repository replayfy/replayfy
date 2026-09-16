import { useEffect, useRef, useState } from "react";
import { MiniSpark } from "@/components/charts";
import { Icon } from "@/components/primitives";
import { useApi } from "@/api/useApi";
import { listCrashIssues, issuesToPooledCrashes } from "../crashlytics.api";
import {
  CRASH_POOL,
  CAT_META,
  type CrashCat,
  type PooledCrash,
} from "./drawers.data";

export function CrashAllList({
  onShowRecordings,
}: {
  onShowRecordings?: (c: PooledCrash) => void;
}) {
  // Real crash & error groups (behavioral excluded server-side), ranked. Falls
  // back to the demo fixture only when a workspace has none — same pattern as
  // adaptCrashes(overview) ?? CRASHES on the Stability section.
  const { data, loading } = useApi(() => listCrashIssues({ limit: 60 }), [], {
    key: "crash-issues",
  });
  const real = issuesToPooledCrashes(data);
  const allRows = real ?? CRASH_POOL;

  // Category filter — crashes vs handled exceptions vs UI freezes. Same model as
  // the Stability ledger so the two surfaces behave identically.
  const [catSel, setCatSel] = useState<CrashCat | "all">("all");
  const catOf = (c: PooledCrash): CrashCat => c.cat ?? "crash";
  const counts: Record<CrashCat | "all", number> = {
    all: allRows.length,
    crash: allRows.filter((c) => catOf(c) === "crash").length,
    exception: allRows.filter((c) => catOf(c) === "exception").length,
    freeze: allRows.filter((c) => catOf(c) === "freeze").length,
    error: allRows.filter((c) => catOf(c) === "error").length,
  };
  const rows =
    catSel === "all" ? allRows : allRows.filter((c) => catOf(c) === catSel);
  const CATS: [CrashCat | "all", string][] = [
    ["all", "All"],
    ["crash", "Crashes"],
    ["exception", "Exceptions"],
    ["freeze", "Freezes"],
  ];

  const [count, setCount] = useState(9);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (e) => {
        if (e[0].isIntersecting)
          setCount((c) => Math.min(rows.length, c + 6));
      },
      { root: el.closest(".rv-sd-body"), rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rows.length]);

  if (loading) {
    return (
      <div className="cra-list">
        <div className="cra-more">
          <span className="rd-spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className="cra-list">
      <div className="cra-catbar" role="tablist" aria-label="Crash category">
        <div className="ox-catseg">
          {CATS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={catSel === id}
              className={catSel === id ? "on" : ""}
              onClick={() => setCatSel(id)}
            >
              {id !== "all" && (
                <span className="d" style={{ background: CAT_META[id].color }} />
              )}
              {label}
              <span className="n">{counts[id]}</span>
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 && (
        <div className="cra-empty">
          No {catSel === "all" ? "crashes" : CAT_META[catSel].plural.toLowerCase()}{" "}
          in this window.
        </div>
      )}
      {rows.slice(0, count).map((c) => (
        <div className="cra-row" key={c._id}>
          <div className="cra-top">
            {/* Category leads (the kind of failure); severity trails, muted. */}
            <span className="cra-cat" style={{ color: CAT_META[catOf(c)].color }}>
              <span
                className="pip"
                style={{ background: CAT_META[catOf(c)].color }}
              />
              {CAT_META[catOf(c)].label}
            </span>
            <span className="cra-sevsm">{c.sev}</span>
            <span className="cra-plat">{c.p}</span>
            <span style={{ flex: 1 }} />
            {/* Trend spark + period delta only exist on the demo fixture; the
                deterministic list read carries neither, so they're omitted
                rather than fabricated. */}
            {c.sp.length > 0 && (
              <MiniSpark
                data={c.sp}
                color={c.down ? "var(--green)" : "var(--red)"}
                w={52}
                h={20}
              />
            )}
            <span className="cra-c">
              {c.c}
              <small>×</small>
            </span>
            {c.d && (
              <span
                className="cra-d"
                style={{ color: c.down ? "var(--green)" : "var(--red)" }}
              >
                {c.down ? "▼" : "▲"}
                {c.d.replace(/[+−]/, "")}
              </span>
            )}
          </div>
          <div className="cra-n">{c.n}</div>
          <div className="cra-s">{c.s}</div>
          <div className="cra-foot">
            <span className="cra-meta">
              {c.users} users · {c.rec} recordings
            </span>
            <span style={{ flex: 1 }} />
            <button
              className="cra-btn"
              onClick={() => onShowRecordings && onShowRecordings(c)}
            >
              <Icon name="play" size={11} fill /> Show recordings
            </button>
          </div>
        </div>
      ))}
      {count < rows.length && (
        <div ref={sentinel} className="cra-more">
          <span className="rd-spinner" />
        </div>
      )}
    </div>
  );
}
