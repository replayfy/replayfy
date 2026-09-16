import { type ReactNode } from "react";

/** Emphasise the matched substring in a result label. Splits `text` on every
 *  case-insensitive occurrence of `query` and wraps each hit in a
 *  <mark class="hl-match"> (styled bold-accent in pages.css), preserving the
 *  original casing. An empty/whitespace query (or no match) returns the text
 *  unchanged, so callers can pass it inline with no branching. */
export function highlightMatch(text: string, query: string): ReactNode {
  const q = (query || "").trim();
  if (!q || !text) return text;
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  let from = hay.indexOf(needle);
  if (from < 0) return text;
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (from >= 0) {
    if (from > i) out.push(text.slice(i, from));
    out.push(
      <mark key={key++} className="hl-match">
        {text.slice(from, from + q.length)}
      </mark>,
    );
    i = from + q.length;
    from = hay.indexOf(needle, i);
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}
