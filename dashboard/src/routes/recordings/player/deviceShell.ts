/* ===========================================================================
   Reference mobile device shells.

   Ported from the reference open-source mobile player's device utilities. Each
   shell is a phone body (iPhone SVG with notch / dynamic-island, or a generated
   Android bezel) plus a `styles` block describing where the recording surface
   sits inside the shell:

     - shell:  outer body pixel size (what we scale to fit the stage)
     - screen: the inner rect the frames paint into
     - margin: CSS margin (top right bottom left) that offsets `screen` from the
               shell's top-left so the frames land exactly in the cut-out.

   The frames <img> is placed in the `screen` rect and the shell SVG is overlaid
   on top at (0,0); because the SVG's own width matches `shell.width`, the notch /
   bezel line up over the painted surface with no per-model tweaking.
   ========================================================================== */

export interface ShellStyles {
  margin: string;
  screen: { width: number; height: number };
  shell: { width: number; height: number };
}
export interface DeviceShell {
  svg: string;
  styles: ShellStyles;
}

/* ---- iPhone-class shell bodies (dynamic-island / notch baked in) ---------- */
const iPhone12ProSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="432" height="881" xmlns:xlink="http://www.w3.org/1999/xlink"  fill="none" xmlns:v="https://vecta.io/nano"><rect x="12.188" y="9.53" width="408" height="862" rx="59" stroke="#000" stroke-width="18"/><rect x="12.688" y="10.03" width="407" height="861" rx="58.5" stroke="#b6b6b6" stroke-width="17"/><rect x="13.688" y="11.03" width="405" height="859" rx="57.5" stroke="#000" stroke-width="15"/><path d="M427.284 265.897h2.5a2 2 0 0 1 2 2v98.625a2 2 0 0 1-2 2h-2.5V265.897z" fill="url(#A)"/><path d="M.784 330.332a2 2 0 0 1 2-2h2.5v63.996h-2.5a2 2 0 0 1-2-2v-59.996z" fill="url(#B)"/><path d="M.784 245.332a2 2 0 0 1 2-2h2.5v63.996h-2.5a2 2 0 0 1-2-2v-59.996z" fill="url(#C)"/><path d="M.784 182.332a2 2 0 0 1 2-2h2.5v32h-2.5a2 2 0 0 1-2-2v-28z" fill="url(#D)"/><defs><linearGradient id="A" x1="429.534" y1="265.897" x2="429.534" y2="368.522" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="B" x1="3.034" y1="328.332" x2="3.034" y2="392.328" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="C" x1="3.034" y1="243.332" x2="3.034" y2="307.328" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="D" x1="3.034" y1="180.332" x2="3.034" y2="212.332" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="E" x1="165.111" y1="28.357" x2="156.908" y2="28.493" xlink:href="#G"><stop stop-color="#2983ab"/><stop offset="1" stop-color="#1948ab"/></linearGradient><linearGradient id="F" x1="163.143" y1="30.133" x2="166.148" y2="32.7" xlink:href="#G"><stop stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient><linearGradient id="G" gradientUnits="userSpaceOnUse"/></defs></svg>';

const iPhone12ProMaxSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="470" height="963" xmlns:xlink="http://www.w3.org/1999/xlink"  fill="none" xmlns:v="https://vecta.io/nano"><rect x="12.188" y="9.53" width="446" height="944" rx="59" stroke="#000" stroke-width="18"/><rect x="12.688" y="10.03" width="445" height="943" rx="58.5" stroke="#b6b6b6" stroke-width="17"/><rect x="13.688" y="11.03" width="443" height="941" rx="57.5" stroke="#000" stroke-width="15"/><path d="M465.142 283.897h2.5a2 2 0 0 1 2 2v98.625a2 2 0 0 1-2 2h-2.5V283.897z" fill="url(#A)"/><path d="M.642 348.332a2 2 0 0 1 2-2h2.5v63.996h-2.5a2 2 0 0 1-2-2v-59.996z" fill="url(#B)"/><path d="M.642 263.332a2 2 0 0 1 2-2h2.5v63.996h-2.5a2 2 0 0 1-2-2v-59.996z" fill="url(#C)"/><path d="M.642 200.332a2 2 0 0 1 2-2h2.5v32h-2.5a2 2 0 0 1-2-2v-28z" fill="url(#D)"/><defs><linearGradient id="A" x1="467.392" y1="283.897" x2="467.392" y2="386.522" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="B" x1="2.892" y1="346.332" x2="2.892" y2="410.328" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="C" x1="2.892" y1="261.332" x2="2.892" y2="325.328" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="D" x1="2.892" y1="198.332" x2="2.892" y2="230.332" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="E" x1="182.117" y1="29.357" x2="173.914" y2="29.493" xlink:href="#G"><stop stop-color="#2983ab"/><stop offset="1" stop-color="#1948ab"/></linearGradient><linearGradient id="F" x1="180.148" y1="31.133" x2="183.153" y2="33.7" xlink:href="#G"><stop stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient><linearGradient id="G" gradientUnits="userSpaceOnUse"/></defs></svg>';

