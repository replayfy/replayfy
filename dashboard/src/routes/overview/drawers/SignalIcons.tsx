/* ============================================================================
   SignalIcons — Replayfy's own investigation glyphs.

   Deliberately NOT the shared outline set. Those are uniform 1.6px strokes
   designed for navigation, and at evidence-card size they read as a generic
   component library sitting in pastel squares.

   This family is drawn instead for meaning and weight:
     - solid forms with knocked-out detail (evenodd) rather than outlines, so a
       glyph reads as one confident shape at 13px instead of a wire drawing;
     - internal opacity steps (.35–.7) to give depth without adding a second
       colour — every icon is a single `currentColor`, so the CALLER owns hue;
     - one 16px grid and one optical weight across the whole set, so severity,
       users, sessions and deployments are distinguishable by silhouette alone.

   The container is not part of the icon. Callers put these on a ~10% tinted
   circle, or on nothing at all — the glyph carries the colour.
   ========================================================================== */

export type SigIconName =
  | "critical" // filled warning triangle — severity
  | "healthy" // filled check circle — resolved / good
  | "ai" // sparkle cluster — Replayfy AI
  | "sessions" // stacked windows
  | "users" // two-user glyph
  | "confidence" // radar / target
  | "performance" // lightning bolt
  | "network" // connected nodes
  | "deployment" // package
  | "regression" // trend arrow down
  | "opportunity" // trend arrow up
  | "crash" // burst
  | "conversion" // funnel
  | "backend" // stacked servers
  | "recency" // clock
  | "activity" // pulse line
  | "category"; // tag

