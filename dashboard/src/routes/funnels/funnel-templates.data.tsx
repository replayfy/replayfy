/* ============================================================================
   Funnel templates — ready-made conversion journeys the user can start from
   instead of a blank builder. Each template's `steps` are authored in the exact
   FnStep shape (kind|matchType|value + cur:0); the builder fills real counts via
   the live preview once opened. Icons are chosen from the shared icon registry
   to match each funnel's topic. Pure static data (future API-swap point).

   The "Product analytics" group at the top are deliberately built on generic
   pageview signals (contains "/") rather than product-specific event names, so
   they work in ANY workspace out of the box — nothing to instrument first. The
   e-commerce / activation / monetization templates below use conventional event
   names as an editable starting point.
   ========================================================================== */
import type { ApiFunnel, FnStep } from "./funnels.data";

export type FunnelTemplate = {
  id: string;
  name: string;
  category: string;
  tagline: string;
  /** Glyph from src/components/primitives/icons.ts, matched to the topic. */
  icon: string;
  windowDays: number;
  featured?: boolean;
  /** Optional breakdown dimension key (FN_BDIMS). When set, opening the template
   *  lands on the Breakdown tab pre-split by this dimension (e.g. "browser"). */
  breakdown?: string;
  /** Optional pre-selected date-range preset label (see FN_DATE_PRESETS).
   *  e.g. "Referring domain (last 14 days)" opens with "Last 14 days" applied. */
  dateRange?: string;
  steps: FnStep[];
};

/** Terse step authoring — counts are always 0 (filled live by the builder). */
const step = (kind: string, matchType: string, value: string): FnStep => ({
  kind,
  matchType,
  value,
  cur: 0,
});

export const FN_TEMPLATE_CATEGORIES = [
  "Your templates",
  "Product analytics",
  "E-commerce",
  "Activation & onboarding",
  "Monetization",
] as const;

/** Category user-saved templates ("Save as template") land in. */
export const FN_USER_CATEGORY = "Your templates";

export const FN_TEMPLATES: FunnelTemplate[] = [
  /* ── Product analytics — pageview-based, works with zero instrumentation ── */
  {
    id: "pageview-by-browser",
    name: "Pageview funnel by browser",
    category: "Product analytics",
    featured: true,
    tagline:
      "Of everyone who lands on a page, how many view a second — split by browser to catch rendering or performance issues on one engine.",
    icon: "browser",
    windowDays: 7,
    breakdown: "browser",
    dateRange: "Last 14 days",
    steps: [
      step("page", "contains", "/"),
      step("page", "contains", "/"),
    ],
  },
  {
    id: "referring-domain",
    name: "Referring domain (last 14 days)",
    category: "Product analytics",
    tagline:
      "Which referral sources send visitors that actually browse deeper — landing view to a second page, split by source.",
    icon: "globe",
    windowDays: 14,
    breakdown: "utmSource",
    dateRange: "Last 14 days",
    steps: [
      step("page", "contains", "/"),
      step("page", "contains", "/"),
    ],
  },
  {
    id: "growth-accounting",
    name: "Growth accounting",
    category: "Product analytics",
    tagline:
      "Net new vs. returning — of users active in the period, how many come back and stay active. Widen the window to tune new/resurrected/retained.",
    icon: "spark",
    windowDays: 30,
    dateRange: "Last 30 days",
    steps: [
      step("page", "contains", "/"),
      step("page", "contains", "/"),
    ],
  },
  {
    id: "retention",
    name: "Retention",
    category: "Product analytics",
    tagline:
      "Of users who visit once, how many return within 30 days and use the product again — your stickiness baseline.",
    icon: "refresh",
    windowDays: 30,
    dateRange: "Last 30 days",
    steps: [
      step("page", "contains", "/"),
      step("page", "contains", "/"),
    ],
  },
  {
    id: "waus",
    name: "WAUs (weekly active users)",
    category: "Product analytics",
    tagline:
      "Weekly active engagement — of users active this week, how many are still active the following week (7-day return window).",
    icon: "users",
    windowDays: 7,
    dateRange: "Last 30 days",
    steps: [
      step("page", "contains", "/"),
      step("page", "contains", "/"),
    ],
  },
  {
    id: "daus",
    name: "DAUs (daily active users)",
    category: "Product analytics",
    tagline:
      "Daily active engagement — of users active today, how many come back the next day (1-day return window).",
    icon: "clock",
    windowDays: 1,
    dateRange: "Last 14 days",
    steps: [
      step("page", "contains", "/"),
      step("page", "contains", "/"),
    ],
  },

  /* ── E-commerce ── */
  {
    id: "checkout",
    name: "Checkout / Purchase",
    category: "E-commerce",
    tagline: "Products → Cart → Checkout → Purchase — the classic revenue funnel.",
    icon: "download",
    windowDays: 30,
    steps: [
      step("page", "contains", "/products"),
      step("page", "contains", "/cart"),
      step("page", "contains", "/checkout"),
      step("event", "equals", "purchase_completed"),
    ],
  },
  {
    id: "add-to-cart",
    name: "Add to cart → Purchase",
    category: "E-commerce",
    tagline: "Where shoppers drop off between adding to cart and paying.",
    icon: "cursor",
    windowDays: 14,
    steps: [
      step("page", "contains", "/product"),
      step("click", "contains", "Add to cart"),
      step("page", "contains", "/checkout"),
      step("event", "equals", "purchase_completed"),
    ],
  },
  {
    id: "search-to-purchase",
    name: "Search → Purchase",
    category: "E-commerce",
    tagline: "Does on-site search actually turn into sales?",
    icon: "search",
    windowDays: 14,
    steps: [
      step("page", "contains", "/search"),
      step("click", "contains", "result"),
      step("page", "contains", "/product"),
      step("event", "equals", "purchase_completed"),
    ],
  },

  /* ── Activation & onboarding ── */
  {
    id: "activation",
    name: "New-user activation",
    category: "Activation & onboarding",
    tagline: "From account created to the first real 'aha' action.",
    icon: "spark",
    windowDays: 14,
    steps: [
      step("event", "equals", "account_created"),
      step("event", "equals", "onboarding_started"),
      step("event", "equals", "onboarding_completed"),
      step("event", "equals", "activation_key_action"),
    ],
  },
  {
    id: "mobile-onboarding",
    name: "Mobile app onboarding",
    category: "Activation & onboarding",
    tagline: "First-run screens to a completed first action, on mobile.",
    icon: "phone",
    windowDays: 7,
    steps: [
      step("screen", "equals", "Welcome"),
      step("screen", "equals", "SignUp"),
      step("screen", "equals", "Home"),
      step("event", "equals", "first_action_completed"),
    ],
  },

  /* ── Monetization ── */
  {
    id: "upgrade",
    name: "Free → Paid upgrade",
    category: "Monetization",
    tagline: "Pricing view to an active paid subscription.",
    icon: "bolt",
    windowDays: 30,
    steps: [
      step("page", "contains", "/pricing"),
      step("event", "equals", "trial_started"),
      step("event", "equals", "checkout_started"),
      step("event", "equals", "subscription_activated"),
    ],
  },
];

