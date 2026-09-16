/* Cohorts fixtures + condition taxonomy — future API-swap point. */
import { relTime } from "@/lib/format";

export type CohortKind = "AUTO" | "MANUAL";

export type Cohort = {
  id: number;
  n: string;
  d: string;
  m: number;
  kind: CohortKind;
  lc: string;
  cond: [string, string, string][];
  /** The assistant created this cohort → shows the "Created with Replayfy AI" badge. */
  createdByAi?: boolean;
};

/** GET /v1/cohorts item (backend CohortsService.toSummary). */
export type ApiCohort = {
  id: number;
  name: string;
  description: string | null;
  kind: CohortKind;
  membersCount?: number;
  filter?: unknown;
  lastComputedAt?: string | null;
  /** True when created by the assistant (agent `cohort.create`) — provenance only. */
  createdByAi?: boolean;
};

type FilterGroup = {
  conditions?: { field: string; op: string; value: unknown }[];
};
type CohortFilter = { groups?: FilterGroup[] };

/** Flatten the nested AND(OR(conditions)) filter into the design's [field,op,value] chips. */
export function flattenCohortFilter(
  filter: unknown,
): [string, string, string][] {
  const f = filter as CohortFilter | null;
  if (!f?.groups) return [];
  const out: [string, string, string][] = [];
  for (const g of f.groups)
    for (const c of g.conditions ?? [])
      out.push([c.field, c.op, String(c.value ?? "")]);
  return out;
}

/** API cohort → the design's Cohort shape. */
export function adaptCohort(c: ApiCohort): Cohort {
  return {
    id: c.id,
    n: c.name,
    d: c.description || "",
    m: c.membersCount ?? 0,
    kind: c.kind,
    lc: relTime(c.lastComputedAt),
    cond: flattenCohortFilter(c.filter),
    createdByAi: c.createdByAi,
  };
}

export const COHORTS: Cohort[] = [
  {
    id: 1,
    n: "Power users · weekly active",
    d: "Logged in ≥4 days in the last 7",
    m: 3180,
    kind: "AUTO",
    lc: "2h ago",
    cond: [
      ["sessions", "≥", "12"],
      ["last_seen", "<", "7d"],
      ["plan", "=", "Pro"],
    ],
  },
  {
    id: 2,
    n: "Enterprise trials",
    d: "On a trial, Enterprise-sized",
    m: 412,
    kind: "AUTO",
    lc: "2h ago",
    cond: [
      ["plan", "=", "Enterprise"],
      ["trial", "=", "active"],
    ],
  },
  {
    id: 3,
    n: "Checkout abandoners",
    d: "Reached checkout, didn’t convert",
    m: 2940,
    kind: "AUTO",
    lc: "15m ago",
    cond: [
      ["page", "=", "/checkout"],
      ["converted", "=", "false"],
      ["rage", "≥", "1"],
    ],
  },
  {
    id: 4,
    n: "Rage-click cohort · 30d",
    d: "≥3 rage clicks in 30 days",
    m: 1240,
    kind: "AUTO",
    lc: "1h ago",
    cond: [
      ["rage", "≥", "3"],
      ["window", "=", "30d"],
    ],
  },
  {
    id: 5,
    n: "Android · 1.4.2",
    d: "On the regressed release",
    m: 8820,
    kind: "AUTO",
    lc: "2h ago",
    cond: [
      ["platform", "=", "Android"],
      ["app_version", "=", "1.4.2"],
    ],
  },
  {
    id: 6,
    n: "VIP accounts",
    d: "Hand-picked key accounts",
    m: 48,
    kind: "MANUAL",
    lc: "Apr 2",
    cond: [],
  },
];

/* ── cohort condition taxonomy — value input + operator set both adapt to the
   selected field's `kind` (mirrors the cohort builder). ── */
export type CoFieldKind =
  | "number"
  | "recency"
  | "enum"
  | "text"
  | "country"
  | "bool"
  | "event";

export type CoField = {
  value: string;
  label: string;
  kind: CoFieldKind;
  icon: string;
  options?: string[];
};

