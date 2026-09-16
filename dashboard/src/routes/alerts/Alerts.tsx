/* ---------- Alerts ----------------------------------------------------------
   A list, not a builder. Alerts are created elsewhere (the AI's alert.watchIssue
   / alert.create — there is no REST route to subscribe, by design); this page
   shows the ones that exist and manages two things: where each routes, and
   whether you still want it.

   Both kinds render truthfully. An ISSUE_RECURRENCE alert names the issue it
   watches and unsubscribing deletes it; a METRIC alert has no issue, so it
   shows its condition and is deleted rather than "unsubscribed".
   ---------- */
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Icon, Modal, Popover } from "@/components/primitives";
import { EmptyState, EMPTY_ART } from "@/components/feedback";
import { ee } from "@ee";
import { Alerts as AlertsApi, Dashboard } from "@/api/endpoints";
import { useApi, useApiInfinite } from "@/api/useApi";
import { useInfiniteScroll } from "@/hooks";
import { ChannelModal } from "./ChannelModal";
import { FunnelAlertManageModal } from "./FunnelAlertManageModal";
import { AlertsSkeleton, AlertRowsSkeleton } from "./AlertsSkeleton";
import { adaptAlert, type Alert, type ApiAlert } from "./alerts.data";

type AlertsProps = {
  empty?: boolean;
};

const ISSUE_TAG: Record<string, string> = {
  OPEN: "warn",
  REGRESSED: "err",
  RESOLVED: "ok",
  IGNORED: "",
};

