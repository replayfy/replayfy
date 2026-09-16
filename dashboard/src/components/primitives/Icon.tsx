import type { CSSProperties, ComponentType } from "react";
import * as Ph from "@phosphor-icons/react";

/* ============================================================================
   PHOSPHOR TRIAL — the shared <Icon> renders the Phosphor family instead of the
   in-house Lucide-derived paths. Same API (name/size/fill/strokeWidth/className/
   style) so every call site is untouched: this is the whole point of first
   consolidating the app onto one <Icon> — the set swap is this one file.

   Weight is Phosphor's, not a stroke: `bold` is picked to sit close to the
   current 2.6 look so the A/B isolates the *style* (Phosphor's rounded geometry)
   rather than weight. Flip PH_WEIGHT to "regular" for the canonical Phosphor
   feel, or "thin" / "light" / "duotone" to explore. `fill`-prop icons render at
   Phosphor's "fill" weight (solid).

   NOTE: the still-bespoke families (SigIcon, the player/event/search glyphs) are
   unchanged — they're stroke SVGs, not routed through here — so this trial swaps
   the shared set only, which is the fair comparison.
   ========================================================================== */
const PH_WEIGHT: Ph.IconWeight = "bold";

/* Our icon names → Phosphor component names. */
const PH: Record<string, keyof typeof Ph> = {
  home: "House", rec: "PlayCircle", funnel: "Funnel", crash: "ShieldWarning",
  users: "Users", cohorts: "Stack", comment: "Chat", settings: "Gear",
  search: "MagnifyingGlass", chev: "CaretDown", check: "Check", copy: "Copy",
  link: "Link", plus: "Plus", x: "X", play: "Play", download: "DownloadSimple",
  more: "DotsThreeVertical", cal: "Calendar", sort: "ArrowsDownUp",
  sliders: "SlidersHorizontal", refresh: "ArrowsClockwise", trash: "Trash",
  arrowR: "ArrowRight", logout: "SignOut", console: "Terminal", spark: "Sparkle",
  doc: "FileText", globe: "Globe", monitor: "Monitor", phone: "DeviceMobile",
  browser: "Browser", chip: "Cpu", pin: "PushPin", clock: "Clock", pages: "Files",
  warn: "Warning", hash: "Hash", mega: "Megaphone", cursor: "Cursor", lock: "Lock",
  bolt: "Lightning", bell: "Bell", dots: "DotsThreeVertical", edit: "PencilSimple",
  pause: "Pause", activity: "Pulse", network: "CloudArrowDown", gauge: "Gauge",
  open: "ArrowSquareOut", chevL: "CaretLeft", chevR: "CaretRight", focus: "CornersOut",
  listplus: "ListPlus", share: "ShareNetwork", issue: "Bug", kbd: "Keyboard",
  sparkle: "Sparkle", zap: "Lightning", recPlay: "PlayCircle",
  plug: "PlugsConnected", arrowL: "ArrowLeft", device: "Devices", key: "Key",
  eye: "Eye",
  chartLine: "ChartLine", chartBar: "ChartBar", grid: "GridNine", table: "Table",
  trendUp: "TrendUp", trendDown: "TrendDown", pie: "ChartPie",
  mail: "EnvelopeSimple", tablet: "DeviceTablet", desktop: "Desktop",
  cursorClick: "CursorClick", tag: "Tag",
};

type PhComp = ComponentType<{
  size?: number;
  weight?: Ph.IconWeight;
  color?: string;
  className?: string;
  style?: CSSProperties;
}>;

type IconProps = {
  name: string;
  size?: number;
  fill?: boolean;
  /** Accepted for API parity with the stroke-based set; Phosphor uses `weight`. */
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
};

export function Icon({ name, size = 16, fill = false, style, className }: IconProps) {
  const key = PH[name];
  // Fallback to Circle so an unmapped name is visible (not silently blank).
  const Comp = ((key && Ph[key]) || Ph.Circle) as PhComp;
  return (
    <Comp
      size={size}
      weight={fill ? "fill" : PH_WEIGHT}
      color="currentColor"
      className={className}
      style={style}
    />
  );
}