export const CO_FIELDS: CoField[] = [
  { value: "sessions", label: "Total sessions", kind: "number", icon: "rec" },
  { value: "last_seen", label: "Last seen", kind: "recency", icon: "clock" },
  { value: "first_seen", label: "First seen", kind: "recency", icon: "clock" },
  {
    value: "plan",
    label: "Plan",
    kind: "enum",
    icon: "plus",
    options: ["Free", "Pro", "Team", "Enterprise"],
  },
  {
    value: "platform",
    label: "Platform",
    kind: "enum",
    icon: "monitor",
    options: ["Web", "iOS", "Android"],
  },
  {
    value: "device",
    label: "Device",
    kind: "enum",
    icon: "phone",
    options: ["Desktop", "Mobile", "Tablet"],
  },
  {
    value: "browser",
    label: "Browser",
    kind: "enum",
    icon: "console",
    options: ["Chrome", "Safari", "Firefox", "Edge", "Opera", "Brave"],
  },
  {
    value: "os",
    label: "OS",
    kind: "enum",
    icon: "settings",
    options: ["macOS", "Windows", "iOS", "Android", "Linux", "ChromeOS"],
  },
  { value: "app_version", label: "App version", kind: "text", icon: "hash" },
  { value: "country", label: "Country", kind: "country", icon: "globe" },
  { value: "city", label: "City", kind: "text", icon: "pin" },
  { value: "email", label: "Email", kind: "text", icon: "users" },
  { value: "name", label: "Name", kind: "text", icon: "users" },
  {
    value: "is_online",
    label: "Currently online",
    kind: "bool",
    icon: "spark",
  },
  { value: "is_identified", label: "Identified", kind: "bool", icon: "users" },
  { value: "rage", label: "Rage clicks", kind: "number", icon: "cursor" },
  { value: "dead", label: "Dead clicks", kind: "number", icon: "cursor" },
  { value: "errors", label: "Error count", kind: "number", icon: "warn" },
  { value: "did_event", label: "Did event", kind: "event", icon: "spark" },
];

export const CO_OPS: Record<CoFieldKind, [string, string][]> = {
  bool: [
    ["is_true", "is true"],
    ["is_false", "is false"],
  ],
  number: [
    [">=", "≥"],
    [">", ">"],
    ["=", "="],
    ["<", "<"],
    ["<=", "≤"],
    ["!=", "≠"],
  ],
  text: [
    ["=", "equals"],
    ["!=", "does not equal"],
    ["contains", "contains"],
    ["startsWith", "starts with"],
    ["endsWith", "ends with"],
  ],
  enum: [
    ["=", "is"],
    ["!=", "is not"],
  ],
  country: [
    ["=", "is"],
    ["!=", "is not"],
  ],
  recency: [
    ["within", "within the last"],
    ["before", "more than"],
  ],
  event: [
    ["fired", "fired"],
    ["not_fired", "did not fire"],
  ],
};

// Accepted countries for the location filter — a broad set of the major markets
// across every region (searchable, so order is alphabetical by name).
export const CO_COUNTRIES: [string, string, string][] = [
  ["AR", "🇦🇷", "Argentina"],
  ["AU", "🇦🇺", "Australia"],
  ["AT", "🇦🇹", "Austria"],
  ["BE", "🇧🇪", "Belgium"],
  ["BR", "🇧🇷", "Brazil"],
  ["BG", "🇧🇬", "Bulgaria"],
  ["CA", "🇨🇦", "Canada"],
  ["CL", "🇨🇱", "Chile"],
  ["CN", "🇨🇳", "China"],
  ["CO", "🇨🇴", "Colombia"],
  ["HR", "🇭🇷", "Croatia"],
  ["CZ", "🇨🇿", "Czechia"],
  ["DK", "🇩🇰", "Denmark"],
  ["EG", "🇪🇬", "Egypt"],
  ["FI", "🇫🇮", "Finland"],
  ["FR", "🇫🇷", "France"],
  ["DE", "🇩🇪", "Germany"],
  ["GR", "🇬🇷", "Greece"],
  ["HK", "🇭🇰", "Hong Kong"],
  ["HU", "🇭🇺", "Hungary"],
  ["IN", "🇮🇳", "India"],
  ["ID", "🇮🇩", "Indonesia"],
  ["IE", "🇮🇪", "Ireland"],
  ["IL", "🇮🇱", "Israel"],
  ["IT", "🇮🇹", "Italy"],
  ["JP", "🇯🇵", "Japan"],
  ["KE", "🇰🇪", "Kenya"],
  ["MY", "🇲🇾", "Malaysia"],
  ["MX", "🇲🇽", "Mexico"],
  ["NL", "🇳🇱", "Netherlands"],
  ["NZ", "🇳🇿", "New Zealand"],
  ["NG", "🇳🇬", "Nigeria"],
  ["NO", "🇳🇴", "Norway"],
  ["PK", "🇵🇰", "Pakistan"],
  ["PE", "🇵🇪", "Peru"],
  ["PH", "🇵🇭", "Philippines"],
  ["PL", "🇵🇱", "Poland"],
  ["PT", "🇵🇹", "Portugal"],
  ["RO", "🇷🇴", "Romania"],
  ["SA", "🇸🇦", "Saudi Arabia"],
  ["SG", "🇸🇬", "Singapore"],
  ["ZA", "🇿🇦", "South Africa"],
  ["KR", "🇰🇷", "South Korea"],
  ["ES", "🇪🇸", "Spain"],
  ["SE", "🇸🇪", "Sweden"],
  ["CH", "🇨🇭", "Switzerland"],
  ["TW", "🇹🇼", "Taiwan"],
  ["TH", "🇹🇭", "Thailand"],
  ["TR", "🇹🇷", "Türkiye"],
  ["AE", "🇦🇪", "United Arab Emirates"],
  ["GB", "🇬🇧", "United Kingdom"],
  ["US", "🇺🇸", "United States"],
  ["UA", "🇺🇦", "Ukraine"],
  ["VN", "🇻🇳", "Vietnam"],
];

