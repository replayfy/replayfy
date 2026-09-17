import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { useAuth } from "@/lib/auth";
import { ee } from "@ee";
import { useApi } from "@/api/useApi";
import { Sessions, EndUsers, Funnels, Cohorts, Playlists, Alerts } from "@/api/endpoints";
import { listCrashIssues, type CrashIssue } from "@/routes/overview/crashlytics.api";
import { highlightMatch } from "@/lib/highlight";

type CommandPaletteProps = {
  onClose: () => void;
  /** Opens the Sidebar-owned "New playlist" modal (playlist creation has no
   *  route, so the palette can't navigate to it). */
  onNewPlaylist?: () => void;
  /** Opens the Sidebar-owned keyboard-shortcuts sheet (same target as the
   *  account menu item); the palette can't render the sheet itself. */
  onShortcuts?: () => void;
};

// Help / meta destinations — mirror the account menu (Sidebar.tsx) so both
// surfaces point at the same places. Docs + support are live; changelog + status
// are placeholders until those sites exist.
const DOCS_URL = "https://docs.replayfy.app";
const CHANGELOG_URL = "https://replayfy.app/changelog";
const SUPPORT_URL = "https://docs.replayfy.app/support";
const STATUS_URL = "https://status.replayfy.app";

/** Minimal read shapes for the five entity list endpoints the palette searches. */
type RawSession = { publicId: string; startUrl: string | null; platform: string | null; endUser: { name: string | null; email: string | null } | null };
type RawUser = { id: number; name: string | null; email: string | null; distinctId: string | null; plan?: string | null };
type RawFunnel = { id: number; name: string; steps?: unknown[] };
type RawCohort = { id: number; name: string; membersCount?: number };
type RawPlaylist = { id: number; title: string };
type RawAlert = { id: number; name: string };

type CmdRow = { icon: string; label: string; sub?: string; go: () => void };
type CmdGroup = { key: string; title: string; tint: string; fg: string; rows: CmdRow[] };

/** Per-category accent for the 30x30 rounded icon square — mirrors the funnel
 *  filter palette's group-color treatment (indigo/teal/violet/amber/blue/slate). */
const CAT = {
  nav: { fg: '#5b5ceb', tint: 'rgba(91,92,235,.10)' },       // Navigate — indigo
  recording: { fg: '#0d9488', tint: 'rgba(13,148,136,.10)' }, // Recordings — teal
  user: { fg: '#7c3aed', tint: 'rgba(124,58,237,.10)' },      // Users — violet
  funnel: { fg: '#c08a3e', tint: 'rgba(192,138,62,.12)' },    // Funnels — amber
  cohort: { fg: '#3b76b0', tint: 'rgba(59,118,176,.10)' },    // Cohorts — blue
  playlist: { fg: '#64748b', tint: 'rgba(100,116,139,.10)' }, // Playlists — slate
  alert: { fg: '#e0524d', tint: 'rgba(224,82,77,.10)' },      // Alerts — rose
  crash: { fg: '#dc2626', tint: 'rgba(220,38,38,.10)' },      // Crashlytics — red
} as const;

/** Static in-app destinations (always searchable, filtered client-side). */
const NAV: { path: string; label: string; icon: string }[] = [
  { path: '/overview', label: 'Overview', icon: 'home' },
  { path: '/recordings', label: 'Recordings', icon: 'rec' },
  { path: '/analytics', label: 'Analytics', icon: 'chartLine' },
  { path: '/funnels', label: 'Funnels', icon: 'funnel' },
  { path: '/crashlytics', label: 'Crashlytics', icon: 'crash' },
  { path: '/users', label: 'Users', icon: 'users' },
  { path: '/cohorts', label: 'Cohorts', icon: 'cohorts' },
  { path: '/comments', label: 'Comments', icon: 'comment' },
  { path: '/alerts', label: 'Alerts', icon: 'bell' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
];

/** Settings sub-tabs (route /settings/:tab) — surfaced when searching so every
 *  panel is reachable from the palette, not just the Settings root. */
const SETTINGS_TABS: { tab: string; label: string }[] = [
  { tab: 'general', label: 'Settings · General' },
  { tab: 'recording', label: 'Settings · Recording' },
  { tab: 'masking', label: 'Settings · Masking' },
  { tab: 'retention', label: 'Settings · Retention' },
  { tab: 'sampling', label: 'Settings · Sampling' },
  { tab: 'ai', label: 'Settings · AI' },
  { tab: 'team', label: 'Settings · Team' },
  { tab: 'integrations', label: 'Settings · Integrations' },
  { tab: 'install', label: 'Settings · Install' },
  // Billing is Enterprise Edition — no such tab in the open-source build.
  ...(ee.hasBilling ? [{ tab: 'billing', label: 'Settings · Billing' }] : []),
];

// Wrap a long label to a second line (instead of one truncated line) while the
// count/sub stays pinned to the side; clamp at 2 lines so a very long name can't
// grow the row unbounded. `flex:1` gives the label the flexible middle column.
const LBL_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflowWrap: 'anywhere',
  lineHeight: 'var(--lh-snug)',
};

