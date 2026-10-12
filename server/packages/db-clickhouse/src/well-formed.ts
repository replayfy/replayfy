/**
 * Strings every store accepts.
 *
 * A lone UTF-16 surrogate (half of an emoji, typically left by a `.slice()`
 * through one) makes Prisma's query engine reject the WHOLE write ("unexpected
 * end of hex escape at line 1 column N"), and Postgres rejects NUL (\u0000) in
 * text and jsonb. Client strings carry both, so a single stray character in one
 * event label used to fail an entire replay batch on every retry.
 */

// Fallback only: String.prototype.isWellFormed / toWellFormed (ES2024) are
// native on our Node 20 runtimes and ~6x faster than this regex on non-Latin
// text. Separate test/replace regexes, since a /g regex's .test() is stateful.
const LONE_SURROGATE_TEST = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_ALL = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// The tsconfig lib is ES2021, so the ES2024 methods are typed here.
type Es2024String = { isWellFormed?: () => boolean; toWellFormed?: () => string };
const NATIVE = typeof (String.prototype as Es2024String).isWellFormed === "function";

/** `s` with lone surrogates replaced by U+FFFD and NUL characters removed.
 *  Returns `s` itself (no allocation) on the normal, already-clean path. */
export function wellFormed(s: string): string {
  const native = s as unknown as Es2024String;
  const clean = NATIVE ? native.isWellFormed!() : !LONE_SURROGATE_TEST.test(s);
  if (clean && s.indexOf("\u0000") === -1) return s;
  let out = clean
    ? s
    : NATIVE
      ? native.toWellFormed!()
      : s.replace(LONE_SURROGATE_ALL, "\uFFFD");
  if (out.indexOf("\u0000") !== -1) out = out.split("\u0000").join("");
  return out;
}

/**
 * Truncate to at most `max` UTF-16 units without splitting a surrogate pair:
 * a cut that would leave half an emoji drops that half instead.
 */
export function truncateWellFormed(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Make every string in a parsed JSON value well-formed, object keys included,
 * IN PLACE. Returns how many strings it had to change (0 on the normal path, so
 * callers can log the rare repair). Iterative, so deep DOM snapshots can't
 * overflow the stack. Cost is one native regex test per string, the same order
 * as the JSON.stringify the persistence path already does per batch.
 */
export function makeWellFormedInPlace(root: unknown): number {
  let repaired = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "string") {
          const w = wellFormed(v);
          if (w !== v) {
            node[i] = w; // only on change: valid input is never written to
            repaired++;
          }
        } else if (v !== null && typeof v === "object") stack.push(v);
      }
    } else if (node !== null && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        let v = obj[key];
        if (typeof v === "string") {
          const w = wellFormed(v);
          if (w !== v) {
            setOwn(obj, key, w);
            v = w;
            repaired++;
          }
        } else if (v !== null && typeof v === "object") stack.push(v);
        const fixedKey = wellFormed(key);
        if (fixedKey !== key) {
          // Never overwrite a sibling: a repaired key that collides keeps the
          // existing value and goes under the next free U+FFFD-suffixed name.
          let target = fixedKey;
          while (Object.prototype.hasOwnProperty.call(obj, target)) target += "\uFFFD";
          setOwn(obj, target, v);
          delete obj[key];
          repaired++;
        }
      }
    }
  }
  return repaired;
}

/** Define an own data property. Plain assignment of a "__proto__" key would call
 *  the prototype setter instead (dropping the key and swapping the prototype). */
function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Row fast path for ClickHouse inserts: repairs each row's string VALUES (and
 * recurses into Map/array columns). Column names are constants, so they are not
 * re-checked on every row of every flush (that cost more than the insert's own
 * serialisation).
 */
export function makeRowsWellFormedInPlace(rows: object[]): void {
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    for (const key in r) {
      const v = r[key];
      if (typeof v === "string") {
        const w = wellFormed(v);
        if (w !== v) r[key] = w;
      } else if (v !== null && typeof v === "object") {
        // Map/array columns (e.g. sessions.attrs) hold client strings too.
        makeWellFormedInPlace(v);
      }
    }
  }
}
