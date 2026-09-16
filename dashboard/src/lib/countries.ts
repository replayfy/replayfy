/* ============================================================================
   countries.ts — the product's supported-market list, shared by every country
   filter (Users page, the Overview Activity chart, future surfaces). Ordered
   by plausible traffic share (used by the Activity chart's deterministic
   fixtures as the per-country session share; they sum to ~95 so the chart's
   breakdown keeps a small "Other" remainder).
   ========================================================================== */

export type Country = { name: string; flag: string; share: number };

export const COUNTRIES: Country[] = [
  { name: "United States", flag: "🇺🇸", share: 22 },
  { name: "India", flag: "🇮🇳", share: 9 },
  { name: "United Kingdom", flag: "🇬🇧", share: 7 },
  { name: "Germany", flag: "🇩🇪", share: 5.5 },
  { name: "Nigeria", flag: "🇳🇬", share: 4 },
  { name: "Canada", flag: "🇨🇦", share: 4 },
  { name: "France", flag: "🇫🇷", share: 3.5 },
  { name: "Brazil", flag: "🇧🇷", share: 3.5 },
  { name: "Australia", flag: "🇦🇺", share: 3 },
  { name: "Netherlands", flag: "🇳🇱", share: 2.5 },
  { name: "Spain", flag: "🇪🇸", share: 2.5 },
  { name: "Japan", flag: "🇯🇵", share: 2.5 },
  { name: "Mexico", flag: "🇲🇽", share: 2 },
  { name: "Sweden", flag: "🇸🇪", share: 1.8 },
  { name: "Italy", flag: "🇮🇹", share: 1.8 },
  { name: "Poland", flag: "🇵🇱", share: 1.5 },
  { name: "South Korea", flag: "🇰🇷", share: 1.5 },
  { name: "Singapore", flag: "🇸🇬", share: 1.2 },
  { name: "South Africa", flag: "🇿🇦", share: 1.2 },
  { name: "Indonesia", flag: "🇮🇩", share: 1.2 },
  { name: "Türkiye", flag: "🇹🇷", share: 1.1 },
  { name: "United Arab Emirates", flag: "🇦🇪", share: 1 },
  { name: "Israel", flag: "🇮🇱", share: 1 },
  { name: "Portugal", flag: "🇵🇹", share: 0.9 },
  { name: "Ireland", flag: "🇮🇪", share: 0.9 },
  { name: "Switzerland", flag: "🇨🇭", share: 0.9 },
  { name: "Austria", flag: "🇦🇹", share: 0.8 },
  { name: "Denmark", flag: "🇩🇰", share: 0.8 },
  { name: "Norway", flag: "🇳🇴", share: 0.8 },
  { name: "Finland", flag: "🇫🇮", share: 0.7 },
  { name: "Belgium", flag: "🇧🇪", share: 0.7 },
  { name: "New Zealand", flag: "🇳🇿", share: 0.7 },
  { name: "Kenya", flag: "🇰🇪", share: 0.6 },
  { name: "Ghana", flag: "🇬🇭", share: 0.6 },
  { name: "Egypt", flag: "🇪🇬", share: 0.6 },
  { name: "Argentina", flag: "🇦🇷", share: 0.6 },
  { name: "Colombia", flag: "🇨🇴", share: 0.5 },
  { name: "Chile", flag: "🇨🇱", share: 0.5 },
  { name: "Philippines", flag: "🇵🇭", share: 0.5 },
  { name: "Thailand", flag: "🇹🇭", share: 0.5 },
  { name: "Malaysia", flag: "🇲🇾", share: 0.5 },
  { name: "Vietnam", flag: "🇻🇳", share: 0.4 },
];

export const countryFlag = (name: string): string =>
  COUNTRIES.find((c) => c.name === name)?.flag ?? "🌐";
