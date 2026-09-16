/* ---- palette / pure helpers (verbatim from the prototype) ---- */

export const RV_HUES = [
  "#5b5ceb",
  "#3b76b0",
  "#3f9468",
  "#c2599f",
  "#8b72d6",
  "#bd8638",
];

export function rvHue(n: string) {
  let h = 0;
  for (const c of n || "?") h = (h * 31 + c.charCodeAt(0)) % RV_HUES.length;
  return RV_HUES[h];
}

export function pct(x: number) {
  return x + "%";
}

/* keep a URL identifiable when it overflows: collapse the middle, keep head + tail */
export function midTrunc(str: string, max = 34) {
  if (!str || str.length <= max) return str;
  const head = Math.ceil(max * 0.55),
    tail = Math.floor(max * 0.4);
  return str.slice(0, head) + "…" + str.slice(-tail);
}
