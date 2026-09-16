/* Funnels helpers — shared pure functions lifted from the legacy page. */
import {
  FN_KINDS,
  FN_MATCH,
  FN_FKIND,
  FN_FVALUES,
  FN_COUNTRIES,
  FN_TEXT_OPS,
  FN_ENUM_OPS,
  FN_NUM_OPS,
  type FnKindDef,
  type FnFilter,
} from "./funnels.data";

/** The "Min duration" chip shows human tokens, but the backend binds this
 *  filter to the NUMERIC duration_ms column — so it must travel as milliseconds.
 *  Sending the raw token made the server do Number("30s") = NaN, i.e.
 *  `duration_ms >= NaN`, which matched zero rows. Both directions are mapped so a
 *  saved funnel round-trips the chip label, not a bare millisecond count. */
const DURATION_TOKEN_MS: Record<string, number> = {
  "10s": 10_000,
  "30s": 30_000,
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
};
const DURATION_MS_TOKEN: Record<string, string> = Object.fromEntries(
  Object.entries(DURATION_TOKEN_MS).map(([tok, ms]) => [String(ms), tok]),
);

export const fmtN = (n: number): string => n.toLocaleString("en-US");
/** ms → compact human duration ("2.6s", "1m 12s", "1h 04m"). Null/negative/
 *  non-finite (e.g. an empty time sample) → "—", never a fabricated 0. */
