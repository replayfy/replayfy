/* ============================================================================
   Cohort templates — ready-made audience definitions the user can start from
   instead of a blank rule builder. Mirrors the funnel template gallery. Each
   template's `rules` are authored in the exact CoCond shape (field/op/value) and
   are restricted to fields the backend engine can actually compile — the 12
   mapped fields in CO_FIELD_MAP (sessions, last_seen, plan, device, browser, os,
   country, city, email, name, is_online, did_event). Rules on unmapped fields
   (platform, app_version, first_seen, rage, dead, errors, is_identified) are
   silently DROPPED by condsToFilter(), which would leave a degenerate filter
   that matches everyone — so templates never use them. `match` stays "all"
   (the builder hardcodes AND); templates open the existing CohortBuilder drawer
   pre-filled, and creation/preview reuse the existing endpoints unchanged.
   ========================================================================== */
import type { CoCond } from "./cohorts.data";

export type CohortTemplate = {
  id: string;
  name: string;
  category: string;
  tagline: string;
  /** Glyph from src/components/primitives/icons.ts, matched to the topic. */
  icon: string;
  /** AUTO (rule-driven, seeds members immediately) unless a template is a
   *  starting point for a hand-picked list. Defaults to "auto". */
  mode?: "auto" | "manual";
  /** How the rules combine. The builder currently hardcodes "all" (AND), so
   *  templates keep "all"; kept on the type for forward-compat. */
  match?: "all" | "any";
  /** Highlighted first in its category (parity with funnel templates). */
  featured?: boolean;
  rules: CoCond[];
};

/** Terse rule authoring in the real CoCond shape. */
const co = (field: string, op: string, value: string): CoCond => ({
  field,
  op,
  value,
});

export const CO_TEMPLATE_CATEGORIES = [
  "Engagement",
  "Lifecycle",
  "Monetization",
  "Environment",
] as const;

export const CO_TEMPLATES: CohortTemplate[] = [
  /* ── Engagement ── */
  {
    id: "power-users",
    name: "Power users",
    category: "Engagement",
    featured: true,
    tagline:
      "Your most engaged accounts — 12+ sessions and active in the last week. The people to interview, reward, and never lose.",
    icon: "bolt",
    rules: [co("sessions", ">=", "12"), co("last_seen", "within", "7")],
  },
  {
    id: "currently-online",
    name: "Currently online",
    category: "Engagement",
    tagline: "Everyone active in your product right now — live for support, demos, or a nudge.",
    icon: "spark",
    rules: [co("is_online", "is_true", "true")],
  },
  {
    id: "recent-purchasers",
    name: "Recent purchasers",
    category: "Engagement",
    tagline: "Fired a purchase and were seen in the last 30 days — prime for upsell and referrals.",
    icon: "download",
    rules: [
      co("did_event", "fired", "purchase_completed"),
      co("last_seen", "within", "30"),
    ],
  },

  /* ── Lifecycle ── */
  {
    id: "churn-risk",
    name: "Churn risk",
    category: "Lifecycle",
    tagline: "Paying (Pro) but quiet for over 30 days — reach out before they cancel.",
    icon: "warn",
    rules: [co("plan", "=", "Pro"), co("last_seen", "before", "30")],
  },
  {
    id: "dormant",
    name: "Dormant users",
    category: "Lifecycle",
    tagline: "No activity in more than 60 days — a win-back campaign audience.",
    icon: "clock",
    rules: [co("last_seen", "before", "60")],
  },

  /* ── Monetization ── */
  {
    id: "enterprise-accounts",
    name: "Enterprise accounts",
    category: "Monetization",
    tagline: "Your Enterprise-plan customers — the segment worth white-glove attention.",
    icon: "users",
    rules: [co("plan", "=", "Enterprise")],
  },
  {
    id: "free-power-users",
    name: "Free power users",
    category: "Monetization",
    tagline: "On the Free plan but already using it heavily (8+ sessions) — your best upgrade prospects.",
    icon: "arrowR",
    rules: [co("plan", "=", "Free"), co("sessions", ">=", "8")],
  },

  /* ── Environment ── */
  {
    id: "mobile-users",
    name: "Mobile users",
    category: "Environment",
    tagline: "Everyone on a mobile device — isolate mobile-specific behaviour and bugs.",
    icon: "phone",
    rules: [co("device", "=", "Mobile")],
  },
  {
    id: "safari-users",
    name: "Safari users",
    category: "Environment",
    tagline: "Visitors on Safari — the browser most likely to surface rendering quirks.",
    icon: "globe",
    rules: [co("browser", "=", "Safari")],
  },
];

export const coTemplate = (id: string): CohortTemplate | undefined =>
  CO_TEMPLATES.find((t) => t.id === id);
