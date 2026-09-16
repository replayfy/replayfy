import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { useApi } from "@/api/useApi";
import { relTime } from "@/lib/format";
import {
  getCrashIssue,
  setIssueStatus,
  type CrashIssue,
} from "../overview/crashlytics.api";
import { CAT_META, CAT_ICON, crashCatOf } from "../overview/drawers/drawers.data";

/* ============================================================================
   CrashDrawer — the wide investigation slide-over for one crash group. Flat,
   no AI. Renders instantly from the list row (header / stats / 14-day trend),
   then fills the occurrences and the representative stack trace from the detail
   read. Reuses the app's stat / tag / cond / .co-ic vocabulary.
   ========================================================================== */

function statusTag(s: CrashIssue["status"]) {
  if (s === "REGRESSED") return <span className="tag err">Regressed</span>;
  if (s === "RESOLVED") return <span className="tag ok">Resolved</span>;
  if (s === "IGNORED") return <span className="tag">Ignored</span>;
  return <span className="tag info">Open</span>;
}

function Stat({ l, v, small }: { l: string; v: string; small?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-l">{l}</div>
      <div
        className="stat-v"
        style={small ? { fontSize: "var(--text-md)", letterSpacing: 0 } : undefined}
      >
        {v}
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="crd-sec">
      <div className="crd-sec-h">
        <span>{title}</span>
        {hint != null && <span className="crd-sec-hint mono">{hint}</span>}
        <span className="sp" style={{ flex: 1 }} />
        {action}
      </div>
      {children}
    </div>
  );
}

const fmtDay = (d: Date) =>
  d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

const fmtMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

/* ── "Where it happens" helpers ─────────────────────────────────────────────
   ISO-2 → regional-indicator flag glyph. Pure; returns "" for anything that
   isn't exactly two A–Z letters, so bad/empty codes render nothing (and
   degrade to the bare code beside the country name on platforms without flags). */
const flagEmoji = (iso: string): string => {
  const cc = String(iso || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(
    0x1f1e6 + cc.charCodeAt(0) - 65,
    0x1f1e6 + cc.charCodeAt(1) - 65,
  );
};

// ISO-2 → display name, falling back to the raw code for anything unmapped.
const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", NG: "Nigeria", GB: "United Kingdom", CA: "Canada",
  DE: "Germany", FR: "France", IN: "India", BR: "Brazil", AU: "Australia",
  JP: "Japan", NL: "Netherlands", SG: "Singapore", ES: "Spain", IT: "Italy",
  SE: "Sweden", MX: "Mexico", ZA: "South Africa", KE: "Kenya", IE: "Ireland",
};
const countryLabel = (iso: string): string =>
  COUNTRY_NAMES[String(iso || "").toUpperCase()] || String(iso || "");

// Tidy percent: 82 → "82%", 12.5 → "12.5%", drops trailing zeros.
const fmtPct = (n: number): string => `${+(Number(n) || 0).toFixed(1)}%`;