/* ── User-saved templates ("Save as template") ──────────────────────────────
   Persisted client-side in localStorage for a first cut — per-browser, not yet
   shared across the workspace/team (a backend table would be needed for that).
   Kept separate from the static FN_TEMPLATES so the built-ins stay immutable. */
const FN_USER_TPL_KEY = "replayfy:user-funnel-templates";

export function loadUserFunnelTemplates(): FunnelTemplate[] {
  try {
    const raw = localStorage.getItem(FN_USER_TPL_KEY);
    const arr = raw ? (JSON.parse(raw) as FunnelTemplate[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveUserFunnelTemplate(t: FunnelTemplate): void {
  const all = loadUserFunnelTemplates().filter((x) => x.id !== t.id);
  all.unshift(t);
  try {
    localStorage.setItem(FN_USER_TPL_KEY, JSON.stringify(all));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}

export function deleteUserFunnelTemplate(id: string): void {
  const all = loadUserFunnelTemplates().filter((x) => x.id !== id);
  try {
    localStorage.setItem(FN_USER_TPL_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** Turn a saved funnel into a reusable template (used by "Save as template"). */
export function funnelToTemplate(f: ApiFunnel): FunnelTemplate {
  return {
    id: "user-" + f.id,
    name: f.name,
    category: FN_USER_CATEGORY,
    tagline: f.description?.trim() || `Saved from “${f.name}” — ${f.steps.length} steps.`,
    icon: "copy",
    windowDays: f.windowDays,
    steps: f.steps.map((s) => ({
      kind: s.kind ?? "event",
      matchType: s.matchType,
      value: s.value,
      cur: 0,
    })),
  };
}

/** Resolve a template id from the built-ins first, then user-saved templates,
 *  so /funnels/new?template=user-<id> still prefills the builder. */
export const fnTemplate = (id: string): FunnelTemplate | undefined =>
  FN_TEMPLATES.find((t) => t.id === id) ??
  loadUserFunnelTemplates().find((t) => t.id === id);
