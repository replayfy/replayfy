import { useState } from "react";
import { Icon } from "@/components/primitives";
import { type Crash, type Release } from "../overview.data";
import { CAT_META, type CrashCat } from "../drawers/drawers.data";
import { SkCrashRows, SkStabNums, SkText } from "./OverviewSkeletons";

/* ============================================================================
   StabilitySection — four typeset numbers, a per-day density strip (hover
   reads out every tracked signal), then two ledgers: the top crash groups
   and the release history. AI mode annotates the correlated release.
   ========================================================================== */

type StabilitySectionProps = {
  ai: boolean;
  stats: [string, string, string, string][]; // [label, value, delta, tone]
  crashes: Crash[];
  crashHeadline: string; // e.g. "312 ▲ 18%"
  /** A crash ROW click → open the "All crashes" list drawer (unchanged). */
  onAllCrashes: () => void;
  /** The header "All crashes →" link → open the full Crashlytics page. */
  onOpenCrashlytics: () => void;
  /** Real Release Intelligence rows. Empty/null → "No release captured yet". */
  releases?: Release[] | null;
  /** /releases is still in flight — show a loading line, not the empty state. */
  releasesLoading?: boolean;
  /** /metrics (the numbers row + the headline count) is still in flight. */
  statsLoading?: boolean;
  /** /overview (the crash ledger) is still in flight. The two reads resolve
   *  independently, so each half of this section shimmers on its own. */
  crashesLoading?: boolean;
};