/* ---------- Global command palette (⌘K) ---------- */
export function CommandPalette({ onClose, onNewPlaylist, onShortcuts }: CommandPaletteProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const { logout, can } = useAuth();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  // Debounced query — only the entity fetches (sessions/users) key off this so a
  // burst of keystrokes fires a single request per settled input, never a loop.
  const [dq, setDq] = useState('');
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 180); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [active]);

  // Bounded per-workspace collections — fetched once on open, filtered client-side
  // (funnels/cohorts/playlists are small, capped lists; no keystroke refetch).
  const { data: fnData } = useApi<RawFunnel[]>(() => Funnels.list<RawFunnel[]>(), []);
  const { data: cohData } = useApi<RawCohort[]>(() => Cohorts.list<RawCohort[]>(), []);
  const { data: plData } = useApi<RawPlaylist[]>(() => Playlists.list<RawPlaylist[]>({ limit: 20 }), []);
  // Alerts — small, capped per-workspace collection (like funnels/cohorts/playlists):
  // fetched once on open, filtered client-side by name. The backend list() is keyset-
  // paginated on the indexed [workspaceId, id desc] with a capped take, so this bounded
  // limit:20 page never full-scans and never loads the whole table into memory.
  const { data: alData } = useApi<RawAlert[]>(() => Alerts.list<RawAlert[]>({ limit: 20 }), []);
  // Sessions/users are unbounded — fetch a small, bounded page keyed on the
  // debounced query (enabled only while searching). The list endpoints run the
  // text filter SERVER-side under the `search` param (Sessions/EndUsers controllers
  // both bind @Query("search")); it's an index-backed ILIKE on name+email, so the
  // match no longer depends on the row being in the already-loaded page. The
  // client-side .filter below is kept only as a harmless narrowing guard.
  const { data: sessData, syncing: sessSync } = useApi<RawSession[]>(() => Sessions.list<RawSession[]>({ limit: 8, search: dq }), [dq], { enabled: !!dq });
  const { data: usrData, syncing: usrSync } = useApi<RawUser[]>(() => EndUsers.list<RawUser[]>({ limit: 8, search: dq }), [dq], { enabled: !!dq });
  // Crash/error groups — same debounced, server-side search as sessions/users.
  // listCrashIssues filters the WHOLE workspace server-side (index-backed ILIKE on
  // title/errorType, keyset-paged), so a match isn't limited to a loaded page. It
  // returns the ApiResult envelope, which useApi unwraps to CrashIssue[].
  const { data: crashData, syncing: crashSync } = useApi<CrashIssue[]>(() => listCrashIssues({ limit: 8, search: dq }), [dq], { enabled: !!dq });

  const ql = q.trim().toLowerCase();
  const go = (to: string) => { navigate(to); onClose(); };

  const groups: CmdGroup[] = [];
  // Navigate — always present; unfiltered when the query is empty.
  const navRows = (ql ? NAV.filter((n) => n.label.toLowerCase().includes(ql)) : NAV)
    .map((n): CmdRow => ({ icon: n.icon, label: n.label, go: () => go(n.path) }));
  groups.push({ key: 'nav', title: 'Navigate', ...CAT.nav, rows: navRows });

  // Create — always present; the primary "new X" actions, mirroring the N-then-X
  // keyboard shortcuts (the hint is shown in the row's right slot). New playlist
  // has no route, so it calls back into the Sidebar-owned modal.
  const createDefs: { icon: string; label: string; kbd: string; run: () => void }[] = [
    { icon: 'funnel', label: 'New funnel', kbd: 'N F', run: () => go('/funnels/new') },
    { icon: 'cohorts', label: 'New cohort', kbd: 'N C', run: () => go('/cohorts?new=1') },
    { icon: 'bell', label: 'New alert', kbd: 'N A', run: () => go('/alerts?new=1') },
    { icon: 'pages', label: 'New playlist', kbd: 'N P', run: () => { onClose(); onNewPlaylist?.(); } },
  ];
  const createRows = (ql ? createDefs.filter((c) => c.label.toLowerCase().includes(ql)) : createDefs)
    .map((c): CmdRow => ({ icon: c.icon, label: c.label, sub: c.kbd, go: c.run }));
  groups.push({ key: 'create', title: 'Create', fg: '#16a34a', tint: 'rgba(22,163,74,.10)', rows: createRows });

  // Actions — app-level commands (not navigation/creation): open Ask AI, docs,
  // invite, copy the current URL, sign out. Always present; filtered by query.
  // Ask AI lives inside AskProvider (a subtree the palette isn't in), so it can't
  // call openAsk() directly — it navigates to /overview?ask=<q>, which the
  // provider auto-opens (and strips the param). `can.contribute` gates it: a
  // viewer can't spend AI credits, so the row isn't offered to them.
  const actionDefs: { icon: string; label: string; show?: boolean; run: () => void }[] = [
    // Ask AI is Enterprise Edition — hidden entirely in the open-source build.
    { icon: 'spark', label: 'Ask AI', show: can.contribute, run: () => go('/overview?ask=' + encodeURIComponent(q.trim())) },
    { icon: 'pages', label: 'View documentation', run: () => { window.open(DOCS_URL, '_blank', 'noopener'); onClose(); } },
    { icon: 'sparkle', label: 'Changelog', run: () => { window.open(CHANGELOG_URL, '_blank', 'noopener'); onClose(); } },
    { icon: 'comment', label: 'Support', run: () => { window.open(SUPPORT_URL, '_blank', 'noopener'); onClose(); } },
    { icon: 'activity', label: 'Status page', run: () => { window.open(STATUS_URL, '_blank', 'noopener'); onClose(); } },
    { icon: 'kbd', label: 'Keyboard shortcuts', run: () => { onClose(); onShortcuts?.(); } },
    { icon: 'users', label: 'Invite teammates', run: () => go('/settings/team?invite=1') },
    { icon: 'copy', label: 'Copy link to this page', run: () => { void navigator.clipboard?.writeText(window.location.href); toast && toast('Link copied', { kind: 'ok' }); onClose(); } },
    { icon: 'logout', label: 'Log out', run: () => { onClose(); void logout(); } },
  ];
  const actionRows = actionDefs
    .filter((a) => a.show !== false)
    .filter((a) => (ql ? a.label.toLowerCase().includes(ql) : true))
    .map((a): CmdRow => ({ icon: a.icon, label: a.label, go: a.run }));
  groups.push({ key: 'act', title: 'Actions', fg: '#64748b', tint: 'rgba(100,116,139,.10)', rows: actionRows });

  // Live entity results only surface once the user is actually searching.
  if (ql) {
    const recRows = (sessData ?? [])
      .filter((s) => {
        const nm = (s.endUser?.name || s.endUser?.email || '').toLowerCase();
        return nm.includes(ql) || (s.startUrl || '').toLowerCase().includes(ql) || s.publicId.toLowerCase().includes(ql);
      })
      .slice(0, 6)
      .map((s): CmdRow => ({
        icon: 'play',
        label: s.endUser?.name || s.endUser?.email || ('Session ' + s.publicId.slice(0, 6)),
        sub: s.startUrl ? (s.startUrl.replace(/^https?:\/\/[^/]+/, '') || '/') : (s.platform || undefined),
        go: () => go('/recordings/' + s.publicId),
      }));
    groups.push({ key: 'rec', title: 'Recordings', ...CAT.recording, rows: recRows });

    const userRows = (usrData ?? [])
      .filter((u) => [u.name, u.email, u.distinctId].some((v) => (v || '').toLowerCase().includes(ql)))
      .slice(0, 6)
      .map((u): CmdRow => {
        const label = u.name || u.email || u.distinctId || 'Anonymous';
        return { icon: 'users', label, sub: u.email && u.email !== label ? u.email : (u.plan || undefined), go: () => go('/users/' + u.id) };
      });
    groups.push({ key: 'usr', title: 'Users', ...CAT.user, rows: userRows });

    // Crashlytics — crash/error groups. Each match deep-links to its investigation
    // drawer via `/crashlytics?issue=<id>` (the page opens it on mount). The label
    // is the human error type; the sub is the culprit / message so two same-typed
    // crashes stay distinguishable.
    const crashRows = (crashData ?? [])
      .filter((c) => [c.errorType, c.title, c.message, c.culprit].some((v) => (v || '').toLowerCase().includes(ql)))
      .slice(0, 6)
      .map((c): CmdRow => ({
        icon: 'crash',
        label: c.errorType || c.title || 'Error',
        sub: c.culprit || c.message || c.platform || undefined,
        go: () => go('/crashlytics?issue=' + c.id),
      }));
    groups.push({ key: 'crash', title: 'Crashlytics', ...CAT.crash, rows: crashRows });

    const funnelRows = (fnData ?? [])
      .filter((f) => f.name.toLowerCase().includes(ql))
      .slice(0, 6)
      .map((f): CmdRow => ({ icon: 'funnel', label: f.name, sub: f.steps?.length ? `${f.steps.length} steps` : undefined, go: () => go('/funnels/' + f.id) }));
    groups.push({ key: 'fnl', title: 'Funnels', ...CAT.funnel, rows: funnelRows });

    const cohortRows = (cohData ?? [])
      .filter((c) => c.name.toLowerCase().includes(ql))
      .slice(0, 6)
      .map((c): CmdRow => ({ icon: 'cohorts', label: c.name, sub: c.membersCount != null ? `${c.membersCount} users` : undefined, go: () => go(`/users?cohort=${c.id}`) }));
    groups.push({ key: 'coh', title: 'Cohorts', ...CAT.cohort, rows: cohortRows });

    const playlistRows = (plData ?? [])
      .filter((p) => p.title.toLowerCase().includes(ql))
      .slice(0, 6)
      .map((p): CmdRow => ({ icon: 'pages', label: p.title, go: () => go('/recordings?playlist=' + p.id) }));
    groups.push({ key: 'pl', title: 'Playlists', ...CAT.playlist, rows: playlistRows });

    // Alerts — notification policies. There is no per-alert route (router has only
    // `/alerts`), so a match navigates to the Alerts list, the same way a playlist
    // match opens its recordings view. Filtered by name, same 6-row cap as the rest.
    const alertRows = (alData ?? [])
      .filter((a) => a.name.toLowerCase().includes(ql))
      .slice(0, 6)
      .map((a): CmdRow => ({ icon: 'bell', label: a.name, go: () => go('/alerts') }));
    groups.push({ key: 'alr', title: 'Alerts', ...CAT.alert, rows: alertRows });

    // Settings sub-tabs — every panel reachable by name, not just the root.
    const settingsRows = SETTINGS_TABS
      .filter((s) => s.label.toLowerCase().includes(ql))
      .slice(0, 8)
      .map((s): CmdRow => ({ icon: 'settings', label: s.label, go: () => go('/settings/' + s.tab) }));
    groups.push({ key: 'set', title: 'Settings', ...CAT.playlist, rows: settingsRows });
  }

  const shown = groups.filter((g) => g.rows.length > 0);
  const flat: CmdRow[] = shown.flatMap((g) => g.rows);
  const searching = !!ql && (sessSync || usrSync || crashSync);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); flat[active]?.go(); }
  };

  let fi = -1;
  return (
    <div className="pov" onClick={onClose}>
      <div className="fn-fp2" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="fn-fp2-head">
          <div className="fn-fp2-search">
            <Icon name="search" size={15} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages, recordings, users, funnels…" />
            <kbd className="fn-fp2-kbd">esc</kbd>
          </div>
        </div>
        <div className="fn-fp2-body">
          {shown.length === 0 ? (
            <div className="fn-fp2-empty">{searching ? 'Searching…' : `No results${ql ? ` for “${q.trim()}”` : ''}`}</div>
          ) : (
            <div className="fn-fp2-cols">
              {shown.map((g) => (
                <div key={g.key} className="fn-fp2-cell">
                  <div className="fn-fp2-gh">{g.title}</div>
                  {g.rows.map((r) => {
                    fi++; const idx = fi;
                    return (
                      <button
                        key={g.key + idx}
                        ref={idx === active ? activeRef : undefined}
                        className={`fn-fp2-item ${idx === active ? 'active' : ''}`}
                        onMouseEnter={() => setActive(idx)}
                        onClick={r.go}
                      >
                        <span className="fn-fp2-ico" style={{ background: g.tint, borderColor: 'transparent', color: g.fg }}>
                          <Icon name={r.icon} size={13} />
                        </span>
                        <span style={LBL_STYLE}>{highlightMatch(r.label, q)}</span>
                        {r.sub && <span className="fn-fp2-grp">{r.sub}</span>}
                        <span className="fn-fp2-enter" aria-hidden>↵</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="fn-fp2-foot">
          <span className="fn-fp2-nav"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span className="fn-fp2-nav"><kbd>↵</kbd> Select</span>
          <span className="sp" />
          {searching && <span className="fn-fp2-foot-note">Searching…</span>}
        </div>
      </div>
    </div>
  );
}
