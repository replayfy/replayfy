/* ============================================================================
   url-format — display helpers for referrers / traffic sources.

   Cosmetic only: they never mutate the stored/raw value (filters still match the
   real string), they only shape how a URL or host reads in the UI.
   ========================================================================== */

/**
 * Strip the scheme (and a leading `www.`, a trailing slash) so a referrer like
 * "https://news.ycombinator.com/" reads as "news.ycombinator.com". Leaves a
 * bare host or a non-URL word untouched.
 */
export function stripScheme(url: string): string {
  return url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") // scheme://
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
    .trim();
}

/** The host part of a URL/label (scheme + www + path removed), lower-cased. */
export function hostOf(urlOrHost: string): string {
  return stripScheme(urlOrHost).split("/")[0].toLowerCase();
}

// A few common utm_source words that map to a real host, so their tab rows get a
// recognisable favicon instead of a monogram (utm_source is often a bare word —
// "twitter", "newsletter" — not a domain). Extend as needed; anything not here
// and not already domain-shaped falls back to the monogram tile.
const SOURCE_DOMAINS: Record<string, string> = {
  twitter: "twitter.com",
  x: "x.com",
  google: "google.com",
  bing: "bing.com",
  reddit: "reddit.com",
  github: "github.com",
  linkedin: "linkedin.com",
  facebook: "facebook.com",
  fb: "facebook.com",
  instagram: "instagram.com",
  ig: "instagram.com",
  youtube: "youtube.com",
  producthunt: "producthunt.com",
  "product-hunt": "producthunt.com",
  ph: "producthunt.com",
  hackernews: "news.ycombinator.com",
  hn: "news.ycombinator.com",
  ycombinator: "news.ycombinator.com",
  tiktok: "tiktok.com",
  medium: "medium.com",
  substack: "substack.com",
  discord: "discord.com",
  slack: "slack.com",
};

/** Does a label already look like a host ("news.ycombinator.com")? */
export function looksLikeHost(s: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(hostOf(s));
}

/**
 * Resolve a traffic-source label to the host whose favicon best represents it,
 * or null when nothing sensible maps (→ the caller renders a monogram tile).
 * Referrer rows are already hosts; utm_source words route through SOURCE_DOMAINS.
 */
export function iconHostFor(label: string): string | null {
  const raw = label.trim();
  if (!raw || raw === "Other" || raw === "Unknown" || raw === "(direct)")
    return null;
  const mapped = SOURCE_DOMAINS[raw.toLowerCase()];
  if (mapped) return mapped;
  if (looksLikeHost(raw)) return hostOf(raw);
  return null;
}

/**
 * Best-effort favicon URL for a host. Uses DuckDuckGo's icon service — no query
 * string, no tracking cookie (a privacy-first choice, in line with the rest of
 * the app), and it returns a generic globe when a host has no icon. Callers
 * still render an <img onError> fallback for hosts it can't resolve at all.
 */
export function faviconUrl(host: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
}

// Browser name → the vendor host whose favicon stands in for its logo, so the
// same icon service that marks referrers also marks browsers (no bespoke SVGs).
// Electron uses the actual Electron mark (electronjs.org).
const BROWSER_HOST: Record<string, string> = {
  chrome: "google.com",
  chromium: "google.com",
  headless: "google.com",
  safari: "apple.com",
  firefox: "mozilla.org",
  edge: "microsoft.com",
  opera: "opera.com",
  brave: "brave.com",
  samsung: "samsung.com",
  duckduckgo: "duckduckgo.com",
  yandex: "yandex.com",
  vivaldi: "vivaldi.com",
  electron: "electronjs.org",
};

// OS name → vendor host, so OS rows get the real platform mark (Apple, Windows,
// the Android robot, Tux) rather than a colour dot.
const OS_HOST: Record<string, string> = {
  ios: "apple.com",
  ipados: "apple.com",
  mac: "apple.com",
  "os x": "apple.com",
  windows: "microsoft.com",
  android: "android.com",
  ubuntu: "ubuntu.com",
  linux: "linux.org",
  chromeos: "google.com",
  "chrome os": "google.com",
};

/** A browser's vendor host for favicon lookup, or null. */
export function browserHost(name: string): string | null {
  const n = name.toLowerCase();
  for (const k in BROWSER_HOST) if (n.includes(k)) return BROWSER_HOST[k];
  return null;
}

/**
 * The favicon host for a breakdown dimension's value, or null when the value has
 * no brand host (→ the caller falls back to a glyph, never a bare colour). One
 * place so every breakdown surface (overview panel, Breakdowns table, Trends
 * legend) marks the same dims the same way.
 */
export function dimIconHost(dimension: string, value: string): string | null {
  if (dimension === "browser") return browserHost(value);
  if (dimension === "os") {
    const n = value.toLowerCase();
    for (const k in OS_HOST) if (n.includes(k)) return OS_HOST[k];
    return null;
  }
  if (
    dimension === "referrer" ||
    dimension === "referrerDomain" ||
    dimension === "utmSource" ||
    dimension === "source"
  ) {
    return iconHostFor(value);
  }
  return null;
}

/**
 * The Icon-primitive glyph name for a breakdown value that has no favicon
 * (device type, channel, path, …). Never returns empty, so a row always shows a
 * real mark instead of a colour swatch. `Icon` itself falls back to a circle for
 * anything truly unmapped.
 */
export function dimGlyph(dimension: string, value: string): string {
  const v = value.toLowerCase();
  if (dimension === "device") {
    if (v.includes("mobile") || v.includes("phone")) return "phone";
    if (v.includes("tablet")) return "tablet";
    if (v.includes("desktop")) return "desktop";
    return "device";
  }
  if (dimension === "channel") {
    if (v.includes("social")) return "share";
    if (v.includes("organic") || v.includes("search")) return "search";
    if (v.includes("referral")) return "link";
    if (v.includes("campaign")) return "mega";
    if (v.includes("email")) return "mail";
    if (v.includes("paid")) return "tag";
    if (v.includes("direct")) return "cursorClick";
    return "funnel";
  }
  if (dimension === "utmMedium" || dimension === "utmCampaign") return "mega";
  if (dimension === "path") return "pages";
  if (dimension === "os") return "monitor";
  if (dimension === "browser") return "browser";
  return "globe";
}