export function StabilitySection({
  ai,
  stats,
  crashes,
  crashHeadline,
  onAllCrashes,
  onOpenCrashlytics,
  releases: releasesData,
  releasesLoading,
  statsLoading,
  crashesLoading,
}: StabilitySectionProps) {
  // Real Release Intelligence only — a workspace with no tagged releases shows
  // an explicit empty state rather than a demo fixture.
  const releases: Release[] = releasesData ?? [];

  // Category filter for the crash ledger — surfaces handled exceptions and UI
  // freezes as first-class kinds instead of lumping everything under "crashes".
  // Counts are over the fetched top groups (a summary ledger, not the full
  // index), so they read as "in the top crash groups".
  const [catSel, setCatSel] = useState<CrashCat | "all">("all");
  const catOf = (c: Crash): CrashCat => c.cat ?? "crash";
  const counts: Record<CrashCat | "all", number> = {
    all: crashes.length,
    crash: crashes.filter((c) => catOf(c) === "crash").length,
    exception: crashes.filter((c) => catOf(c) === "exception").length,
    freeze: crashes.filter((c) => catOf(c) === "freeze").length,
    error: crashes.filter((c) => catOf(c) === "error").length,
  };
  const shown =
    catSel === "all" ? crashes : crashes.filter((c) => catOf(c) === catSel);
  // Only crash / exception / freeze get a chip; plain non-fatal 'error' groups
  // still appear under "All" but don't warrant their own tab on the homepage.
  const CATS: [CrashCat | "all", string][] = [
    ["all", "All"],
    ["crash", "Crashes"],
    ["exception", "Exceptions"],
    ["freeze", "Freezes"],
  ];
  return (
    <section className="ox-sec" aria-label="Stability">
      <div className="ox-sec-h">
        <span className="t">Stability</span>
        <span className="m">
          crashes, exceptions &amp; freezes · all platforms ·{" "}
          {statsLoading ? (
            <SkText w={62} />
          ) : (
            <span className="ox-num">{crashHeadline}</span>
          )}{" "}
          this period
        </span>
        <span className="sp" />
        <button className="ox-link" onClick={onOpenCrashlytics}>
          All crashes <Icon name="arrowR" size={11} />
        </button>
      </div>

      {statsLoading ? (
        <SkStabNums labels={stats.map(([k]) => k)} />
      ) : (
        <div className="ox-stab-nums">
          {stats.map(([k, v, d, tone]) => (
            <div className="ox-snum" key={k}>
              <span className="k">{k}</span>
              <span className="v">
                {v}
                {/* the arrow reports which way the number moved; the color says if that's good.
                    "—" (no baseline to compare against) shows no arrow at all. */}
                <span className={`ox-tr ${tone}`}>
                  {d === "—" ? (
                    d
                  ) : (
                    <>
                      <span className="ar">{d.startsWith("+") ? "▲" : "▼"}</span>
                      {d.replace(/^[+−-]/, "")}
                    </>
                  )}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* The per-day crash-density chart now lives ONLY on the Crashlytics page
          (owner req 2026-08-13) — the homepage keeps the numbers row + ranked
          ledger, and "All crashes →" opens the full trend on /crashlytics. */}

      {/* Releases column commented out (owner req 2026-07-30) — data broken;
          Top crashes takes the full width until it's restored. */}
      <div className="ox-stab-cols" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
        <div>
          <div className="ox-subh ox-cathead">
            {/* Category filter — crashes vs handled exceptions vs UI freezes.
                Each chip carries its live count; the dot is the one colour that
                category is allowed to use (matches the recordings Crashes tab). */}
            <div className="ox-catseg" role="tablist" aria-label="Crash category">
              {CATS.map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={catSel === id}
                  className={catSel === id ? "on" : ""}
                  onClick={() => setCatSel(id)}
                >
                  {id !== "all" && (
                    <span
                      className="d"
                      style={{ background: CAT_META[id].color }}
                    />
                  )}
                  {label}
                  <span className="n">{counts[id]}</span>
                </button>
              ))}
            </div>
            <span className="sp" />
            <span
              className="ox-num"
              style={{ letterSpacing: 0, textTransform: "none" }}
            >
              {crashesLoading ? <SkText w={54} h={7} /> : `${shown.length} groups`}
            </span>
          </div>
          {crashesLoading && <SkCrashRows />}
          {!crashesLoading && shown.length === 0 && (
            <div className="ox-none" style={{ marginTop: "var(--sp-12)" }}>
              <Icon name="check" size={14} /> No{" "}
              {catSel === "all"
                ? "crashes"
                : CAT_META[catSel].plural.toLowerCase()}{" "}
              in this window.
            </div>
          )}
          {!crashesLoading &&
            shown.slice(0, 5).map((c) => (
              <button
                className="ox-crash"
                key={`${c.cat ?? "crash"}:${c.n}:${c.p}`}
                onClick={onAllCrashes}
                title={`Open ${CAT_META[catOf(c)].label.toLowerCase()} group`}
              >
                <span
                  className="catdot"
                  style={{ background: CAT_META[catOf(c)].color }}
                  aria-label={CAT_META[catOf(c)].label}
                />
                <span className="nm">
                  <span className="n" style={{ display: "block" }}>
                    {c.n}
                  </span>
                  <span className="s" style={{ display: "block" }}>
                    {c.s}
                  </span>
                  <span className="p" style={{ display: "block" }}>
                    {c.p}
                  </span>
                </span>
                {/* Real (deterministic) crash groups carry no period delta —
                    show the trend chip only when one exists (demo fixture). */}
                {c.d ? (
                  <span className={`ox-tr ${c.down ? "up" : "down"} tr-cell`}>
                    <span className="ar">{c.down ? "▼" : "▲"}</span>
                    {c.d.replace(/[+−]/, "")}
                  </span>
                ) : (
                  <span className="tr-cell" />
                )}
                <span className="c">{c.c}</span>
              </button>
            ))}
        </div>
        {false && (
        <div>
          <div className="ox-subh">
            Releases
            <span className="sp" />
          </div>
          {releases.length > 0 ? (
            releases.map((r) => (
              <div className={"ox-rel" + (r.bad ? " bad" : "")} key={r.v}>
                <span className="v">{r.v}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="w">
                    {r.date} · {r.ago}
                  </span>
                  <span className="note" style={{ display: "block" }}>
                    {r.note}
                  </span>
                  {ai && r.corr && (
                    <span className="corr">
                      <Icon name="spark" size={10} fill /> {r.corr}
                    </span>
                  )}
                </span>
              </div>
            ))
          ) : (
            <div
              className="ox-rel-empty"
              style={{ padding: "var(--sp-12) var(--sp-2)", fontSize: "var(--text-sm)", color: "var(--t3)" }}
            >
              {releasesLoading
                ? "Loading releases…"
                : "No release captured yet"}
            </div>
          )}
        </div>
        )}
      </div>
    </section>
  );
}
