/* ============================================================================
   skeletons.jsx — shared loading skeletons that resemble final layouts (#47)
   One shimmer primitive + per-surface compositions.
   ========================================================================== */

import type { CSSProperties } from "react";

type SkProps = {
  w?: number | string;
  h?: number | string;
  r?: number;
  style?: CSSProperties;
};

export function Sk({ w, h = 12, r = 6, style }: SkProps) {
  return <span className="sk-box" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}
