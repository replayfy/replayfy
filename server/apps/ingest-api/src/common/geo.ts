/* ============================================================================
   geo.ts — country-filter normalisation.

   Session/EndUser country is stored as an ISO-3166 alpha-2 code ("NG"):
   geoip-lite writes the code at ingest, and the historical backfill (task #85)
   canonicalised the rest. But several dashboard filter pickers (Users,
   Funnels, Cohorts) still send the DISPLAY NAME ("Nigeria") because their
   option lists are curated {name, flag} rows with no code. Name ≠ code, so an
   exact column match returns zero rows.

   `countryFilterToIso2` bridges that at the query boundary: a value that is
   already a 2-letter code passes through (upper-cased); a known display name
   maps to its code; anything else is returned unchanged (best-effort exact
   match, so an unrecognised value still behaves as before rather than throwing
   away the filter). Apply it wherever a country FILTER value meets the data —
   never to stored data.
   ========================================================================== */

// Display name (lower-cased) → ISO-3166 alpha-2. Covers the curated pickers
// (COUNTRIES / FN_COUNTRIES on the dashboard) plus common aliases, so a value
// from any of them resolves. Extend here if a picker adds a market.
const NAME_TO_ISO2: Record<string, string> = {
  "united states": "US", usa: "US", "united states of america": "US",
  "united kingdom": "GB", uk: "GB", "great britain": "GB",
  canada: "CA", mexico: "MX", brazil: "BR", argentina: "AR", chile: "CL",
  colombia: "CO", peru: "PE", venezuela: "VE", ecuador: "EC", uruguay: "UY",
  germany: "DE", france: "FR", spain: "ES", portugal: "PT", italy: "IT",
  netherlands: "NL", belgium: "BE", switzerland: "CH", austria: "AT",
  sweden: "SE", norway: "NO", denmark: "DK", finland: "FI", ireland: "IE",
  poland: "PL", czechia: "CZ", "czech republic": "CZ", greece: "GR",
  romania: "RO", hungary: "HU", ukraine: "UA", russia: "RU", bulgaria: "BG",
  croatia: "HR", serbia: "RS", slovakia: "SK", slovenia: "SI", lithuania: "LT",
  latvia: "LV", estonia: "EE", iceland: "IS", luxembourg: "LU",
  india: "IN", pakistan: "PK", bangladesh: "BD", "sri lanka": "LK",
  nepal: "NP", china: "CN", "hong kong": "HK", taiwan: "TW", japan: "JP",
  "south korea": "KR", korea: "KR", singapore: "SG", malaysia: "MY",
  indonesia: "ID", thailand: "TH", vietnam: "VN", philippines: "PH",
  "türkiye": "TR", turkey: "TR", israel: "IL", "saudi arabia": "SA",
  "united arab emirates": "AE", uae: "AE", qatar: "QA", kuwait: "KW",
  nigeria: "NG", kenya: "KE", ghana: "GH", "south africa": "ZA", egypt: "EG",
  morocco: "MA", ethiopia: "ET", tanzania: "TZ", uganda: "UG",
  australia: "AU", "new zealand": "NZ",
};

export function countryFilterToIso2(value?: string | null): string | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase(); // already an ISO alpha-2
  return NAME_TO_ISO2[v.toLowerCase()] ?? v; // name → code, else pass through
}
