/* ============================================================================
   Recents — the stored string IS the query.

   A Recent row re-runs by parsing its own text back into tokens, so the string
   is not a label: anything we write that parse() cannot read back unchanged is
   a row that runs a DIFFERENT search than the one it shows. That is the same
   class of lie the invented fixtures were deleted for.

   Two things in this grammar break the naive `key + op + value` join:

     · VALUES CONTAIN SPACES. Three of the five `has:` values are "dead click",
       "slow lcp", "long tasks", and the dynamic ones are worse ("United
       States", "iPhone 14 Pro", "Mobile Safari"). Splitting on whitespace turns
       `has:dead click` into has:dead + a stray text term — the first filters on
       a signal that does not exist, the second silently eats the `search` slot.
     · endUserId IS NOT IN THE STRING. A `user` token carries the id its
       suggestion resolved, and tokensToParams spends it on an indexed equality.
       Drop it and `user:` falls back to the single shared `search` slot — which
       a `page:` chip in the same query may already hold — so the page chip
       lands in `unapplied` and a query that worked the first time comes back
       broken.

   Hence the quoting and the `#id` tail, and hence recentFor(): it checks
   serialize against parse BEFORE storing. Rather than hand-proving the two
   agree forever — a new PROPS key with an odd value shape would silently break
   them — every write verifies itself and declines. A query we cannot express is
   not remembered, instead of remembered wrong.

   This lives outside RvSearch.tsx because it is grammar, not component: it
   holds no state, touches no DOM, and is the one part of the search that can be
   checked exhaustively on its own.
   ========================================================================== */
import { PROPS, type SearchToken } from "./search.data";

const TERM_RE = /^([a-zA-Z]+)([:≠><~])(.+)$/;
/** Whitespace-split, except a "quoted value" stays glued to its key. */
const TERM_SPLIT_RE = /(?:[^\s"]|"[^"]*")+/g;
/** `user:"maria@acme.io"#42` — the value is ALWAYS quoted when an id rides
 *  along, which is what keeps a value that merely ends in "#42" unambiguous. */
const USER_ID_RE = /^"([^"]*)"#(\d+)$/;

const unquote = (v: string) =>
  v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;

/** Quote when a bare split would shred it, or when it would be misread as a
 *  filter term — free text `has:error` is not a has: chip. A value containing a
 *  double quote is left alone and simply fails the round-trip check below:
 *  escaping machinery to carry a `"` inside a browser name earns nothing. */
const quoteVal = (v: string) =>
  /[\s"]/.test(v) || TERM_RE.test(v) ? `"${v}"` : v;

/** Turn a raw query string into real filter tokens (used by Recent rows). */
export function parseQuery(str: string): SearchToken[] {
  return (str.trim().match(TERM_SPLIT_RE) ?? []).map((term): SearchToken => {
    const m = term.match(TERM_RE);
    if (!m || !PROPS[m[1].toLowerCase()])
      return { key: "text", op: ":", value: unquote(term) };
    const key = m[1].toLowerCase();
    if (key === "user") {
      const idm = m[3].match(USER_ID_RE);
      if (idm) return { key, op: m[2], value: idm[1], endUserId: Number(idm[2]) };
    }
    return { key, op: m[2], value: unquote(m[3]) };
  });
}

/** The filter bar → the string stored in recents. */
export function serializeTokens(list: SearchToken[]): string {
  return list
    .map((t) => {
      const v = String(t.value).trim();
      // `text` serializes BARE: PROPS has no `text` key, so "text:foo" would
      // parse back into a text token whose value is the literal "text:foo".
      if (t.key === "text") return quoteVal(v);
      if (t.key === "user" && typeof t.endUserId === "number")
        return `${t.key}${t.op}"${v}"#${t.endUserId}`;
      return `${t.key}${t.op}${quoteVal(v)}`;
    })
    .join(" ");
}

const sameTokens = (a: SearchToken[], b: SearchToken[]) =>
  a.length === b.length &&
  a.every(
    (t, i) =>
      t.key === b[i].key &&
      t.op === b[i].op &&
      t.value === b[i].value &&
      (t.endUserId ?? null) === (b[i].endUserId ?? null),
  );

/** The string to store for `tokens`, or "" if it would not survive the trip. */
export function recentFor(tokens: SearchToken[]): string {
  const want: SearchToken[] = tokens
    .map((t) => ({
      key: t.key,
      op: t.op,
      value: String(t.value ?? "").trim(),
      ...(t.endUserId !== undefined ? { endUserId: t.endUserId } : {}),
    }))
    // A chip mid-edit has no value yet, and `page:` re-parses as free text.
    .filter((t) => t.value !== "");
  if (!want.length) return "";
  const s = serializeTokens(want);
  return s && sameTokens(parseQuery(s), want) ? s : "";
}

/** Rows show the query, not its plumbing: the #id is stripped and the quotes
 *  are dropped, so a row reads `has:dead click`, not `has:"dead click"`. */
export const displayQuery = (r: string): string =>
  parseQuery(r)
    .map((t) => (t.key === "text" ? t.value : `${t.key}${t.op}${t.value}`))
    .join(" ");

/** `next` is `prev` plus chips — the same investigation, narrowed. Compared as
 *  whole TERMS, never as keys: `has:error` → `has:rage` shares the `has` key
 *  but is a different search and must not swallow the first. */
export function isExtensionOf(prev: string, next: string): boolean {
  const a: string[] = prev.trim().match(TERM_SPLIT_RE) ?? [];
  const b: string[] = next.trim().match(TERM_SPLIT_RE) ?? [];
  return a.length > 0 && a.length < b.length && a.every((t) => b.includes(t));
}
