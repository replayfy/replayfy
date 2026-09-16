/* Comments fixtures + avatar-hue helper — future API-swap point. */

/** A comment body is a run of segments: `['t', text]` renders as a @mention,
 *  `['', text]` renders as plain text. */
export type CommentSeg = ["t" | "", string];

export type Comment = {
  id?: number;
  n: string;
  time: string;
  at: number;
  tx: CommentSeg[];
  sid: string;
  url: string;
};

/** Shape of GET /v1/comments items (backend CommentsService.toSummary). */
export type ApiComment = {
  id: number;
  body: string;
  atMs?: number;
  sessionPublicId?: string;
  url?: string;
  startUrl?: string;
  author?: { name: string | null; email: string; initials?: string } | null;
  createdAt: string;
};

/** Split a plain comment body into highlight tokens (@mentions + inline paths). */
export function parseSegs(body: string): CommentSeg[] {
  const rx = /(@[\w.]+|\/[\w/.-]+)/g;
  const out: CommentSeg[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(body))) {
    if (m.index > last) out.push(["", body.slice(last, m.index)]);
    out.push(["t", m[0]]);
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(["", body.slice(last)]);
  return out.length ? out : [["", body]];
}

export function relTime(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

/** API comment → the design's Comment shape. */
export function adaptComment(c: ApiComment): Comment {
  return {
    id: c.id,
    n: c.author?.name || c.author?.email || "Someone",
    time: relTime(c.createdAt),
    at: Math.round((c.atMs ?? 0) / 1000),
    tx: parseSegs(c.body || ""),
    sid: c.sessionPublicId || "",
    url: c.url || c.startUrl || "",
  };
}

const CHUES = [
  "#5b5ceb",
  "#c08a3e",
  "#3f9468",
  "#c2599f",
  "#3b76b0",
  "#8b72d6",
];
export function chue(n: string): string {
  let h = 0;
  for (const c of n || "?") h = (h * 31 + c.charCodeAt(0)) % CHUES.length;
  return CHUES[h];
}
export function fmtAt(s: number): string {
  const m = Math.floor(s / 60),
    x = Math.floor(s % 60);
  return m + ":" + String(x).padStart(2, "0");
}

export const COMMENTS: Comment[] = [
  {
    n: "Devon Carter",
    time: "8m ago",
    at: 43,
    tx: [
      ["t", "@maria"],
      [
        "",
        " this 500 at 0:43 is the checkout regression from 1.4.2 — looping in payments.",
      ],
    ],
    sid: "ses_c9d0a4f",
    url: "/checkout",
  },
  {
    n: "Maria Alvarez",
    time: "24m ago",
    at: 122,
    tx: [
      ["", "Confirmed — "],
      ["t", "/api/checkout"],
      [
        "",
        " p95 spiked on Android right after the deploy. Filing a ticket and tagging the release.",
      ],
    ],
    sid: "ses_b2c8810",
    url: "/checkout",
  },
  {
    n: "Priya Nair",
    time: "1h ago",
    at: 31,
    tx: [
      [
        "",
        "The rage clicks on the password reset are still happening. The button looks disabled until you tap it twice.",
      ],
    ],
    sid: "ses_f3a1190",
    url: "/reset-password",
  },
  {
    n: "Sam Okafor",
    time: "3h ago",
    at: 88,
    tx: [
      [
        "",
        "Onboarding drop here is mostly Safari — the date picker doesn’t open. ",
      ],
      ["t", "@devon"],
      ["", " can you repro?"],
    ],
    sid: "ses_d1e4420",
    url: "/signup",
  },
  {
    n: "Leah Brandt",
    time: "5h ago",
    at: 201,
    tx: [
      [
        "",
        "Nice — conversion on the new pricing page is up. Saving this as a winning session for the playlist.",
      ],
    ],
    sid: "ses_k4j7731",
    url: "/pricing",
  },
];