const iPhone14ProSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="440" height="895" xmlns:xlink="http://www.w3.org/1999/xlink" fill="none" xmlns:v="https://vecta.io/nano"><rect x="12.904" y="11.472" width="414" height="873" rx="62.5" stroke="#000" stroke-width="21"/><rect x="13.404" y="11.972" width="413" height="872" rx="62" stroke="#b6b6b6" stroke-width="20"/><path d="M364.404 13.472h-289c-33.413 0-60.5 27.087-60.5 60.5v748c0 33.413 27.087 60.5 60.5 60.5h289c33.413 0 60.5-27.087 60.5-60.5v-748c0-33.413-27.087-60.5-60.5-60.5z" stroke="#000" stroke-width="17"/><path d="M435.284 265.897h2.5a2 2 0 0 1 2 2v98.625a2 2 0 0 1-2 2h-2.5V265.897z" fill="url(#A)"/><path d="M0 330.332a2 2 0 0 1 2-2h2.5v63.996H2a2 2 0 0 1-2-2v-59.996z" fill="url(#B)"/><path d="M0 245.332a2 2 0 0 1 2-2h2.5v63.996H2a2 2 0 0 1-2-2v-59.996z" fill="url(#C)"/><path d="M0 182.332a2 2 0 0 1 2-2h2.5v32H2a2 2 0 0 1-2-2v-28z" fill="url(#D)"/><defs><linearGradient id="A" x1="437.534" y1="265.897" x2="437.534" y2="368.522" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="B" x1="2.25" y1="328.332" x2="2.25" y2="392.328" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="C" x1="2.25" y1="243.332" x2="2.25" y2="307.328" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="D" x1="2.25" y1="180.332" x2="2.25" y2="212.332" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="E" x1="178.617" y1="50.621" x2="170.414" y2="50.757" xlink:href="#G"><stop stop-color="#2983ab"/><stop offset="1" stop-color="#1948ab"/></linearGradient><linearGradient id="F" x1="176.648" y1="52.397" x2="179.653" y2="54.964" xlink:href="#G"><stop stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient><linearGradient id="G" gradientUnits="userSpaceOnUse"/></defs></svg>';

const iPhone14ProMaxSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="477" height="975" xmlns:xlink="http://www.w3.org/1999/xlink"  fill="none" xmlns:v="https://vecta.io/nano"><rect x="12.904" y="11.472" width="451" height="953" rx="62.5" stroke="#000" stroke-width="21"/><rect x="13.404" y="11.972" width="450" height="952" rx="62" stroke="#b6b6b6" stroke-width="20"/><rect x="14.904" y="13.472" width="447" height="949" rx="60.5" stroke="#000" stroke-width="17"/><path d="M472.284 265.897h2.5a2 2 0 0 1 2 2v98.625a2 2 0 0 1-2 2h-2.5V265.897z" fill="url(#C)"/><path d="M0 330.332a2 2 0 0 1 2-2h2.5v63.996H2a2 2 0 0 1-2-2v-59.996z" fill="url(#D)"/><path d="M0 245.332a2 2 0 0 1 2-2h2.5v63.996H2a2 2 0 0 1-2-2v-59.996z" fill="url(#E)"/><path d="M0 182.332a2 2 0 0 1 2-2h2.5v32H2a2 2 0 0 1-2-2v-28z" fill="url(#F)"/><defs><linearGradient id="A" x1="196.617" y1="50.621" x2="188.414" y2="50.757" xlink:href="#G"><stop stop-color="#2983ab"/><stop offset="1" stop-color="#1948ab"/></linearGradient><linearGradient id="B" x1="194.648" y1="52.397" x2="197.653" y2="54.964" xlink:href="#G"><stop stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient><linearGradient id="C" x1="474.534" y1="265.897" x2="474.534" y2="368.522" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="D" x1="2.25" y1="328.332" x2="2.25" y2="392.328" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="E" x1="2.25" y1="243.332" x2="2.25" y2="307.328" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="F" x1="2.25" y1="180.332" x2="2.25" y2="212.332" xlink:href="#G"><stop stop-color="#575757"/><stop offset="1" stop-color="#222"/></linearGradient><linearGradient id="G" gradientUnits="userSpaceOnUse"/></defs></svg>';

/* Inner-screen rect + shell body size + top/left margin, per iPhone model. */
const screenResolutions: Record<string, ShellStyles> = {
  iPhone12Pro: {
    margin: "18px 0 0 21px",
    screen: { width: 391, height: 845 },
    shell: { width: 438, height: 883 },
  },
  iPhone12ProMax: {
    margin: "18px 0 0 21px",
    screen: { width: 429, height: 927 },
    shell: { width: 476, height: 965 },
  },
  iPhone14Pro: {
    margin: "21px 0 0 23px",
    screen: { width: 394, height: 853 },
    shell: { width: 436, height: 891 },
  },
  iPhone14ProMax: {
    margin: "21px 0 0 23px",
    screen: { width: 431, height: 933 },
    shell: { width: 473, height: 971 },
  },
};

