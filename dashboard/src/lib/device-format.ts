/* ============================================================================
   device-format — shared device/geo display helpers. The recordings list +
   player header, the Overview "Worth watching" rows, and the Segments country
   band all render a device/country label, and they must render it identically.
   Keeping the logic here is the single source of truth for that formatting.
   ========================================================================== */

/** "iOS" + "26.5" → "iOS 26": the OS name with its MAJOR version, the way the
 *  platforms market it ("iOS 17", "Android 14"). Bare name when no numeric
 *  version is known. */
export function osLabel(os?: string | null, version?: string | null): string {
  if (!os) return "";
  const major = version ? String(version).match(/^\d+/)?.[0] : null;
  return major ? `${os} ${major}` : os;
}

// One shared Intl.DisplayNames instance — construction is not free and these
// helpers run over every list row. Null when the runtime lacks it.
let REGION_NAMES: Intl.DisplayNames | null = null;
try {
  REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
} catch {
  REGION_NAMES = null;
}

/** ISO-3166 alpha-2 ("NG") → full English country name ("Nigeria"). Anything
 *  that isn't a 2-letter code (already a name, "Other", "Unknown") passes
 *  through unchanged, as does a code the runtime can't expand. */
export function countryName(code?: string | null): string {
  if (!code) return "";
  if (REGION_NAMES && /^[A-Za-z]{2}$/.test(code)) {
    try {
      return REGION_NAMES.of(code.toUpperCase()) || code;
    } catch {
      return code;
    }
  }
  return code;
}

/** ISO-3166 alpha-2 → flag emoji (a regional-indicator pair). Undefined for
 *  anything that isn't a 2-letter code (a country name, "Other"). */
export function flagEmoji(code?: string | null): string | undefined {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return undefined;
  const cc = code.toUpperCase();
  return String.fromCodePoint(
    ...[...cc].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)),
  );
}