export function Alerts({ empty }: AlertsProps) {
  const [editing, setEditing] = useState<Alert | null>(null);
  // A funnel-conversion alert being managed (recipients + condition) — a separate
  // modal from ChannelModal because these alerts are email-only (no channel).
  const [managing, setManaging] = useState<Alert | null>(null);
  const [confirm, setConfirm] = useState<Alert | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  // Pre-fetched workspace counts (shared "dashboard-counts" key, already polled by
  // the shell) — the SAME gate Crashlytics uses. Declared BEFORE the list hook so
  // its `enabled` can read `hasAlerts`: a workspace with zero alerts never fires
  // the alerts LIST request at all (enabled:false ⇒ React Query never calls the
  // fetcher), and goes straight to the illustration — no request, no skeleton.
  const { data: counts } = useApi<{ alerts: number }>(
    () => Dashboard.counts<{ alerts: number }>(),
    [],
    { key: "dashboard-counts" },
  );
  const countsReady = counts !== undefined;
  const hasAlerts = !!counts && counts.alerts > 0;
  // Infinite scroll: the alerts list pages by cursor — gated on `hasAlerts`, so an
  // empty workspace never calls it. The fetcher takes the page cursor and returns
  // the standard envelope; `page` carries the workspace-wide alert count tile.
  const { items, page, loading, loadingMore, stale, hasMore, fetchMore, refetch } =
    useApiInfinite<ApiAlert>(
      (cursor) => AlertsApi.list<ApiAlert[]>({ cursor: cursor ?? undefined }),
      [],
      { enabled: hasAlerts },
    );
  // The page's scroller is the shell's <main.main> (this route renders no scroll
  // container of its own), resolved off the mounted wrap and held in state so the
  // observer's root is set on first paint — a plain ref reads null past the
  // observer's first run. Mirrors RvRail's / Cohorts' state-backed root.
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
  const sentinelRef = useRef<HTMLTableRowElement>(null);
  useInfiniteScroll(sentinelRef, () => fetchMore(), { root: rootEl });
  const all: Alert[] = items.map(adaptAlert);

  /* A cold load, and only a cold load. `loading` is a genuinely empty cache;
     `stale` is the keepPreviousData placeholder, which for a query with no deps
     can only mean the workspace id in the key changed — i.e. `data` is still
     the OTHER workspace's alerts, and rendering those under this workspace is
     the one thing worse than a shimmer.

     Deliberately NOT `syncing`. The refetch after deleting an alert keeps the
     same key, so the list is already on screen and correct; blanking what
     someone is reading to fetch what it already has is a flash, not a loading
     state. */
  const cold = loading || stale;

  const del = async (a: Alert) => {
    setBusy(a.id);
    try {
      await AlertsApi.remove(String(a.id));
      toast.success(
        a.kind === "ISSUE_RECURRENCE" ? "Unsubscribed" : "Alert deleted",
      );
      setConfirm(null);
      refetch();
    } catch (e) {
      toast.error(
        "Couldn't delete the alert: " +
          (e instanceof Error ? e.message : "error"),
      );
    } finally {
      setBusy(null);
    }
  };

  /* The page header says the same thing whether or not the fetch has landed, so
     it is held here and rendered by both the skeleton branch and the live page
     rather than copied into each (the pattern Recordings uses for its scope
     banner). Only what is actually being fetched shimmers. */
  const head = (
    // Nudged right by the table's 14px cell padding so the title, subtitle,
    // stats and the alert-row icons all share one left edge — the column
    // headers and icons already sit on that line.
    <div className="head" style={{ paddingLeft: "var(--sp-14)" }}>
      <div className="head-l">
        <h1>Alerts</h1>
        <div className="sub">
          Where Replayfy tells you when something you care about happens again.
        </div>
      </div>
    </div>
  );

  /* Ordered BEFORE the empty guard, which is the whole point. That guard only
     declines to fire while `loading`; it does not render anything in its place,
     so a cold load fell straight through it into the live markup below and
     showed the empty workspace's answer — 0 / 0 / 0 and bare column headers —
     for the width of the request. The `empty` prop is the router asking for the
     empty state outright, so it still wins over the skeleton.

     An error is deliberately NOT routed here: `loading` goes false when the
     retries are exhausted, so a failed fetch falls through to the empty state
     it has always shown rather than shimmering forever. That empty state is the
     wrong answer for an error, but it is the page's pre-existing answer and
     fixing it is a page-level change, not a skeleton. */
  // Suppress the skeleton for a KNOWN-empty workspace (counts say zero alerts):
  // it falls straight through to the illustration below — no fetch→skeleton→illo
  // flash. The skeleton still shows for a workspace that HAS alerts still loading,
  // and while the counts themselves are unknown.
  if (cold && !empty && !(countsReady && !hasAlerts))
    return (
      <div className="wrap rd-page al-page">
        {head}
        <AlertsSkeleton />
      </div>
    );

  // `cold` returned above, so reaching here with no rows means the fetch landed
  // and the workspace genuinely has no alerts.
  if (empty || all.length === 0)
    return (
      <div className="wrap">
        <EmptyState
          art={EMPTY_ART.alerts}
          title="Alerts"
          desc={
            ee.hasAsk
              ? "An alert is a subscription: Replayfy already detects the issues, and an alert says where to tell you when one comes back. Ask Replayfy AI to watch an issue and it shows up here."
              : "An alert is a subscription: Replayfy already detects the issues, and an alert says where to tell you when one comes back. Create one from any funnel or signal and it shows up here."
          }
          actions={[
            {
              label: "Documentation",
              onClick: () =>
                window.open(
                  "https://docs.replayfy.app/products/alerts",
                  "_blank",
                  "noopener",
                ),
            },
          ]}
        />
      </div>
    );

  // Label the row by what it actually watches — never invent a title for an
  // alert whose issue no longer resolves. Funnel-conversion alerts carry their
  // own "<funnel> conversion" name.
  const subject = (a: Alert) =>
    a.kind === "FUNNEL_CONVERSION"
      ? a.name
      : a.issue
        ? a.issue.title
        : a.orphaned
          ? "Issue unavailable"
          : a.name;

  const rows = all;
  const issues = all.filter((a) => a.kind === "ISSUE_RECURRENCE").length;
  /* Infinite scroll: `all` is only the pages loaded so far. The list envelope
     carries the true alert count, so "Alerts" uses that; "Watching an issue" and
     "Paused" have no server total and therefore reflect the LOADED rows. */
  const total = page?.total ?? all.length;

  return (
    <div
      className="wrap rd-page al-page"
      ref={(el) => setRootEl(el?.closest<HTMLElement>(".main") ?? null)}
    >
      {head}
      <div
        className="stats"
        style={{
          marginTop: "var(--sp-20)",
          paddingBottom: "var(--sp-20)",
          paddingLeft: "var(--sp-14)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div className="stat">
          <div className="stat-l">Alerts</div>
          <div className="stat-v">{total}</div>
        </div>
        <div className="stat">
          <div className="stat-l">Watching an issue</div>
          <div className="stat-v">{issues}</div>
        </div>
        <div className="stat">
          <div className="stat-l">Paused</div>
          <div className="stat-v">{all.filter((a) => !a.active).length}</div>
        </div>
      </div>
      <table className="co-tbl">
        <thead>
          <tr>
            <th>Watching</th>
            <th style={{ width: 210, textAlign: "center" }}>Channel</th>
            <th style={{ width: 150 }}>Last fired</th>
            <th style={{ width: 40 }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            // The sub-line only renders for metric alerts or an orphaned issue.
            // Single-line rows center the icon against the text; two-line rows
            // top-align it so the icon sits with the subject, not floating
            // between the two lines.
            const hasSub = a.kind !== "ISSUE_RECURRENCE" || a.orphaned;
            return (
            <tr key={a.id} style={{ opacity: busy === a.id ? 0.5 : 1 }}>
              <td>
                <div
                  style={{
                    display: "flex",
                    alignItems: hasSub ? "flex-start" : "center",
                    gap: "var(--sp-10)",
                  }}
                >
                  <div className="co-ic">
                    <Icon
                      name={
                        a.kind === "ISSUE_RECURRENCE"
                          ? "warn"
                          : a.kind === "FUNNEL_CONVERSION"
                            ? "funnel"
                            : "bolt"
                      }
                      size={13}
                    />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="al-subj-row">
                      <span className="al-subj">{subject(a)}</span>
                      {/* The watched issue's own state — what makes the title a
                          live label rather than a dead string. */}
                      {a.issue && (
                        <span className={`tag ${ISSUE_TAG[a.issue.status] ?? ""}`}>
                          {a.issue.status.charAt(0) +
                            a.issue.status.slice(1).toLowerCase()}
                        </span>
                      )}
                    </div>
                    {/* Only rendered when it has something to say. A healthy
                        issue row used to print a constant — the same sentence on
                        every row, and one the page header already makes — which
                        is a column of noise. The condition IS per-row data, and
                        an orphaned issue is a real warning, so those stay. */}
                    {hasSub && (
                      <div className="al-sub">
                        {a.orphaned
                          ? "The watched issue is no longer available"
                          : a.condition || a.name}
                      </div>
                    )}
                  </div>
                </div>
              </td>
              <td>
                <div className="al-chips">
                  {a.kind === "FUNNEL_CONVERSION" ? (
                    // Email-only by design — no in-app bell, no external channels.
                    // Show who it emails (recipient count, or "creator" fallback).
                    <span className="tag">
                      Email
                      {a.recipients.length > 0
                        ? ` · ${a.recipients.length}`
                        : " · creator"}
                    </span>
                  ) : (
                    <>
                      <span className="tag">
                        <Icon name="bell" size={10} /> In-app
                      </span>
                      {a.emailEnabled && <span className="tag">Email</span>}
                      {a.dests.map((d) => (
                        <span key={d} className="tag info">
                          {d.charAt(0) + d.slice(1).toLowerCase()}
                        </span>
                      ))}
                    </>
                  )}
                </div>
              </td>
              <td className="al-when">
                {a.active ? (
                  a.lastFired
                ) : (
                  <span className="tag">Paused</span>
                )}
              </td>
              <td>
                <Popover
                  align="right"
                  trigger={
                    <button className="ibtn">
                      <Icon name="more" size={14} />
                    </button>
                  }
                >
                  {({ close }) => (
                    <>
                      {a.kind === "FUNNEL_CONVERSION" ? (
                        // No channel to change — manage recipients + condition.
                        <button
                          onClick={() => {
                            close();
                            setManaging(a);
                          }}
                        >
                          <Icon name="sliders" size={14} /> Manage alert
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            close();
                            setEditing(a);
                          }}
                        >
                          <Icon name="sliders" size={14} /> Change channel
                        </button>
                      )}
                      <div className="sep" />
                      <button
                        className="danger"
                        onClick={() => {
                          close();
                          setConfirm(a);
                        }}
                      >
                        <Icon name="trash" size={14} />{" "}
                        {a.kind === "ISSUE_RECURRENCE"
                          ? "Unsubscribe from issue"
                          : "Delete alert"}
                      </button>
                    </>
                  )}
                </Popover>
              </td>
            </tr>
            );
          })}
          {/* End-of-list skeleton while the next page is in flight — bare `<tr>`s
              that wear the row geometry, same as the cold-load skeleton. */}
          {loadingMore && <AlertRowsSkeleton rows={2} />}
          {/* Infinite-scroll sentinel — ALWAYS mounted (so the observer never has
              to re-attach); fetchMore no-ops unless a page remains. An invisible
              1px row (see `.co-tbl tr.co-more` in pages.css) so it adds no band. */}
          <tr ref={sentinelRef} className="co-more" aria-hidden={!hasMore}>
            <td colSpan={4} />
          </tr>
        </tbody>
      </table>
      {!rows.length && (
        <div className="al-none">No alerts match your filters.</div>
      )}

      {editing && (
        <ChannelModal
          alert={editing}
          onClose={() => setEditing(null)}
          onSaved={refetch}
        />
      )}

      {managing && (
        <FunnelAlertManageModal
          alert={managing}
          onClose={() => setManaging(null)}
          onSaved={refetch}
        />
      )}

      {confirm && (
        <Modal
          icon="trash"
          tone="danger"
          title={
            confirm.kind === "ISSUE_RECURRENCE"
              ? "Unsubscribe from this issue?"
              : "Delete this alert?"
          }
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => del(confirm)}
                disabled={busy === confirm.id}
              >
                <Icon name="trash" size={13} />{" "}
                {confirm.kind === "ISSUE_RECURRENCE"
                  ? "Unsubscribe"
                  : "Delete alert"}
              </button>
            </>
          }
        >
          <p className="al-confirm">
            <b>{subject(confirm)}</b>
            {confirm.kind === "ISSUE_RECURRENCE"
              ? " will stop notifying you. The issue itself stays — only the alert is deleted, and this can't be undone."
              : " will be deleted and stop notifying you. This can't be undone."}
          </p>
        </Modal>
      )}
    </div>
  );
}
