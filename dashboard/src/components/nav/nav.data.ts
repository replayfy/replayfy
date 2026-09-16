/* ============================================================================
   nav.data.ts — static fixtures + helpers for the sidebar nav, playlists and
   the playlist filter editor. Extracted verbatim from the prototype so these
   become the future API-swap points (no fetch this phase).
   ========================================================================== */
import { CO_COUNTRIES } from "@/routes/cohorts/cohorts.data";

export type NavItem = { id: string; label: string; icon: string; cnt?: string };

/* ---------- Sidebar (canonical nav, with Playlists) ----------
   The recordings/comments badges are NOT listed here: they used to carry
   hardcoded `cnt: '7'` / `cnt: '1'` fixtures from the prototype, which is why
   they never moved (and why the nav read "7" while the Overview read 30
   sessions). The Sidebar now fills them from GET /v1/dashboard/counts. */
export type NavGroup = { label?: string; items: NavItem[] };

/* Grouped sidebar nav. As the product grew the flat list got long, so the rail
   is now sectioned. Settings is intentionally NOT here — it lives in the account
   menu (bottom chip) and the workspace switcher, so the primary rail stays
   focused on the product surfaces. */
export const NAV_GROUPS: NavGroup[] = [
  { items: [
    { id: 'overview', label: 'Home', icon: 'home' },
    { id: 'recordings', label: 'Recordings', icon: 'rec' },
  ] },
  { label: 'Analyze', items: [
    { id: 'analytics', label: 'Analytics', icon: 'chartLine' },
    { id: 'funnels', label: 'Funnels', icon: 'funnel' },
    { id: 'crashlytics', label: 'Crashlytics', icon: 'crash' },
  ] },
  { label: 'People', items: [
    { id: 'users', label: 'Users', icon: 'users' },
    { id: 'cohorts', label: 'Cohorts', icon: 'cohorts' },
  ] },
  { label: 'Workspace', items: [
    { id: 'alerts', label: 'Alerts', icon: 'bell' },
    { id: 'comments', label: 'Comments', icon: 'comment' },
  ] },
];

/* Flat list, derived — kept for prefetch / counts / right-click lookups that
   index by nav id. */
export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/* Playlist summary as returned by GET /v1/playlists (see Playlists.list in
   @/api/endpoints). The sidebar renders these live now — no fixture seed. */
export type Playlist = { id: number; title: string; kind?: string; itemCount?: number; pinned?: boolean };

/* ---------- Playlist filter editor fixtures ---------- */
export type PlKind = 'bool' | 'number' | 'text' | 'enum' | 'country';
export type PlField = {
  value: string;
  label: string;
  kind: PlKind;
  icon: string;
  options?: string[];
};

export const PL_FIELDS: PlField[] = [
  { value: 'hasErrors', label: 'Has errors', kind: 'bool', icon: 'warn' },
  { value: 'hasRageClicks', label: 'Has rage clicks', kind: 'bool', icon: 'cursor' },
  { value: 'hasDeadClicks', label: 'Has dead clicks', kind: 'bool', icon: 'cursor' },
  { value: 'duration', label: 'Duration (s)', kind: 'number', icon: 'clock' },
  { value: 'pageCount', label: 'Pages visited', kind: 'number', icon: 'rec' },
  { value: 'errorCount', label: 'Error count', kind: 'number', icon: 'warn' },
  { value: 'startUrl', label: 'Start URL', kind: 'text', icon: 'globe' },
  { value: 'browser', label: 'Browser', kind: 'enum', icon: 'console', options: ['Chrome', 'Safari', 'Firefox', 'Edge', 'Opera', 'Brave'] },
  { value: 'os', label: 'OS', kind: 'enum', icon: 'settings', options: ['Windows', 'macOS', 'Linux', 'iOS', 'Android', 'ChromeOS'] },
  { value: 'device', label: 'Device', kind: 'enum', icon: 'device', options: ['Desktop', 'Mobile', 'Tablet'] },
  { value: 'country', label: 'Country', kind: 'country', icon: 'globe' },
  { value: 'plan', label: 'Plan', kind: 'enum', icon: 'plus', options: ['Free', 'Pro', 'Team', 'Enterprise'] },
];

export const PL_OPS: Record<PlKind, [string, string][]> = {
  bool: [['=', 'is'], ['!=', 'is not']],
  number: [['>', '>'], ['<', '<'], ['>=', '≥'], ['<=', '≤'], ['=', '='], ['!=', '≠']],
  text: [['=', 'equals'], ['!=', 'does not equal'], ['contains', 'contains'], ['startsWith', 'starts with'], ['endsWith', 'ends with']],
  enum: [['=', 'is'], ['!=', 'is not']],
  country: [['=', 'is'], ['!=', 'is not']],
};

// Reuse the full accepted-countries list (single source of truth shared with the
// cohort builder) so the playlist country filter is fully populated + searchable.
export const PL_COUNTRIES: [string, string, string][] = CO_COUNTRIES;

export type PlCondition = { field: string; op: string; value: string };
export type PlFilter = { conditions: PlCondition[] };

export const plEmptyCond = (): PlCondition => ({ field: 'hasErrors', op: '=', value: 'true' });
export const plFieldDef = (v: string): PlField => PL_FIELDS.find((f) => f.value === v) || PL_FIELDS[0];
