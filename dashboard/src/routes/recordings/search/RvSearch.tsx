/* ============================================================================
   RvSearch — investigation search + filter builder for the Recordings v2 rail.
   Grouped autocomplete · GitHub-style operators · editable filter tokens ·
   saved filters · recents · full keyboard control.

   Three tiers, deliberately not blended — each waits on exactly what it must:
     · STATIC grammar (PROPS: has / duration, the key list) renders on the
       keystroke. It is vocabulary, not data — nothing to wait for.
     · BOUNDED values (browsers, devices, countries) are preloaded once when the
       Recordings route mounts and filtered locally, so they also render on the
       keystroke — no request, no skeleton, however long the network takes.
     · UNBOUNDED values (users, pages) cannot be preloaded — millions of rows —
       so they stay on the debounced typeahead and show a skeleton while in
       flight. Neither tier above ever blocks behind them.
   suggest.ts owns that split (the API declares which types are bounded); this
   file just renders whatever rows it hands back. Rows are grouped by the `type`
   the API returns — this file never guesses what a value is from how it looks.
   ========================================================================== */
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  Fragment,
  useState,
  useRef,
  useEffect,
  useMemo,
} from "react";
import { Sk } from "@/components/feedback";
import { countryName } from "@/lib/device-format";
import {
  PROPS,
  SAVED,
  loadRecents,
  saveRecents,
  RECENTS_MAX,
  type FilterToken,
  type SearchToken,
} from "./search.data";
import { KEY_TO_TYPE, SUGGEST_META, SUGGEST_TYPES, useSuggest } from "./suggest";
import { displayQuery, isExtensionOf, parseQuery, recentFor } from "./recents";
import { useAuth } from "@/lib/auth";

type Apply =
  | { type: "continue"; key: string }
  | { type: "token"; token: SearchToken }
  /** A saved filter expands to SEVERAL tokens at once — the one apply that is
   *  not 1:1 with a row, which is why it carries a list rather than a token. */
  | { type: "saved"; tokens: SearchToken[] }
  /** A recent is a whole finished query, so it REPLACES the bar where every
   *  other row adds to it: "run that search again", not "merge it into this
   *  one", which would run neither. Carries the raw stored string — parsing it
   *  is what restores the endUserId the suggestion originally resolved. */
  | { type: "recent"; q: string }
  | { type: "term"; value: string };
type GroupItem = {
  label: string;
  suffix?: string;
  sub?: string;
  q?: string;
  apply: Apply;
};
type Group = {
  cat: string;
  icon: string;
  items: GroupItem[];
  /** Values still in flight — render skeleton rows, not `items`. */
  loading?: boolean;
};

/* tiny inline category glyphs (kept deliberately simple) */
const G: Record<string, string> = {
  user: "M8 8.2a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6M3.4 13c.4-2.1 2.2-3.3 4.6-3.3s4.2 1.2 4.6 3.3",
  mail: "M2.5 4.5h11v7h-11zM2.7 5 8 9l5.3-4",
  globe:
    "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11M2.6 8h10.8M8 2.5c1.7 1.6 1.7 9.4 0 11M8 2.5c-1.7 1.6-1.7 9.4 0 11",
  monitor: "M2.5 3.5h11v7h-11zM6 13h4M8 10.5V13",
  device:
    "M5 2.5h6a.8.8 0 0 1 .8.8v9.4a.8.8 0 0 1-.8.8H5a.8.8 0 0 1-.8-.8V3.3a.8.8 0 0 1 .8-.8M7 12h2",
  flag: "M4 2.5v11M4 3.2h7l-1.4 2.3L11 7.8H4",
  pin: "M8 14s4-3.6 4-7a4 4 0 1 0-8 0c0 3.4 4 7 4 7M8 8.2a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8",
  path: "M6.2 13 9.8 3M4.5 5.5 2.5 8l2 2.5M11.5 5.5 13.5 8l-2 2.5",
  alert: "M8 2.7 14 13H2zM8 6.5v3.2M8 11.4h.01",
  tag: "M3 3h4.5l5.5 5.5-4.5 4.5L3 7.5zM5.4 5.4h.01",
  bolt: "M8.6 2.5 4 9h3.2l-.8 4.5L11 7H7.8z",
  op: "M5.5 4 2.5 8l3 4M10.5 4l3 4-3 4",
  clock: "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11M8 5v3.2l2 1.3",
  star: "M8 2.5 9.6 6l3.9.4-2.9 2.6.8 3.8L8 11.5 4.6 12.4l.8-3.8L2.5 6 6.4 6z",
  hash: "M6 2.5 4.5 13.5M11.5 2.5 10 13.5M3 5.5h10M2.5 10.5h10",
};
function Gi({ k, size = 13 }: { k: string; size?: number }) {
  const d = G[k] || G.op;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {d
        .split("M")
        .filter(Boolean)
        .map((s, i) => (
          <path key={i} d={"M" + s} />
        ))}
    </svg>
  );
}

