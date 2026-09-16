/**
 * IP → location lookup using geoip-lite's bundled MaxMind GeoLite2 database.
 * Local, free, fast (~1µs per lookup), and accurate to city for ~80% of IPs.
 *
 * The SDK already sends timezone (read from Intl.DateTimeFormat) as a
 * fallback — if geoip can't resolve, we still know roughly where the user is.
 */
import geoip from "geoip-lite";

export interface ResolvedGeo {
  city: string | null;
  /// Region / state code from GeoLite2 (e.g. "CA"). Powers the userState filter.
  state: string | null;
  country: string | null;
  flag: string | null;
}

const FLAG_BY_COUNTRY = (cc: string): string => {
  if (!cc || cc.length !== 2) return "";
  const A = 0x1f1e6;
  return (
    String.fromCodePoint(A + cc.toUpperCase().charCodeAt(0) - 65) +
    String.fromCodePoint(A + cc.toUpperCase().charCodeAt(1) - 65)
  );
};

export function resolveGeo(
  ip: string | undefined | null,
  /** Authoritative country ISO-2 from the edge (Cloudflare `cf-ipcountry`). When
   *  present it OVERRIDES geoip-lite's country/flag, whose free DB disagrees with
   *  its OWN city record on some VPN/datacenter ranges — the "Los Angeles + wrong
   *  flag" bug. geoip's city is then trusted only when it agrees with this. */
  authoritativeCountry?: string | null,
): ResolvedGeo {
  const authCc = normRegion(authoritativeCountry);
  // Country + flag from the edge alone — used whenever geoip has no usable city
  // (no ip, private ip, or a miss). An honest country beats nothing.
  const edgeOnly: ResolvedGeo = {
    city: null,
    state: null,
    country: authCc,
    flag: authCc ? FLAG_BY_COUNTRY(authCc) || null : null,
  };
  if (!ip) return edgeOnly;
  // Strip IPv6-mapped IPv4 prefix `::ffff:1.2.3.4` so geoip-lite sees a v4 addr.
  const norm = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (
    norm === "127.0.0.1" ||
    norm === "::1" ||
    norm.startsWith("10.") ||
    norm.startsWith("192.168.") ||
    norm.startsWith("172.")
  ) {
    return edgeOnly;
  }
  const hit = geoip.lookup(norm);
  if (!hit) return edgeOnly;
  // Country: the edge header wins; else geoip's.
  const country = authCc ?? (hit.country || null);
  // City/state: keep geoip's ONLY when it belongs to the authoritative country
  // (or there's no edge country to check against). A city sitting under a
  // different country than the edge says is exactly the mismatch we're killing —
  // drop it; a country + flag with no city is honest, a fabricated city is not.
  const cityConsistent = !authCc || normRegion(hit.country) === authCc;
  return {
    city: cityConsistent ? hit.city || null : null,
    state: cityConsistent ? hit.region || null : null,
    country,
    flag: country ? FLAG_BY_COUNTRY(country) || null : null,
  };
}

/** CLDR/ICU codes that are shaped like a region but name no country — a stored
 *  session country of "ZZ" (undetermined) or "QO" (outlying oceania) is worse
 *  than null: it splits facets and renders a boxed-letters "flag". */
const NON_COUNTRY_REGIONS = new Set(["ZZ", "QO", "QU", "XA", "XB", "XC", "XZ"]);

/** Uppercase + validate an ISO-3166 alpha-2 region. "UK" (a common non-ISO
 *  alias) is canonicalised to "GB" so it doesn't split the GB facet in two;
 *  non-country sentinels and non-2-letter input yield null. */
const normRegion = (v: string | null | undefined): string | null => {
  if (!v) return null;
  let cc = v.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  if (cc === "UK") cc = "GB";
  return NON_COUNTRY_REGIONS.has(cc) ? null : cc;
};

/**
 * The REGION subtag of a BCP-47 / POSIX locale tag: "en-NG" → NG, "pt-BR" → BR,
 * "zh-Hant-TW" → TW, "en_US@calendar=gregorian" → US, "en_US.UTF-8" → US.
 *
 * The region is NEVER the first subtag (that's the 2–3-letter language) — a
 * naive "first 2-letter segment" reads the LANGUAGE ("pt-BR" → pt → Portugal),
 * so we skip subtag 0, drop POSIX codeset (".…") and Unicode `@…` keywords, and
 * take the first 2-alpha subtag after it (4-letter scripts like "Hant" fall
 * through; a 3-digit UN-M49 region is not an ISO-2, so it's ignored).
 */
const regionFromLocale = (tag: string | null | undefined): string | null => {
  if (!tag) return null;
  const segs = tag.split(/[.@]/)[0].split(/[-_]/);
  for (let i = 1; i < segs.length; i++) {
    if (/^[A-Za-z]{2}$/.test(segs[i])) return normRegion(segs[i]);
  }
  return null;
};