export type CoCond = { field: string; op: string; value: string };

/* Presentation-only grouping for the field picker (mirrors the funnel .fn-fp2
   palette's grouped command list). Purely how CO_FIELDS are laid out in the
   dropdown — the rule MODEL (CO_FIELDS / CO_OPS / coFieldDef) is unchanged. */
export const CO_FGROUPS: { title: string; fields: string[] }[] = [
  {
    title: "Activity",
    fields: [
      "sessions",
      "last_seen",
      "first_seen",
      "rage",
      "dead",
      "errors",
      "did_event",
    ],
  },
  {
    title: "Identity",
    fields: ["plan", "email", "name", "is_online", "is_identified"],
  },
  {
    title: "Environment",
    fields: ["platform", "device", "browser", "os", "app_version"],
  },
  { title: "Location", fields: ["country", "city"] },
];

export const coFieldDef = (v: string): CoField =>
  CO_FIELDS.find((f) => f.value === v) || CO_FIELDS[0];
export const coDefaultValue = (f: CoField): string =>
  f.kind === "bool"
    ? "true"
    : f.kind === "enum"
      ? f.options![0]
      : f.kind === "country"
        ? "US"
        : f.kind === "recency"
          ? "7"
          : f.kind === "number"
            ? ""
            : "";
export const coEmptyCond = (): CoCond => ({
  field: "plan",
  op: "=",
  value: "Pro",
});

/* ── builder → backend filter ────────────────────────────────────────────────
   The backend cohort engine (CohortsService) speaks a canonical
   { type:'and', groups:[{ type:'or', conditions:[{field,op,value}] }] } tree and
   only understands a fixed set of fields/ops (SUPPORTED_FIELDS). We translate the
   builder's chips into that shape, mapping field names + operators and DROPPING
   conditions the engine can't express (rather than sending them and having the
   engine silently match everyone). "match all" → one condition per group (AND);
   "match any" → all conditions in a single OR group. */
export type BuiltCondition = { field: string; op: string; value: unknown };
export type BuiltFilter = {
  type: "and";
  groups: { type: "or"; conditions: BuiltCondition[] }[];
};

const CO_FIELD_MAP: Record<string, string> = {
  sessions: "sessions_count",
  last_seen: "last_seen",
  plan: "plan",
  device: "device",
  browser: "browser",
  os: "os",
  country: "country",
  city: "city",
  email: "email",
  name: "name",
  is_online: "is_online",
  did_event: "event",
};
// Unmapped builder fields (platform, app_version, first_seen, is_identified, rage,
// dead, errors) have no backend equivalent yet and are dropped from the filter.
const CO_NUM_OP: Record<string, string> = { ">=": "≥", ">": ">", "=": "=" };
const CO_REC_OP: Record<string, string> = {
  within: "within_last_days",
  before: "more_than_days_ago",
};

function coMapCond(c: CoCond): BuiltCondition | null {
  const field = CO_FIELD_MAP[c.field];
  if (!field) return null;
  const kind = coFieldDef(c.field).kind;
  if (kind === "number") {
    const op = CO_NUM_OP[c.op];
    return op ? { field, op, value: Number(c.value) || 0 } : null;
  }
  if (kind === "recency") {
    const op = CO_REC_OP[c.op];
    return op ? { field, op, value: Number(c.value) || 0 } : null;
  }
  if (kind === "bool") return { field, op: c.op, value: c.op === "is_true" };
  return { field, op: c.op, value: c.value };
}

export function condsToFilter(conds: CoCond[], match: string): BuiltFilter {
  const mapped = conds
    .map(coMapCond)
    .filter((c): c is BuiltCondition => c !== null);
  if (match === "any")
    return { type: "and", groups: [{ type: "or", conditions: mapped }] };
  return {
    type: "and",
    groups: mapped.map((c) => ({ type: "or", conditions: [c] })),
  };
}

export const CO_AVATARS: [string, string][] = [
  ["#5b5cf0", "AK"],
  ["#0d9488", "MR"],
  ["#d97706", "JL"],
  ["#db2777", "SP"],
  ["#2563eb", "TN"],
  ["#65a30d", "Rc"],
];