const opLabel = (op: string) => op;
const keyIcon = (key: string) => PROPS[key]?.icon || "op";

/* The search grammar, surfaced. An empty bar used to show only Saved + Recents,
   so a first-time user had no way to learn the bar takes filters at all — the
   canonical case being "I didn't know I could search by a user's email". This
   is the Stripe "Suggested filters" idea: list every filterable dimension with
   a worked example and a plain-English description, so the capability is legible
   without typing a key first. Clicking one enters that filter (same as typing
   `user:`); the example VALUE is illustrative — real values come from the
   workspace once the key is entered.

   Ordered by how often a debugging session reaches for each. `desc` is written
   here rather than pulled from PROPS.hint because the hints are terse operator
   notes ("visited path"); this line is the one a newcomer reads. Every key here
   is a real PROPS entry — a typo would surface a filter that can't be entered. */
const SUGGESTED: { key: string; example: string; desc: string }[] = [
  { key: "user", example: "jenny@acme.io", desc: "by email, name or ID" },
  { key: "has", example: "error", desc: "sessions with a signal" },
  { key: "page", example: "/checkout", desc: "path visited" },
  { key: "browser", example: "Chrome", desc: "browser name" },
  { key: "device", example: "Desktop", desc: "device type" },
  { key: "model", example: "iPhone 17", desc: "hardware model" },
  { key: "country", example: "United States", desc: "visitor country" },
  { key: "duration", example: "2m", desc: "session length" },
];
/** The prefix clicking a key drops into the bar — respects each key's operator
 *  so duration lands on `duration:>` (it ONLY filters on `>`), not `duration:`
 *  which the backend would drop as unapplied. */
const enterPrefix = (key: string) => {
  const op = PROPS[key]?.defOp ?? ":";
  return op === ":" ? `${key}:` : `${key}${op}`;
};

/* Rows shown for a single key's values ("country:"). The server capped its own
   reply at 6/type, but a BOUNDED type now arrives complete — every country the
   workspace has ever seen — so the dropdown, not the wire, has to be the thing
   that keeps this list a list. Ranked count-desc by the API, so the head is the
   useful end, and typing narrows it further. */
const VALUE_ROWS = 8;