/**
 * Map an iPhone marketing model name to a shell body + inner-screen styles.
 * Currently mapped: 12 / 12 Pro / 13 / 13 Pro / 14, the two Max/Plus variants,
 * 14 Pro and 14 Pro Max. Everything else (including an unknown/empty name)
 * defaults to iPhone 12 Pro.
 */
export function mapIphoneModel(modelName: string): DeviceShell {
  const iPhone12Pro = [
    "iPhone 12",
    "iPhone 12 Pro",
    "iPhone 13",
    "iPhone 13 Pro",
    "iPhone 14",
  ];
  const iPhone12ProMax = [
    "iPhone 12 Pro Max",
    "iPhone 13 Pro Max",
    "iPhone 14 Plus",
  ];
  const iPhone14Pro = ["iPhone 14 Pro"];
  const iPhone14ProMax = ["iPhone 14 Pro Max"];

  if (iPhone12ProMax.includes(modelName)) {
    return { svg: iPhone12ProMaxSvg, styles: screenResolutions.iPhone12ProMax };
  }
  if (iPhone14Pro.includes(modelName)) {
    return { svg: iPhone14ProSvg, styles: screenResolutions.iPhone14Pro };
  }
  if (iPhone14ProMax.includes(modelName)) {
    return { svg: iPhone14ProMaxSvg, styles: screenResolutions.iPhone14ProMax };
  }
  // iPhone12Pro set + default fallback.
  void iPhone12Pro;
  return { svg: iPhone12ProSvg, styles: screenResolutions.iPhone12Pro };
}

/* ---- Universal Android bezel (generated from the screen size) ------------- */
/* Proportions scale linearly with width, so passing device-pixel dimensions
   keeps the bezel/border ratio identical to logical-point dimensions. */
function universalAndroid(
  width: number,
  height: number,
): { svg: string; strokeWidth: number } {
  const scale = width / 375;
  const strokeWidth = Math.round(6 * scale);
  const radius = Math.round(20 * scale);
  const dot = 15 * scale;

  const phoneStyle = `margin-top: ${strokeWidth}px; margin-left: ${strokeWidth}px; width: ${width}px; height: ${height}px; border-radius: ${radius}px; overflow: hidden; outline:${strokeWidth}px solid black;border: ${strokeWidth}px solid #444; position: relative;`;
  const cameraStyle = `width:${dot}px;height:${dot}px;background:#111921;background:conic-gradient(from 315deg,#111921,#2E303D);border-radius:50%;position:absolute;top:${scale * 10}px;left:50%;transform:translateX(-50%);z-index:9`;
  const screenStyle = `width: ${width}px; height: ${height}px; z-index: 6;`;
  const casingStyle = "position: relative;";
  const rockersStyle = `position: absolute; top: 30%; right: -${strokeWidth * 2}px; display: flex; flex-direction: column; z-index: 9; gap: ${scale * 6}px;`;
  const volumeButtonStyle = `width: ${8 * scale}px; height: ${60 * scale}px; background: black; border-top-right-radius: ${2 * scale}px; border-bottom-right-radius: ${2 * scale}px;`;
  return {
    svg: `<div style="${casingStyle}"><div style="${phoneStyle}">
<div style="${cameraStyle}"> </div>
<div style="${screenStyle}"></div>
</div>
<div style="${rockersStyle}">
<div style="${volumeButtonStyle}"></div>
<div style="${volumeButtonStyle}"></div>
</div>
</div>`,
    strokeWidth,
  };
}

/** Build an Android shell sized to the recording's screen dimensions. */
export function mapAndroidModel(width: number, height: number): DeviceShell {
  const { svg, strokeWidth } = universalAndroid(width, height);
  return {
    svg,
    styles: {
      // two borders (outline + border)
      margin: `${strokeWidth * 2}px 0 0 ${strokeWidth * 2}px`,
      screen: { width, height },
      shell: {
        // two borders, margins and the volume-button rail
        width: width + 4 * strokeWidth + 15,
        height: height + 4 * strokeWidth,
      },
    },
  };
}

/** Parse a `top right bottom left` px margin string into numeric top/left. */
export function shellScreenOffset(margin: string): {
  top: number;
  left: number;
} {
  const parts = margin
    .trim()
    .split(/\s+/)
    .map((p) => parseFloat(p) || 0);
  const top = parts[0] ?? 0;
  // CSS shorthand: 4 values → left is index 3; fewer → left mirrors right (idx 1).
  const left = parts.length >= 4 ? parts[3] : (parts[1] ?? 0);
  return { top, left };
}