/**
 * IANA timezone → ISO country, for the tertiary geo fallback. Only zones that
 * map to exactly ONE country are listed — an offset like "UTC+01:00" or a
 * multi-country abbreviation is intentionally absent (it can't name a country
 * honestly). A maintenance table biased to high-traffic zones; extend as
 * needed. Primary mobile signal is the device region code, so this is a net.
 */
const TZ_COUNTRY: Record<string, string> = {
  "Africa/Lagos": "NG", "Africa/Cairo": "EG", "Africa/Johannesburg": "ZA",
  "Africa/Nairobi": "KE", "Africa/Accra": "GH", "Africa/Casablanca": "MA",
  "Africa/Algiers": "DZ", "Africa/Tunis": "TN", "Africa/Addis_Ababa": "ET",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US",
  "America/Los_Angeles": "US", "America/Phoenix": "US", "America/Anchorage": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA",
  "America/Mexico_City": "MX", "America/Sao_Paulo": "BR", "America/Bogota": "CO",
  "America/Lima": "PE", "America/Buenos_Aires": "AR",
  "America/Argentina/Buenos_Aires": "AR", "America/Santiago": "CL",
  "America/Caracas": "VE", "America/Montevideo": "UY",
  "Asia/Dubai": "AE", "Asia/Karachi": "PK", "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN", "Asia/Dhaka": "BD", "Asia/Bangkok": "TH",
  "Asia/Jakarta": "ID", "Asia/Manila": "PH", "Asia/Singapore": "SG",
  "Asia/Kuala_Lumpur": "MY", "Asia/Ho_Chi_Minh": "VN", "Asia/Shanghai": "CN",
  "Asia/Hong_Kong": "HK", "Asia/Taipei": "TW", "Asia/Tokyo": "JP",
  "Asia/Seoul": "KR", "Asia/Tehran": "IR", "Asia/Jerusalem": "IL",
  "Asia/Riyadh": "SA", "Asia/Baghdad": "IQ", "Asia/Istanbul": "TR",
  "Europe/Istanbul": "TR", "Europe/London": "GB", "Europe/Dublin": "IE",
  "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Madrid": "ES",
  "Europe/Rome": "IT", "Europe/Amsterdam": "NL", "Europe/Brussels": "BE",
  "Europe/Zurich": "CH", "Europe/Vienna": "AT", "Europe/Lisbon": "PT",
  "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Copenhagen": "DK",
  "Europe/Helsinki": "FI", "Europe/Warsaw": "PL", "Europe/Prague": "CZ",
  "Europe/Budapest": "HU", "Europe/Athens": "GR", "Europe/Bucharest": "RO",
  "Europe/Kyiv": "UA", "Europe/Kiev": "UA", "Europe/Moscow": "RU",
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Perth": "AU",
  "Australia/Brisbane": "AU", "Pacific/Auckland": "NZ",
};

const countryFromTimezone = (tz: string | null | undefined): string | null => {
  if (!tz || !tz.includes("/")) return null; // "UTC+01:00" et al. can't name one
  return TZ_COUNTRY[tz] ?? null;
};

/**
 * Device-reported geo, used ONLY to backfill fields IP geo left null (private
 * dev IPs, carrier NAT, VPNs — the common case on mobile). Never overrides a
 * real IP hit. City is never inferred here: a country + flag is honest, a
 * fabricated city is not.
 *
 * Priority, most authoritative first:
 *   1. regionCode — the device's own region (`Locale.region`), an exact ISO-2.
 *   2. locale tag — the region carried in "en-NG" / "pt_BR".
 *   3. IANA timezone — "Africa/Lagos" → NG (single-country zones only).
 *
 * Country is returned as the same ISO-2 code geoip emits, so the value stays
 * filterable/facetable exactly like an IP-resolved one (no dual format).
 */
export function deviceGeoFallback(input: {
  regionCode?: string | null;
  language?: string | null;
  timezoneId?: string | null;
  timezone?: string | null;
}): { country: string | null; flag: string | null } {
  // `timezone` is an offset ("UTC+01:00") on our SDKs — countryFromTimezone
  // can't map it — so prefer the IANA `timezoneId` ("Africa/Lagos") the SDKs
  // now also send. Passing both keeps the offset as a harmless last resort.
  const cc =
    normRegion(input.regionCode) ??
    regionFromLocale(input.language) ??
    countryFromTimezone(input.timezoneId ?? input.timezone);
  if (!cc) return { country: null, flag: null };
  return { country: cc, flag: FLAG_BY_COUNTRY(cc) || null };
}