/* highlight matched substring */
function hl(text: string, q?: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** What the typed input is asking for. Drives BOTH the static groups and the
 *  suggest request, so the two can never disagree about the query. */
type Mode =
  | { kind: "empty" }
  /** "browser:" / "browser:ch" — one key's values. */
  | { kind: "value"; key: string; op: string; part: string }
  /** free text — every group at once. */
  | { kind: "text"; q: string };

function readMode(input: string): Mode {
  const q = input.trim();
  if (!q) return { kind: "empty" };
  const m = q.match(/^([a-zA-Z]+)\s*([:≠><~])\s*(.*)$/);
  if (m && PROPS[m[1].toLowerCase()]) {
    const key = m[1].toLowerCase();
    const def = PROPS[key];
    /* Honour the typed operator only if the key actually supports it; otherwise
       fall back to the one the backend can apply. Every key today has exactly
       one operator, so this always resolves to that one — which is why
       `duration<30s` and `duration:1m` both become `duration>`: the sessions
       list has only minDurationMs (no upper bound, no equality), so `<` / `:`
       would build a chip it silently ignores — the "why is duration not
       applied" report. `normalizeOp` rewrites the INPUT to match, so the field,
       this header and the token it builds never disagree. */
    const op = def.ops.includes(m[2]) ? m[2] : def.defOp;
    return { kind: "value", key, op, part: m[3] || "" };
  }
  return { kind: "text", q };
}

/** Coerce a typed operator to the one its key supports, so the search bar can't
 *  show `duration<30s` while the dropdown says "greater than" and the token it
 *  builds is `>`. Same length in → out (one op char for one), so the caret
 *  never jumps. Non-keys and already-valid operators pass straight through. */
function normalizeOp(raw: string): string {
  const m = raw.match(/^([a-zA-Z]+)\s*([:≠><~])(.*)$/);
  if (!m) return raw;
  const def = PROPS[m[1].toLowerCase()];
  if (!def || def.ops.includes(m[2])) return raw;
  return `${m[1]}${def.defOp}${m[3]}`;
}

const opWord = (op: string) =>
  op === ":" ? "is" : op === "≠" ? "is not" : op === ">" ? "greater than" : op === "<" ? "less than" : "contains";

export function RvSearch({
  tokens,
  setTokens,
}: {
  tokens: FilterToken[];
  setTokens: Dispatch<SetStateAction<FilterToken[]>>;
}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /* Per workspace: a recent can name a real customer, and switching workspace
     is a full page load, so this component always mounts under the right one. */
  const { workspaceId } = useAuth();
  const [recents, setRecents] = useState<string[]>(() => loadRecents(workspaceId));
  const [edit, setEdit] = useState<string | null>(null); // token id being value-edited
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const mode = useMemo(() => readMode(input), [input]);

  /* Which groups to ask the API for, and with what text. In value mode that's
     the one dimension being completed; in text mode it's every dimension at
     once — one request, not one per group (the endpoint unpivots them). */
  const suggestTypes = useMemo(() => {
    if (mode.kind === "value")
      return PROPS[mode.key]?.dynamic ? [KEY_TO_TYPE[mode.key]] : [];
    return mode.kind === "text" ? SUGGEST_TYPES : [];
  }, [mode]);
  const suggestQ = mode.kind === "value" ? mode.part : mode.kind === "text" ? mode.q : "";
  const {
    items: suggestions,
    busy: suggestBusy,
    error: suggestError,
  } = useSuggest(suggestQ, suggestTypes, open);

  const groups = useMemo<Group[] | null>(() => {
    if (mode.kind === "empty") return null; // → recents / saved

    /* ---- value mode: one key's values ---- */
    if (mode.kind === "value") {
      const def = PROPS[mode.key];
      const cat = `${def.label} ${opWord(mode.op)}`;
      if (def.dynamic) {
        const type = KEY_TO_TYPE[mode.key];
        return [
          {
            cat,
            icon: def.icon,
            // Bounded types are never busy — their values are already cached,
            // so this stays false and no skeleton ever renders for them.
            loading: suggestBusy,
            items: suggestions
              .filter((s) => s.type === type)
              .slice(0, VALUE_ROWS)
              .map((s) => ({
                // `country` is stored as an ISO alpha-2 code; show the full name
                // ("NG" → "Nigeria") to match the recordings-list rows, while the
                // applied token value stays the ISO the WHERE clause filters on.
                label: s.type === "country" ? countryName(s.value) : s.value,
                sub: s.sub ?? (s.count ? `${s.count}` : undefined),
                q: mode.part,
                apply: {
                  type: "token" as const,
                  token: {
                    key: SUGGEST_META[s.type].key,
                    op: mode.op,
                    value: s.value,
                    ...(s.id !== undefined ? { endUserId: s.id } : {}),
                  },
                },
              })),
          },
        ];
      }
      const part = mode.part.toLowerCase();
      return [
        {
          cat,
          icon: def.icon,
          items: def.values
            .filter((v) => v.toLowerCase().includes(part))
            .map((v) => ({
              label: v,
              q: mode.part,
              apply: { type: "token", token: { key: mode.key, op: mode.op, value: v } },
            })),
        },
      ];
    }

    /* ---- text mode: static keys first, then whatever the API typed ---- */
    const ql = mode.q.toLowerCase();
    const out: Group[] = [];
    /* Saved filters, matched on NAME and on what they expand to — typing
       "error" should reach "Has errors" the same way typing "has errors" does,
       without having to know the preset spells itself has:error.

       They go FIRST because a whole named filter is a stronger match for what
       you typed than any single value inside it. Until now they lived ONLY in
       the empty state, so they disappeared the instant you typed a character —
       which is precisely the moment you are reaching for one. */
    const saved = SAVED.filter(
      (s) =>
        s.name.toLowerCase().includes(ql) ||
        s.tokens.some((t) =>
          `${t.key}${t.op}${t.value}`.toLowerCase().includes(ql),
        ),
    ).slice(0, 4);
    if (saved.length)
      out.push({
        cat: "Saved filters",
        icon: "star",
        items: saved.map((s) => ({
          label: s.name,
          sub: s.tokens.map((t) => `${t.key}${t.op}${t.value}`).join(" · "),
          q: ql,
          apply: { type: "saved", tokens: s.tokens },
        })),
      });
    const props = Object.entries(PROPS)
      .filter(([k, d]) => k.startsWith(ql) || d.label.toLowerCase().includes(ql))
      .slice(0, 5);
    if (props.length)
      out.push({
        cat: "Filters",
        icon: "op",
        items: props.map(([k, d]) => ({
          label: k,
          suffix: ":",
          sub: d.hint,
          q: ql,
          apply: { type: "continue", key: k },
        })),
      });
    // Static enum values that match the raw text ("error" → has:error), so the
    // grammar stays reachable without typing the key first.
    for (const [k, d] of Object.entries(PROPS)) {
      if (d.dynamic) continue;
      const vals = d.values.filter((v) => v.toLowerCase().includes(ql)).slice(0, 4);
      if (!vals.length) continue;
      out.push({
        cat: d.label,
        icon: d.icon,
        items: vals.map((v) => ({
          label: v,
          q: ql,
          apply: { type: "token", token: { key: k, op: d.defOp, value: v } },
        })),
      });
    }
    /* The UNBOUNDED half (users, pages) is still in flight. Which of those
       groups will come back is the API's answer, not ours — so the placeholder
       is one neutral block rather than invented headers that would vanish as
       soon as it resolves. It goes FIRST because the types it stands in for
       sort first, and it no longer RETURNS: the bounded half below is already
       in hand from the preloaded facets and must not wait behind the network.
       That is the whole point of the split — this early-return was the last
       place a cached value could still be held hostage by a slow typeahead. */
    if (suggestBusy)
      out.push({ cat: "Searching workspace…", icon: "op", items: [], loading: true });
    // Group BY the server's `type`. SUGGEST_TYPES only fixes the order.
    for (const type of SUGGEST_TYPES) {
      const rows = suggestions.filter((s) => s.type === type).slice(0, 4);
      if (!rows.length) continue;
      const meta = SUGGEST_META[type];
      out.push({
        cat: meta.label,
        icon: meta.icon,
        items: rows.map((s) => ({
          label: s.value,
          sub: s.sub,
          q: ql,
          apply: {
            type: "token",
            token: {
              key: meta.key,
              op: ":",
              value: s.value,
              ...(s.id !== undefined ? { endUserId: s.id } : {}),
            },
          },
        })),
      });
    }
    return out;
  }, [mode, suggestions, suggestBusy]);

  useEffect(() => {
    setActive(0);
  }, [input]);
  /* Reset the highlight EVERY time the dropdown opens, not only when the input
     text changes. Without this, applying a recent (which closes the panel with
     the input still "") left `active` frozen at whatever row was last selected;
     reopening kept that stale index, and if it was the last row, ↓ was clamped
     to it and appeared dead. Re-arming on open makes ↑↓ reliable on every open —
     the "arrows only work the first time" report. */
  useEffect(() => {
    if (open) setActive(0);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  // ⌘K / Ctrl-K focuses THIS investigation search (not the global palette).
  useEffect(() => {
    const onCmdK = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        e.stopPropagation();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onCmdK, true);
    return () => document.removeEventListener("keydown", onCmdK, true);
  }, []);

  /* Recents are recorded ON COMMIT, not on submit — this search HAS no submit
     button, and the list re-queries off `tokens` live, so "the search you ran"
     is whatever was in the bar when you stopped composing.

     `open` is the whole noise filter. addTokens() reopens the dropdown after
     every pick, so it is true for the entire composition and goes false exactly
     where a person is done: Escape, click-away, the backdrop. A three-chip
     query therefore records once, at the end — not three times on the way
     through, which is what recording inside addTokens would do.

     Not hooked to input blur: the empty-state Saved rows have no mousedown
     guard, so closing on blur would unmount them out from under their own click.

     This REPLACES the old pushRecent, which fired from one branch of the Enter
     handler — the branch reached only when the dropdown had ZERO rows. So it
     could only ever store a dead-end word that matched nothing in the workspace,
     and never a composed query like `page:/checkout has:error`. Everything built
     the intended way (pick a suggestion, click a row, tab-complete) went through
     apply() and recorded nothing at all, which is why the group never appeared. */
  const activeQ = useMemo(() => recentFor(tokens), [tokens]);
  const lastRecordedRef = useRef<string | null>(null);
  useEffect(() => {
    if (open || !activeQ || activeQ === lastRecordedRef.current) return;
    const prevQ = lastRecordedRef.current;
    lastRecordedRef.current = activeQ;
    // Narrowing writes ONE entry, not a trail of its own prefixes: has:error →
    // has:error browser:Chrome supersedes rather than stacks. Only ever against
    // the immediately-previous record, so this is "the search I just narrowed",
    // not "any older search that happens to be a prefix".
    const base =
      prevQ && isExtensionOf(prevQ, activeQ)
        ? recents.filter((r) => r !== prevQ)
        : recents;
    const next = [activeQ, ...base.filter((r) => r !== activeQ)].slice(
      0,
      RECENTS_MAX,
    );
    setRecents(next);
    saveRecents(workspaceId, next);
    // Re-runs on the new `recents`; the ref check above makes that a no-op.
  }, [open, activeQ, recents, workspaceId]);

  /* Every recent shows, including the one currently in the bar. Hiding that one
     as "redundant with the chips above" costs more than it saves: the common
     path is run a search → close → reopen with the chip still applied, and the
     Recent group would be empty again at exactly the moment you went looking
     for proof it had remembered anything. A history list that hides your most
     recent search reads as broken. */
  const visibleRecents = recents;

  /* The empty state's OWN rows, in render order. `groups` is null here (there
     is nothing typed to group), so without this the dropdown's most-used state
     had no rows at all in `flat`: ↑↓ moved an index that pointed nowhere and ↵
     fell through to the "search as text" branch — while the footer sat there
     advertising "↑↓ navigate · ↵ apply". These are ordinary rows and now nav
     like ordinary rows; they keep their own markup below (the gold star, the
     mono recents) rather than being folded into the generic renderer, which
     would have restyled them. */
  const emptyRows = useMemo<GroupItem[]>(
    () => [
      // Recent leads when present — recency is the strongest intent signal. With
      // no recents the list falls straight through to Suggested → Saved, so a
      // first-time user still meets the grammar first. Keyboard order below must
      // match this EXACTLY — Recents, then Suggested, then Saved.
      ...visibleRecents.map((r) => ({
        label: r,
        apply: { type: "recent" as const, q: r },
      })),
      ...SUGGESTED.map((s) => ({
        label: s.key,
        apply: { type: "continue" as const, key: s.key },
      })),
      ...SAVED.map((s) => ({
        label: s.name,
        apply: { type: "saved" as const, tokens: s.tokens },
      })),
    ],
    [visibleRecents],
  );

  // Keyboard nav walks REAL rows only — a skeleton is not selectable.
  const flat = useMemo(
    () =>
      groups === null
        ? emptyRows
        : groups.flatMap((g) =>
            g.loading ? [] : g.items.map((it) => ({ ...it, cat: g.cat })),
          ),
    [groups, emptyRows],
  );

  // adding a filter replaces any existing token with the same property+operator
  // (so selecting e.g. duration twice tracks one value instead of stacking dupes)
  const addTokens = (list: SearchToken[]) => {
    setTokens((prev) => {
      // Folded one at a time so a saved filter obeys the same same-key-replaces
      // rule as a hand-picked one, and so `join` stays null on whichever token
      // ends up first regardless of how many arrive together.
      let next = prev;
      for (const t of list) {
        const kept = next.filter((x) => !(x.key === t.key && x.op === t.op));
        next = [
          ...kept,
          {
            ...t,
            id: "f" + Date.now() + Math.random(),
            join: kept.length ? "and" : null,
          },
        ];
      }
      return next;
    });
    setInput("");
    setOpen(true);
    inputRef.current?.focus();
  };
  const addToken = (t: SearchToken) => addTokens([t]);
  const apply = (a: Apply) => {
    if (!a) return;
    if (a.type === "continue") {
      // enterPrefix, not `key + ":"`, so duration lands on `duration:>`.
      setInput(enterPrefix(a.key));
      inputRef.current?.focus();
    } else if (a.type === "token") addToken(a.token);
    else if (a.type === "saved") addTokens(a.tokens);
    else if (a.type === "recent") {
      // parseQuery restores the endUserId, so re-running a recent is the same
      // indexed query it was the first time — not a widened substring match.
      setTokens(
        parseQuery(a.q).map((t, i) => ({
          ...t,
          id: "f" + Date.now() + i,
          join: i ? "and" : null,
        })),
      );
      setInput("");
      setOpen(false);
    } else if (a.type === "term")
      addToken({ key: "text", op: ":", value: a.value });
  };

  // inline ghost completion (editor ghost-completion style) from the active suggestion
  const top = flat[active] || flat[0];
  const frag = input.split(/[:≠><~]/).pop() || "";
  let ghost = "";
  if (open && top && input) {
    if (top.apply.type === "continue") {
      const comp = top.label + (top.suffix || ":");
      if (
        comp.toLowerCase().startsWith(input.toLowerCase()) &&
        comp.length > input.length
      )
        ghost = comp.slice(input.length);
    } else if (top.apply.type === "token") {
      const val = String(top.apply.token.value);
      if (
        val.toLowerCase().startsWith(frag.toLowerCase()) &&
        val.length > frag.length
      )
        ghost = val.slice(frag.length);
    }
  }
  const acceptGhost = () => {
    if (!top || !ghost) return false;
    if (top.apply.type === "continue")
      setInput(top.label + (top.suffix || ":"));
    else {
      const t = (top.apply as { token: SearchToken }).token;
      setInput(
        /[:≠><~]/.test(input) ? t.key + t.op + t.value : String(t.value),
      );
    }
    return true;
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[active]) apply(flat[active].apply);
      // No pushRecent here any more — commit-on-close records the whole query
      // once you are done, and this line could only ever have logged the raw
      // input of a search that matched nothing.
      else if (input.trim()) apply({ type: "term", value: input.trim() });
    } else if (e.key === "Tab") {
      if (ghost) {
        e.preventDefault();
        acceptGhost();
      } else if (flat[active]) {
        e.preventDefault();
        apply(flat[active].apply);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (open) setOpen(false);
      else inputRef.current?.blur();
    } else if (e.key === "Backspace" && input === "" && tokens.length) {
      setTokens(tokens.slice(0, -1));
    }
  };

  const setVal = (tk: FilterToken, value: string) => {
    setTokens(tokens.map((t) => (t.id === tk.id ? { ...t, value } : t)));
  };
  const repick = (tk: FilterToken) => {
    setTokens(tokens.filter((t) => t.id !== tk.id));
    // enterPrefix, not `key + ":"`, so re-picking a duration chip reopens on
    // `duration>` (its real operator), not `duration:` which the header and the
    // rebuilt token would then have to silently correct back to `>`.
    setInput(enterPrefix(tk.key));
    setOpen(true);
    inputRef.current?.focus();
  };

  let gi = -1;

  return (
    <>
      {open && (
        <div className="rv-srch-backdrop" onMouseDown={() => setOpen(false)} />
      )}
      <div className={`rv-srch ${open ? "up" : ""}`} ref={boxRef}>
        <div
          className={`rv-srch-field ${open ? "open" : ""}`}
          onClick={() => {
            setOpen(true);
            inputRef.current?.focus();
          }}
        >
          <Gi k="op" size={13} />
          <div className="rv-srch-tokens">
            {tokens.map((t, i) => (
              <Fragment key={t.id}>
                {i > 0 && (
                  // Static, not a toggle: /v1/sessions ANDs its params, so an
                  // "or" chip could only ever render a lie. It goes back to a
                  // button when the list can express OR.
                  <span className="rv-join">{t.join}</span>
                )}
                <span className="rv-fl">
                  <span className="ki">
                    <Gi k={keyIcon(t.key)} size={11} />
                  </span>
                  <button
                    className="kk"
                    onClick={(e) => {
                      e.stopPropagation();
                      repick(t);
                    }}
                  >
                    {t.key}
                  </button>
                  {/* Each key now has exactly one operator the backend can
                      honour, so this states the operator instead of cycling
                      through ones the list would ignore. */}
                  <span className="oo">{opLabel(t.op)}</span>
                  {edit === t.id ? (
                    <input
                      className="vv-in"
                      autoFocus
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-1p-ignore="true"
                      data-lpignore="true"
                      defaultValue={t.value}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        setVal(t, e.target.value);
                        setEdit(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          setVal(t, (e.target as HTMLInputElement).value);
                          setEdit(null);
                        }
                        if (e.key === "Escape") setEdit(null);
                      }}
                    />
                  ) : (
                    <button
                      className="vv"
                      // Long values (emails) truncate with an ellipsis in the
                      // narrow rail; the title keeps the full value reachable.
                      title={String(t.value)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEdit(t.id);
                      }}
                    >
                      {t.value}
                    </button>
                  )}
                  <button
                    className="xx"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTokens(tokens.filter((x) => x.id !== t.id));
                    }}
                  >
                    <svg width="9" height="9" viewBox="0 0 9 9">
                      <path
                        d="M1.5 1.5 7.5 7.5M7.5 1.5 1.5 7.5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </span>
              </Fragment>
            ))}
            <span className="rv-srch-inwrap">
              <span className="rv-srch-ghost" aria-hidden="true">
                <span className="typed">{input}</span>
                <span className="sfx">{ghost}</span>
              </span>
              <input
                ref={inputRef}
                className="rv-srch-in"
                value={input}
                placeholder={
                  tokens.length ? "" : "Search or filter recordings…"
                }
                onChange={(e) => {
                  setInput(normalizeOp(e.target.value));
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={onKey}
                spellCheck={false}
                /* Kill the browser's email/address autofill (and 1Password /
                   LastPass overlays) — this is a filter box, not a login field,
                   and Chrome heuristically offered to autofill an email over it. */
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                name="rv-search"
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
              />
            </span>
          </div>
          {!tokens.length && !input && <span className="rv-srch-kbd">⌘K</span>}
          {tokens.length > 0 && (
            <button
              className="rv-srch-clear"
              onClick={(e) => {
                e.stopPropagation();
                setTokens([]);
                setInput("");
                // Return focus to the input: without it, focus stayed on this
                // button (which then unmounts, tokens now 0) and dropped to
                // <body>, so ↑↓ stopped working until the field was re-clicked.
                inputRef.current?.focus();
                setOpen(true);
              }}
              title="Clear filters"
            >
              <svg width="11" height="11" viewBox="0 0 11 11">
                <path
                  d="M2 2 9 9M9 2 2 9"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>

        {open && (
          <div className="rv-ac">
            {groups === null ? (
              <>
                {/* Recent leads when present — this browser's own history and
                    the strongest intent signal. Hidden (not shown empty) on a
                    first visit, so Suggested naturally leads there instead.
                    Index space matches `emptyRows`: Recents (0…), then
                    Suggested, then Saved. */}
                {visibleRecents.length > 0 && (
                  <div className="rv-ac-grp">
                    <div className="rv-ac-h">Recent</div>
                    {visibleRecents.map((r, i) => (
                      <button
                        key={r}
                        className={`rv-ac-item ${i === active ? "on" : ""}`}
                        onMouseEnter={() => setActive(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => apply({ type: "recent", q: r })}
                      >
                        <span className="ic">
                          <Gi k="clock" size={12} />
                        </span>
                        <span className="lb mono">{displayQuery(r)}</span>
                      </button>
                    ))}
                  </div>
                )}
                {/* Suggested filters — the search grammar made legible. Offset
                    past the recents above in the shared index space. */}
                <div className="rv-ac-grp">
                  <div className="rv-ac-h">Suggested filters</div>
                  {SUGGESTED.map((s, i) => (
                    <button
                      key={s.key}
                      className={`rv-ac-item rv-sug ${visibleRecents.length + i === active ? "on" : ""}`}
                      onMouseEnter={() => setActive(visibleRecents.length + i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => apply({ type: "continue", key: s.key })}
                    >
                      {/* chip carries the KEY, example the VALUE — repeating
                          the key in both (Stripe's `is:` / `is:customer`) reads
                          doubled on a 360px panel, so the example is the value
                          alone. `.mono` example + `:` from the chip still read
                          as one filter. */}
                      <span className="rv-sug-chip">{enterPrefix(s.key)}</span>
                      <span className="rv-sug-ex">{s.example}</span>
                      <span className="rv-sug-desc">{s.desc}</span>
                    </button>
                  ))}
                </div>
                <div className="rv-ac-grp">
                  <div className="rv-ac-h">Saved filters</div>
                  {SAVED.map((s, i) => (
                    <button
                      key={s.name}
                      /* Shared index space — Recents, then Suggested, then SAVED
                         — so ↑↓ and the `on` highlight agree with ↵. Offset past
                         the recents + suggested rows above. */
                      className={`rv-ac-item ${visibleRecents.length + SUGGESTED.length + i === active ? "on" : ""}`}
                      onMouseEnter={() =>
                        setActive(visibleRecents.length + SUGGESTED.length + i)
                      }
                      onMouseDown={(e) => e.preventDefault()}
                      /* Adds, like every other row in this list. It used to
                         setTokens(...) outright, which silently threw away any
                         chips you already had — the same row reached by typing
                         composed instead, so which one you got depended on
                         whether you had pressed a key. */
                      onClick={() => addTokens(s.tokens)}
                    >
                      <span className="ic star">
                        <Gi k="star" size={12} />
                      </span>
                      <span className="lb">{s.name}</span>
                      <span className="rv-ac-meta">
                        {s.tokens
                          .map((t) => `${t.key}${t.op}${t.value}`)
                          .join(" ")}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="rv-ac-foot">
                  <span>
                    <kbd>↑↓</kbd> navigate
                  </span>
                  <span>
                    <kbd>↵</kbd> apply
                  </span>
                  <span>
                    <kbd>tab</kbd> complete
                  </span>
                  <span>
                    <kbd>esc</kbd> close
                  </span>
                </div>
              </>
            ) : flat.length === 0 && !groups.some((g) => g.loading) ? (
              <div className="rv-ac-empty">
                {suggestError ? (
                  <>Couldn’t reach the workspace for matches. Press <kbd>↵</kbd> to search “{input.trim()}” as text.</>
                ) : (
                  <>No matches. Press <kbd>↵</kbd> to search “{input.trim()}” as text.</>
                )}
              </div>
            ) : (
              <>
                {groups.map((g) => (
                  <div className="rv-ac-grp" key={g.cat}>
                    <div className="rv-ac-h">
                      <Gi k={g.icon} size={11} />
                      {g.cat}
                    </div>
                    {g.loading
                      ? Array.from({ length: 3 }, (_, i) => (
                          <div className="rv-ac-item sk" key={i} aria-hidden="true">
                            <span className="ic">
                              <Sk w={12} h={12} r={3} />
                            </span>
                            <span className="lb">
                              <Sk w={`${44 + ((i * 19) % 30)}%`} h={9} />
                            </span>
                          </div>
                        ))
                      : g.items.map((it) => {
                          gi++;
                          const idx = gi;
                          return (
                            <button
                              key={it.label + idx}
                              className={`rv-ac-item ${idx === active ? "on" : ""}`}
                              onMouseEnter={() => setActive(idx)}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => apply(it.apply)}
                            >
                              <span className="ic">
                                <Gi k={g.icon} size={12} />
                              </span>
                              <span className="lb">
                                {hl(it.label, it.q)}
                                {it.suffix && (
                                  <span className="sfx">{it.suffix}</span>
                                )}
                              </span>
                              {it.sub && (
                                <span className="rv-ac-meta">{it.sub}</span>
                              )}
                              {it.apply.type === "continue" && (
                                <span className="rv-ac-kbd">tab</span>
                              )}
                            </button>
                          );
                        })}
                  </div>
                ))}
                <div className="rv-ac-foot">
                  <span>
                    <kbd>↑↓</kbd> navigate
                  </span>
                  <span>
                    <kbd>↵</kbd> apply
                  </span>
                  <span>
                    <kbd>tab</kbd> complete
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