export function CrashDrawer({
  issue,
  onClose,
  onChanged,
}: {
  issue: CrashIssue;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  // The list row already carries everything for the header / stats / trend, so
  // the drawer paints instantly; the detail read only fills occurrences + stack.
  const { data } = useApi(() => getCrashIssue(issue.id), [issue.id]);
  const occ = data?.occurrences ?? [];
  const stack = data?.stack ?? [];
  const network = data?.network ?? [];
  const breadcrumbs = data?.breadcrumbs ?? [];
  const device = data?.device ?? { browser: [], os: [], country: [] };
  const hasGeo =
    device.browser.length > 0 ||
    device.os.length > 0 ||
    device.country.length > 0;
  const fingerprint = data?.issue?.fingerprint ?? "";

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);

  const act = async (status: "RESOLVED" | "IGNORED" | "OPEN") => {
    try {
      await setIssueStatus(issue.id, status);
      toast(
        status === "OPEN"
          ? "Reopened"
          : status === "RESOLVED"
            ? "Resolved"
            : "Ignored",
        { kind: "ok" },
      );
      onChanged?.();
      onClose();
    } catch (e) {
      toast("Couldn't update: " + (e instanceof Error ? e.message : "error"), {
        kind: "err",
      });
    }
  };

  const cat = crashCatOf(issue.errorClass);
  const color = CAT_META[cat].color;

  // 14-day occurrence trend (from the list row).
  const trend = issue.trend ?? [];
  const tmax = Math.max(1, ...trend);
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (trend.length ? trend.length - 1 : 13));

  return createPortal(
    <div className="crd-scrim" onClick={onClose}>
      <aside
        className="crd"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Crash investigation"
      >
        <div className="crd-top">
          <span>Issue</span>
          <span className="crd-dot" />
          <span className="mono">{fingerprint ? fingerprint.slice(0, 6) : "—"}</span>
          <span className="sp" style={{ flex: 1 }} />
          <button className="ibtn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>

        <header className="crd-head">
          <div className={`co-ic cr-ic ${cat}`}>
            <Icon name={CAT_ICON[cat]} size={14} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="crd-title">
              {issue.errorType || issue.title || "Error"}
            </div>
            {issue.message && <div className="crd-sub">{issue.message}</div>}
          </div>
        </header>

        <div className="crd-metabar">
          {statusTag(issue.status)}
          {issue.culprit && (
            <span className="cond">
              <span className="mono">{issue.culprit}</span>
            </span>
          )}
          <span className="cond">
            <b>{issue.platform || "—"}</b>
          </span>
          {issue.lastRelease && (
            <span className="cond">
              <span className="mono">{issue.lastRelease}</span>
            </span>
          )}
        </div>

        <div className="crd-body">
          <div className="stats crd-stats">
            <Stat l="Events" v={issue.occurrenceCount.toLocaleString()} />
            <Stat l="Unique users" v={issue.userCount.toLocaleString()} />
            <Stat l="Sessions" v={issue.sessionCount.toLocaleString()} />
            <Stat l="First seen" v={relTime(issue.firstSeenAt)} small />
            <Stat l="Last seen" v={relTime(issue.lastSeenAt)} small />
          </div>

          {trend.length > 0 && (
            <Section
              title="Occurrences"
              hint={`${issue.occurrenceCount.toLocaleString()} · ${trend.length}d`}
            >
              <div className="crd-chart">
                {trend.map((v, i) =>
                  v > 0 ? (
                    <i
                      key={i}
                      className={"on" + (i === trend.length - 1 ? " lst" : "")}
                      title={`${v} occurrence${v === 1 ? "" : "s"}`}
                      style={
                        {
                          height: `${Math.max(8, Math.round((v / tmax) * 100))}%`,
                          "--c": color,
                        } as React.CSSProperties
                      }
                    />
                  ) : (
                    <i key={i} />
                  ),
                )}
              </div>
              <div className="crd-chart-x">
                <span>{fmtDay(start)}</span>
                <span>{fmtDay(end)}</span>
              </div>
            </Section>
          )}

          <Section
            title="Stack trace"
            hint={stack.length ? `${stack.length} frames` : undefined}
          >
            {stack.length > 0 ? (
              <div className="crd-cb">
                <div className="crd-cb-h">
                  <span className="mono">{issue.errorType || "Error"}</span>
                  <span className="sp" style={{ flex: 1 }} />
                  <span className="crd-cb-tag">
                    {stack.filter((f) => f.inApp).length} in app
                  </span>
                </div>
                <div className="crd-cb-body">
                  {stack.map((f, i) => (
                    <div
                      key={i}
                      className={`crd-frame ${f.inApp ? "app" : "sys"}`}
                    >
                      <span className="k">at</span>{" "}
                      <span className="fn">{f.fn || "?"}</span>
                      {f.loc && <span className="loc"> ({f.loc})</span>}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="crd-empty">
                No stack trace captured for this issue.
              </div>
            )}
          </Section>

          {network.length > 0 && (
            <Section title="Network" hint="around the crash">
              <div className="crd-net">
                {network.map((n, i) => (
                  <div className="crd-net-row" key={i}>
                    <span className="crd-net-m mono">{n.method}</span>
                    <span
                      className={`crd-net-st mono ${n.status >= 500 ? "err" : n.status >= 400 ? "warn" : "ok"}`}
                    >
                      {n.status}
                    </span>
                    <span className="crd-net-u mono">{n.url}</span>
                    <span
                      className={`crd-net-d mono ${n.durationMs >= 1000 ? "slow" : ""}`}
                    >
                      {fmtMs(n.durationMs)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {hasGeo && (
            <Section title="Where it happens">
              {(() => {
                // Three labeled axes (Browser / OS / Location), each showing its
                // top values as a quiet accent-on-leader bar. The all-100% case
                // (a crash confined to one browser/OS/region) drops the bar and
                // the meaningless % for an "All sessions" tag; a long tail past
                // the top 3 collapses into a muted "Other" row.
                const DIMS: {
                  key: "browser" | "os" | "country";
                  label: string;
                  icon: ReactNode;
                }[] = [
                  {
                    key: "browser",
                    label: "Browser",
                    icon: (
                      <svg className="crd-geo-ic" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
                        <path d="M2 8h12M8 2c1.8 1.6 2.7 3.7 2.7 6S9.8 12.4 8 14C6.2 12.4 5.3 10.3 5.3 8S6.2 3.6 8 2Z" stroke="currentColor" strokeWidth="1.3" />
                      </svg>
                    ),
                  },
                  {
                    key: "os",
                    label: "OS",
                    icon: (
                      <svg className="crd-geo-ic" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <rect x="2" y="3" width="12" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
                        <path d="M6 14h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                    ),
                  },
                  {
                    key: "country",
                    label: "Location",
                    icon: (
                      <svg className="crd-geo-ic" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M8 14s4.5-4 4.5-7.5A4.5 4.5 0 0 0 3.5 6.5C3.5 10 8 14 8 14Z" stroke="currentColor" strokeWidth="1.3" />
                        <circle cx="8" cy="6.4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
                      </svg>
                    ),
                  },
                ];
                const groups = DIMS.filter((d) => device[d.key].length > 0);
                return (
                  <div className="crd-geo">
                    {groups.map((dim) => {
                      const rows = device[dim.key].slice(0, 3);
                      const isCountry = dim.key === "country";
                      const shown = rows.reduce((s, r) => s + (Number(r.pct) || 0), 0);
                      const other = Math.round((100 - shown) * 10) / 10;
                      const hasOther = other >= 0.5;
                      const solo =
                        rows.length === 1 && !hasOther && (Number(rows[0].pct) || 0) >= 100;
                      return (
                        <div className="crd-geo-grp" key={dim.key}>
                          <div className="crd-geo-hd">
                            {dim.icon}
                            <span className="crd-geo-dim">{dim.label}</span>
                          </div>
                          <div className="crd-geo-rows">
                            {rows.map((r, i) => {
                              const label = isCountry ? countryLabel(r.val) : r.val;
                              const flag = isCountry ? flagEmoji(r.val) : "";
                              if (solo) {
                                return (
                                  <div className="crd-geo-row is-solo" key={i}>
                                    <span className="crd-geo-val">
                                      {flag && <span className="crd-geo-flag">{flag}</span>}
                                      <span className="crd-geo-name">{label}</span>
                                    </span>
                                    <span className="crd-geo-tag">All sessions</span>
                                  </div>
                                );
                              }
                              return (
                                <div
                                  className={`crd-geo-row${i === 0 ? " is-lead" : ""}`}
                                  key={i}
                                >
                                  <span className="crd-geo-val">
                                    {flag && <span className="crd-geo-flag">{flag}</span>}
                                    <span className="crd-geo-name" title={label}>
                                      {label}
                                    </span>
                                  </span>
                                  <span className="crd-geo-track">
                                    <i style={{ width: `${Math.max(2, Number(r.pct) || 0)}%` }} />
                                  </span>
                                  <span className="crd-geo-pct mono">{fmtPct(r.pct)}</span>
                                </div>
                              );
                            })}
                            {!solo && hasOther && (
                              <div className="crd-geo-row is-other">
                                <span className="crd-geo-val">
                                  <span className="crd-geo-name">Other</span>
                                </span>
                                <span className="crd-geo-track">
                                  <i style={{ width: `${Math.max(2, other)}%` }} />
                                </span>
                                <span className="crd-geo-pct mono">{fmtPct(other)}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </Section>
          )}

          {breadcrumbs.length > 0 && (
            <Section title="Breadcrumbs" hint="last few events">
              <div className="crd-bc">
                {breadcrumbs.map((b, i) => (
                  <div
                    className={`crd-bc-ev ${b.kind === "error" ? "crash" : ""}`}
                    key={i}
                  >
                    <span className="dot" />
                    <span className="line" />
                    <div style={{ minWidth: 0 }}>
                      <div className="k">{b.kind}</div>
                      <div className="tx">{b.label}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Recent occurrences" hint={String(occ.length)}>
            {occ.length === 0 ? (
              <div className="crd-empty">No occurrences recorded.</div>
            ) : (
              <div className="crd-occ">
                {occ.slice(0, 12).map((o, i) => (
                  <button
                    key={i}
                    className="crd-occ-row"
                    disabled={!o.publicId}
                    onClick={() =>
                      o.publicId && navigate(`/recordings/${o.publicId}`)
                    }
                    title={o.publicId ? "Open the session replay" : undefined}
                  >
                    <span className="crd-occ-when mono">
                      {relTime(o.occurredAt)}
                    </span>
                    <span className="crd-occ-screen">{o.screen || "—"}</span>
                    {o.release && (
                      <span className="crd-occ-rel mono">{o.release}</span>
                    )}
                    <span className="sp" style={{ flex: 1 }} />
                    {o.count > 1 && (
                      <span className="crd-occ-c mono">{o.count}×</span>
                    )}
                    {o.publicId && (
                      <span className="crd-occ-play">
                        <Icon name="play" size={11} fill /> Replay
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </Section>
        </div>

        <footer className="crd-foot">
          <button
            className="btn"
            onClick={() => navigate(`/recordings?issue=${issue.id}`)}
          >
            <Icon name="rec" size={13} /> View all recordings
          </button>
          <span className="sp" style={{ flex: 1 }} />
          {issue.status === "RESOLVED" || issue.status === "IGNORED" ? (
            <button className="btn" onClick={() => act("OPEN")}>
              <Icon name="refresh" size={13} /> Reopen
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => act("IGNORED")}>
                <Icon name="pause" size={13} /> Ignore
              </button>
              <button className="btn primary" onClick={() => act("RESOLVED")}>
                <Icon name="check" size={13} /> Resolve
              </button>
            </>
          )}
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