const GLYPH: Record<SigIconName, React.ReactNode> = {
  critical: (
    <path
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M7.13 2.42a1 1 0 0 1 1.74 0l5.6 9.68a1 1 0 0 1-.87 1.5H2.4a1 1 0 0 1-.87-1.5l5.6-9.68ZM7.3 6.3a.7.7 0 0 1 1.4 0v3a.7.7 0 0 1-1.4 0v-3ZM8 12.05a.85.85 0 1 0 0-1.7.85.85 0 0 0 0 1.7Z"
    />
  ),
  healthy: (
    <path
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm3.06 4.9a.75.75 0 0 0-1.12-1L7.2 8.5 6.06 7.3a.75.75 0 1 0-1.1 1.02l1.7 1.84a.75.75 0 0 0 1.1.02l3.3-3.78Z"
    />
  ),
  ai: (
    <>
      <path
        fill="currentColor"
        d="M6.6 1.9a.3.3 0 0 1 .57 0l.75 2.13 2.13.75a.3.3 0 0 1 0 .57l-2.13.75-.75 2.13a.3.3 0 0 1-.57 0l-.75-2.13-2.13-.75a.3.3 0 0 1 0-.57l2.13-.75.75-2.13Z"
      />
      <path
        fill="currentColor"
        opacity=".7"
        d="M11.9 7.5a.25.25 0 0 1 .47 0l.45 1.28 1.28.45a.25.25 0 0 1 0 .47l-1.28.45-.45 1.28a.25.25 0 0 1-.47 0l-.45-1.28-1.28-.45a.25.25 0 0 1 0-.47l1.28-.45.45-1.28Z"
      />
      <path
        fill="currentColor"
        opacity=".45"
        d="M5 10.6a.22.22 0 0 1 .42 0l.36 1.02 1.02.36a.22.22 0 0 1 0 .42l-1.02.36-.36 1.02a.22.22 0 0 1-.42 0l-.36-1.02-1.02-.36a.22.22 0 0 1 0-.42l1.02-.36.36-1.02Z"
      />
    </>
  ),
  sessions: (
    <>
      <path
        fill="currentColor"
        opacity=".35"
        d="M5.6 2.4h6.8A1.6 1.6 0 0 1 14 4v6.4a1.6 1.6 0 0 1-1.6 1.6h-.5V5.9a2.3 2.3 0 0 0-2.3-2.3H5.6V2.4Z"
      />
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 6a2 2 0 0 1 2-2h5.6a2 2 0 0 1 2 2v5.6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6Zm1.5 1.7v3.9a.5.5 0 0 0 .5.5h5.6a.5.5 0 0 0 .5-.5V7.7H3.5Z"
      />
    </>
  ),
  users: (
    <>
      <path fill="currentColor" d="M6.2 7.9a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z" />
      <path
        fill="currentColor"
        d="M1.7 12.7c0-2.1 2.05-3.45 4.5-3.45s4.5 1.35 4.5 3.45a.8.8 0 0 1-.8.8H2.5a.8.8 0 0 1-.8-.8Z"
      />
      <path
        fill="currentColor"
        opacity=".45"
        d="M11.35 7.4a2.1 2.1 0 0 0 .3-4.18 4 4 0 0 1 0 4.14c.1.03.2.04.3.04ZM12 8.9c1.45.4 2.3 1.35 2.3 2.8a.7.7 0 0 1-.7.7h-1.2c.03-.16.05-.33.05-.5 0-1.35-.5-2.42-1.32-3.15.3-.02.6 0 .87.05Z"
      />
    </>
  ),
  confidence: (
    <>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.35" opacity=".4" />
      <circle cx="8" cy="8" r="3.3" stroke="currentColor" strokeWidth="1.35" opacity=".75" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
    </>
  ),
  performance: (
    <path
      fill="currentColor"
      d="M9.42 1.52a.55.55 0 0 1 .95.5L9.5 5.2h2.36a.62.62 0 0 1 .48 1.01l-5.7 7.05a.55.55 0 0 1-.96-.48l.9-3.38H4.16a.62.62 0 0 1-.48-1.01l5.74-6.87Z"
    />
  ),
  network: (
    <>
      <path
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity=".45"
        d="m4.5 5 6.2 2.6M10.7 9.1 5.4 11.7"
      />
      <circle cx="3.5" cy="4.2" r="2.1" fill="currentColor" />
      <circle cx="12.4" cy="8.1" r="2.1" fill="currentColor" opacity=".7" />
      <circle cx="4.3" cy="12.3" r="2.1" fill="currentColor" opacity=".55" />
    </>
  ),
  deployment: (
    <>
      <path fill="currentColor" opacity=".35" d="M8 1.4 14.1 4.5 8 7.6 1.9 4.5 8 1.4Z" />
      <path
        fill="currentColor"
        d="M1.7 5.7 7.3 8.55v5.85L1.7 11.55V5.7ZM8.7 8.55 14.3 5.7v5.85L8.7 14.4V8.55Z"
      />
    </>
  ),
  regression: (
    <>
      <path
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m2.3 4.6 3.8 3.8 2.3-2.3 3.5 3.5"
      />
      <path fill="currentColor" d="M13.7 11.9V7.7l-4.2 4.2h4.2Z" />
    </>
  ),
  opportunity: (
    <>
      <path
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m2.3 11.4 3.8-3.8 2.3 2.3 3.5-3.5"
      />
      <path fill="currentColor" d="M13.7 4.1v4.2L9.5 4.1h4.2Z" />
    </>
  ),
  crash: (
    <path
      fill="currentColor"
      d="m8 1.3 1.45 3.1 3.2-1.15-1.2 3.2L14.6 8l-3.15 1.55 1.2 3.2-3.2-1.15L8 14.7l-1.45-3.1-3.2 1.15 1.2-3.2L1.4 8l3.15-1.55-1.2-3.2 3.2 1.15L8 1.3Z"
    />
  ),
  conversion: (
    <path
      fill="currentColor"
      d="M1.9 3.25a.8.8 0 0 1 .73-.45h10.74a.8.8 0 0 1 .6 1.33L9.62 8.9v3.87a.8.8 0 0 1-.44.72l-2 1a.8.8 0 0 1-1.16-.72V8.9L1.72 4.13a.8.8 0 0 1 .18-.88Z"
    />
  ),
  backend: (
    <>
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 4.1a1.6 1.6 0 0 1 1.6-1.6h8.8A1.6 1.6 0 0 1 14 4.1v1.8a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 5.9V4.1Zm2.6 1.95a1.05 1.05 0 1 0 0-2.1 1.05 1.05 0 0 0 0 2.1Z"
      />
      <path
        fill="currentColor"
        opacity=".55"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 10.1a1.6 1.6 0 0 1 1.6-1.6h8.8a1.6 1.6 0 0 1 1.6 1.6v1.8a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.9v-1.8Zm2.6 1.95a1.05 1.05 0 1 0 0-2.1 1.05 1.05 0 0 0 0 2.1Z"
      />
    </>
  ),
  recency: (
    <>
      <circle cx="8" cy="8" r="6.1" stroke="currentColor" strokeWidth="1.45" opacity=".5" />
      <path
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 4.5V8l2.4 1.45"
      />
    </>
  ),
  activity: (
    <path
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M1.5 8.4h2.4l1.7-4.8 2.7 8.8 1.8-5.3 1.1 1.3h3.3"
    />
  ),
  category: (
    <path
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M2.4 3.7a1.3 1.3 0 0 1 1.3-1.3h3.42a1.7 1.7 0 0 1 1.2.5l4.87 4.87a1.45 1.45 0 0 1 0 2.05l-3.7 3.7a1.45 1.45 0 0 1-2.05 0L2.9 8.42a1.7 1.7 0 0 1-.5-1.2V3.7Zm2.95 2.28a1.08 1.08 0 1 0 0-2.16 1.08 1.08 0 0 0 0 2.16Z"
    />
  ),
};

export function SigIcon({
  name,
  size = 13,
}: {
  name: SigIconName;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      {GLYPH[name]}
    </svg>
  );
}