export const fmtDur = (ms: number | null | undefined): string => {
  if (ms == null || !isFinite(ms) || ms < 0) return "—";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`; // <10s: one decimal
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60),
    rs = s % 60;
  if (m < 60) return rs ? `${m}m ${String(rs).padStart(2, "0")}s` : `${m}m`;
  const h = Math.floor(m / 60),
    rm = m % 60;
  return rm ? `${h}h ${String(rm).padStart(2, "0")}m` : `${h}h`;
};
export const fnKind = (id: string): FnKindDef =>
  FN_KINDS.find((k) => k.id === id) || FN_KINDS[0];
export const fnMatch = (m: string): string =>
  (FN_MATCH.find((x) => x[0] === m) || FN_MATCH[0])[1];
export const fnValuesFor = (key: string): string[] =>
  key === "country" ? FN_COUNTRIES.map((c) => c[0]) : FN_FVALUES[key];
export const fnOpsFor = (key: string): string[] => {
  const k = FN_FKIND[key];
  if (k === "number" || k === "duration") return FN_NUM_OPS;
  if (k === "enum" || k === "bool" || k === "country") return FN_ENUM_OPS;
  return FN_TEXT_OPS;
};
export const fnDefOp = (key: string): string => {
  const k = FN_FKIND[key];
  if (k === "number") return "gte";
  if (k === "enum" || k === "bool" || k === "country") return "is";
  return "contains";
};
export function fnStepIcon(kind: string): string {
  return fnKind(kind).ic;
}
/** URL slug for a funnel name (stable id until the API provides real ids). */
export const fnSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Custom user-attribute filter keys — the "User attribute…" picker entry.
 *  Encoded as `userAttr` (or `userAttr:<name>`); serialized into the backend's
 *  `userAttributes: [{ key, op, value }]` array rather than a flat column. */
const USER_ATTR_PREFIX = "userAttr";
const isUserAttrKey = (k: string): boolean =>
  k === USER_ATTR_PREFIX || k.startsWith(USER_ATTR_PREFIX + ":");
const userAttrName = (k: string): string =>
  k.startsWith(USER_ATTR_PREFIX + ":")
    ? k.slice(USER_ATTR_PREFIX.length + 1)
    : k;

/** Builder filter chips (FnFilter[]) → the backend FunnelFilter body shared by
 *  preview / timeline / breakdown. Ports legacy `serializeFilter`
 *  (the funnel builder): a flat key→value map,
 *  plus an `operators` map for any NON-default operator and a `userAttributes[]`
 *  array for custom-attribute chips. Empty/blank chips are dropped so an
 *  unfilled filter never narrows the query. */
export function serializeFilters(filters: FnFilter[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const operators: Record<string, string> = {};
  const userAttributes: { key: string; op: string; value: string }[] = [];
  for (const f of filters) {
    const v = f.val;
    // Boolean signal chips (Error / Rage / Dead) collapse to a single is-true /
    // is-false choice. Emit a REAL boolean — NOT the string "true"/"false" —
    // BEFORE the blank-chip guard below (which drops the string "false"), so that
    // "is false" survives and the backend reads it as "sessions WITHOUT the
    // signal" (toSegment: hasErrors === false → errors_count = 0).
    if (f.key === "hasErrors" || f.key === "hasRage" || f.key === "hasDead") {
      if (v === "true" || v === "false") out[f.key] = v === "true";
      continue;
    }
    // f.val is always a string (blank chips render as '' or the literal 'false').
    if (v == null || v === "" || v === "false") continue;
    if (isUserAttrKey(f.key)) {
      // TODO(api): the current "User attribute…" chip captures only a value, not
      // a separate attribute NAME; legacy encoded it as `userAttr:<name>`. Until
      // the picker captures the name we forward the raw key/value pair.
      userAttributes.push({
        key: userAttrName(f.key),
        op: f.op === "contains" ? "contains" : "equals",
        value: String(v),
      });
    } else if (f.key === "minDurationMs") {
      // Convert the token to ms; send the operator the UI actually shows (≥ / > /
      // ≤ / <) rather than forcing "gte", so "duration < 1m" filters correctly.
      // (Without the token→ms conversion the backend bound Number("30s")=NaN.)
      const ms = DURATION_TOKEN_MS[String(v)];
      if (ms != null) {
        out[f.key] = ms;
        operators[f.key] = f.op || "gte";
      }
    } else {
      out[f.key] = v;
      // Always send the operator the UI is showing — the backend's per-column
      // default is NOT the same as the builder's for text columns (server-side
      // default is exact "is" while the chip shows "contains"), so omitting it
      // silently turned every default-"contains" text filter into exact-match.
      operators[f.key] = f.op || fnDefOp(f.key);
    }
  }
  if (userAttributes.length > 0) out.userAttributes = userAttributes;
  if (Object.keys(operators).length > 0) out.operators = operators;
  return out;
}

/** The inverse: a saved funnel's `filter` (the map serializeFilters produced) →
 *  builder chips. Reconstructs the flat key/value chips with their non-default
 *  operators, and the userAttributes[] entries. `operators` and `userAttributes`
 *  are the map's own scaffolding, never chips themselves. A funnel with no
 *  segment (filter === null) yields no chips, which is the empty filter bar. */
export function deserializeFilters(
  filter: Record<string, unknown> | null | undefined,
): FnFilter[] {
  if (!filter) return [];
  const ops = (filter.operators as Record<string, string> | undefined) ?? {};
  const out: FnFilter[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "operators" || key === "userAttributes") continue;
    if (value == null || value === "") continue;
    // Duration round-trips as ms on the wire; show the chip its human token back.
    if (key === "minDurationMs") {
      const tok = DURATION_MS_TOKEN[String(value)];
      if (tok) {
        // Round-trip the saved operator (≥ / > / ≤ / <), not the hardcoded default,
        // so re-opening "duration < 1m" shows "<" rather than snapping back to "≥".
        out.push({ key, op: ops[key] ?? fnDefOp(key), val: tok });
        continue;
      }
    }
    out.push({ key, op: ops[key] ?? fnDefOp(key), val: String(value) });
  }
  const userAttrs = filter.userAttributes as
    | { key: string; op: string; value: string }[]
    | undefined;
  for (const a of userAttrs ?? []) {
    // Mirror the encoding serializeFilters read (userAttr:<name>), so the round
    // trip lands on the same chip the picker produced.
    out.push({ key: `userAttr:${a.key}`, op: a.op || "equals", val: a.value });
  }
  return out;
}
