/* Seven unique 4D (isometric, layered, lit) empty-state SVGs. Design only. */

import type { ReactElement, ReactNode } from "react";

const A = '#7b7cf0', B = '#5b5ceb', C = '#4145c4';        // indigo depth ramp
const G = '#e9e9fb', GL = '#f4f4fe';                       // light faces

function Defs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-top`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={GL} /><stop offset="1" stopColor={G} />
      </linearGradient>
      <linearGradient id={`${id}-l`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={A} /><stop offset="1" stopColor={C} />
      </linearGradient>
      <linearGradient id={`${id}-r`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={B} /><stop offset="1" stopColor={C} />
      </linearGradient>
      <radialGradient id={`${id}-glow`} cx="0.5" cy="0.42" r="0.6">
        <stop offset="0" stopColor="#5b5ceb" stopOpacity="0.16" /><stop offset="1" stopColor="#5b5ceb" stopOpacity="0" />
      </radialGradient>
      <ellipse id={`${id}-sh`} />
    </defs>
  );
}
const Glow = ({ id }: { id: string }) => <rect x="0" y="0" width="160" height="160" fill={`url(#${id}-glow)`} />;
const Shadow = () => <ellipse cx="80" cy="138" rx="46" ry="9" fill="#11111e" opacity="0.14" />;
const wrap = (id: string, kids: ReactNode) => (
  <svg className="empty-art" width="150" height="150" viewBox="0 0 160 160">
    <Defs id={id} /><Glow id={id} /><Shadow />{kids}
  </svg>
);
// isometric cube helper: top diamond + left + right faces around center cx,cy
function cube(id: string, cx: number, cy: number, w: number, h: number, lift: number) {
  const x = w / 2, y = h / 2;
  return (
    <g>
      <path d={`M${cx} ${cy - y} L${cx + x} ${cy} L${cx} ${cy + y} L${cx - x} ${cy} Z`} fill={`url(#${id}-top)`} stroke="#fff" strokeWidth="0.5" />
      <path d={`M${cx - x} ${cy} L${cx} ${cy + y} L${cx} ${cy + y + lift} L${cx - x} ${cy + lift} Z`} fill={`url(#${id}-l)`} />
      <path d={`M${cx + x} ${cy} L${cx} ${cy + y} L${cx} ${cy + y + lift} L${cx + x} ${cy + lift} Z`} fill={`url(#${id}-r)`} />
    </g>
  );
}

/* Overview — stacked dashboard cards rising in iso space */
const ArtOverview = () => wrap('ov', (
  <g>
    {cube('ov', 80, 96, 86, 50, 12)}
    <g transform="translate(0,-26)">{cube('ov', 80, 80, 70, 40, 9)}</g>
    <g transform="translate(0,-48)">
      {cube('ov', 80, 66, 52, 30, 7)}
      <path d="M64 60 l8 5 l8-8 l8 5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
    </g>
  </g>
));

/* Recordings — iso play cube on a film base */
const ArtRecordings = () => wrap('rec', (
  <g>
    {cube('rec', 80, 104, 92, 54, 12)}
    <g transform="translate(0,-34)">{cube('rec', 80, 84, 58, 34, 18)}
      <path d="M72 76 l16 9 l-16 9 Z" fill="#fff" opacity="0.95" />
    </g>
    <circle cx="52" cy="64" r="3" fill={A} /><circle cx="108" cy="64" r="3" fill={A} />
  </g>
));

/* Funnels — iso funnel narrowing */
const ArtFunnels = () => wrap('fn', (
  <g>
    {cube('fn', 80, 60, 90, 50, 8)}
    <g transform="translate(0,22)">{cube('fn', 80, 60, 62, 34, 8)}</g>
    <g transform="translate(0,42)">{cube('fn', 80, 60, 34, 20, 16)}</g>
    <g transform="translate(0,74)">{cube('fn', 80, 60, 14, 8, 6)}</g>
  </g>
));

/* Users — iso ID badge + stacked avatars */
const ArtUsers = () => wrap('us', (
  <g>
    {cube('us', 80, 104, 86, 50, 12)}
    <g transform="translate(0,-30)">{cube('us', 80, 80, 56, 32, 12)}
      <circle cx="80" cy="74" r="8" fill="#fff" opacity="0.95" />
      <path d="M70 86 a10 9 0 0 1 20 0 Z" fill="#fff" opacity="0.95" />
    </g>
  </g>
));

/* Cohorts — three overlapping iso spheres (a group) */
const ArtCohorts = () => wrap('co', (
  <g>
    {cube('co', 80, 110, 92, 54, 10)}
    <circle cx="64" cy="74" r="20" fill={`url(#co-l)`} opacity="0.92" />
    <circle cx="96" cy="74" r="20" fill={`url(#co-r)`} opacity="0.82" />
    <circle cx="80" cy="58" r="20" fill="url(#co-top)" stroke="#fff" strokeWidth="0.5" />
    <circle cx="74" cy="52" r="5" fill="#fff" opacity="0.5" />
  </g>
));

/* Comments — iso stacked speech bubbles */
const ArtComments = () => wrap('cm', (
  <g>
    {cube('cm', 80, 116, 88, 50, 10)}
    <g transform="translate(-14,-6)"><rect x="44" y="56" width="56" height="36" rx="9" fill={`url(#cm-r)`} /><path d="M58 92 l0 12 l12-10 Z" fill={`url(#cm-r)`} /></g>
    <g transform="translate(16,-30)"><rect x="48" y="50" width="58" height="38" rx="10" fill="url(#cm-top)" stroke="#fff" strokeWidth="0.5" /><path d="M92 88 l0 12 l-12-10 Z" fill="#f4f4fe" />
      <line x1="60" y1="64" x2="94" y2="64" stroke={B} strokeWidth="2.5" strokeLinecap="round" opacity="0.5" />
      <line x1="60" y1="73" x2="84" y2="73" stroke={B} strokeWidth="2.5" strokeLinecap="round" opacity="0.35" />
    </g>
  </g>
));

/* Settings — iso gear sitting on a slab */
const ArtSettings = () => wrap('st', (
  <g>
    {cube('st', 80, 112, 90, 52, 10)}
    <g transform="translate(80,72)">
      {Array.from({ length: 8 }).map((_, i) => (
        <rect key={i} x="-4" y="-30" width="8" height="12" rx="2" fill={B} transform={`rotate(${i * 45})`} />
      ))}
      <circle r="22" fill="url(#st-top)" stroke="#fff" strokeWidth="0.5" />
      <circle r="9" fill={`url(#st-r)`} />
    </g>
  </g>
));

/* Crashlytics now uses the hand-crafted /illustrations/crashes.svg (cat-mascot
   crash-groups scene) via EMPTY_ART.crashes below — the old iso warning-prism
   `ArtCrashes` was retired with it. */

/* AI conversations — iso spark orb + chat bubble */
const ArtAI = () => wrap('ai', (
  <g>
    {cube('ai', 80, 114, 88, 50, 10)}
    <g transform="translate(80,72)">
      <path d="M-30 -18 h60 a8 8 0 0 1 8 8 v20 a8 8 0 0 1 -8 8 h-40 l-14 10 v-10 a8 8 0 0 1 -8 -8 v-20 a8 8 0 0 1 8 -8 z" fill="url(#ai-top)" stroke="#fff" strokeWidth="0.5" />
      <path d="M0 -10 L4 -2 L12 0 L4 2 L0 10 L-4 2 L-12 0 L-4 -2 Z" fill={B} />
    </g>
  </g>
));

/* Alerts — iso bell on a slab */
const ArtAlerts = () => wrap('al', (
  <g>
    {cube('al', 80, 114, 88, 50, 10)}
    <g transform="translate(80,72)">
      <path d="M-18 8 q0 -32 18 -32 q18 0 18 32 z" fill="url(#al-top)" stroke="#fff" strokeWidth="0.5" />
      <path d="M0 -24 q18 0 18 32 l-18 0 z" fill={`url(#al-r)`} opacity="0.9" />
      <rect x="-22" y="8" width="44" height="6" rx="3" fill={`url(#al-l)`} />
      <circle cx="0" cy="21" r="4.5" fill={`url(#al-r)`} />
      <circle cx="0" cy="-26" r="3.2" fill={B} />
    </g>
  </g>
));

/* Playlists — iso stacked play cards */
const ArtPlaylists = () => wrap('pl', (
  <g>
    {cube('pl', 80, 116, 86, 50, 10)}
    <g transform="translate(80,66)">
      <rect x="-34" y="14" width="68" height="16" rx="4" fill={`url(#pl-r)`} opacity="0.55" />
      <rect x="-38" y="0" width="76" height="16" rx="4" fill={`url(#pl-r)`} opacity="0.78" />
      <rect x="-42" y="-16" width="84" height="18" rx="4" fill="url(#pl-top)" stroke="#fff" strokeWidth="0.5" />
      <path d="M-6 -11 L6 -7 L-6 -3 Z" fill={B} />
    </g>
  </g>
));

/* The five primary screens use the workspace's own brand illustrations (served
   from /public/illustrations); the rest keep the inline generated art. */
const illo = (name: string): ReactElement => (
  <img src={`/illustrations/${name}.svg`} alt="" className="empty-illo" />
);

export const EMPTY_ART: Record<string, ReactElement> = {
  overview: <ArtOverview />,
  recordings: illo("recordings"),
  funnels: illo("funnels"),
  users: illo("users"),
  cohorts: illo("cohorts"),
  comments: illo("comments"),
  alerts: illo("alerts"),
  settings: <ArtSettings />,
  crashes: illo("crashes"), ai: <ArtAI />, playlists: <ArtPlaylists />,
  analytics: illo("analytics"),
};
