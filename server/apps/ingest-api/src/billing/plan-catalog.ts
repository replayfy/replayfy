import { WorkspacePlan } from "@replay/db-postgres";

/**
 * The pricing model, as data — the single source of truth for every plan's
 * session ceiling and monthly price. Benchmarked against the session-replay
 * market (see the pricing survey): a challenger ladder undercutting the premium
 * self-serve leader ~15-20% at each tier while staying above the barebones PAYG
 * floor, with the standard declining $/1k curve.
 *
 * These NUMBERS are the owner's to set/adjust; they live here (not scattered in
 * the UI or the billing math) so a price change is one edit. AI is billed
 * SEPARATELY at cost-plus from AiUsageLedger — it is not in these prices.
 *
 * `sessions: null` = no fixed ceiling (Enterprise, negotiated). `priceUsd: null`
 * = not self-serve billed (Enterprise is manual, invoiced out of band).
 */
export type PlanKey =
  | "FREE"
  | "STARTER"
  | "GROWTH"
  | "SCALE"
  | "BUSINESS"
  | "ENTERPRISE";

export type MobileQuality = "low" | "standard" | "high";

/** Screenshot-quality rank, so a requested quality can be compared to / clamped
 *  against a plan ceiling (low < standard < high). */
const MOBILE_QUALITY_RANK: Record<MobileQuality, number> = {
  low: 0,
  standard: 1,
  high: 2,
};

/** System-wide hard ceiling on mobile capture FPS — the most any plan can grant.
 *  Scale/Business/Enterprise are bounded only by this ("as they like"); Growth
 *  is capped at 3; Free/Starter stay at the 1-fps default. Also the clamp on the
 *  env-tunable MOBILE_FPS default in settings, so the two can't drift. */
export const MOBILE_MAX_FPS = 30;

export interface PlanTier {
  key: PlanKey;
  label: string;
  /** Monthly billable-session ceiling — ONE allowance, whatever the session's
   *  source. A mobile session does cost us more to store than a web one, but
   *  that is OUR cost problem: it informs where we set these prices, never a
   *  separate per-platform meter the customer has to reason about. Free stops
   *  here; a paid plan auto-upgrades to the next at its ceiling. null = custom
   *  (Enterprise). */
  sessions: number | null;
  /** Published monthly price, USD. null = manual/negotiated (Enterprise). */
  priceUsd: number | null;
  /** How long recordings are kept before the retention purge deletes them,
   *  in days. The setting can't be raised above this; a downgrade shrinks it.
   *  null = unlimited (Enterprise, negotiated). */
  retentionDays: number | null;
  /** Mobile capture ceilings for the tier. The SDK captures at 1 fps / low
   *  quality by default for everyone; a workspace may RAISE fps up to
   *  `mobileMaxFps` and quality up to `mobileMaxQuality`, and no higher. The
   *  setting can't exceed these (setRecording rejects), and a downgrade clamps a
   *  stored higher value on read (getRecording), so capture never runs above the
   *  current plan. Free/Starter are pinned at the floor (1 / low); Growth may go
   *  to 3 / standard; Scale/Business/Enterprise up to the system max / high. */
  mobileMaxFps: number;
  mobileMaxQuality: MobileQuality;
  /** Where a paid plan auto-upgrades when it crosses its ceiling. The top paid
   *  tier points at ENTERPRISE, which is a sales conversation, not an auto-bump. */
  upgradesTo: PlanKey | null;
}

export const PLAN_TIERS: Record<PlanKey, PlanTier> = {
  FREE: { key: "FREE", label: "Free", sessions: 1_000, priceUsd: 0, retentionDays: 30, mobileMaxFps: 1, mobileMaxQuality: "low", upgradesTo: "STARTER" },
  STARTER: { key: "STARTER", label: "Starter", sessions: 10_000, priceUsd: 69, retentionDays: 90, mobileMaxFps: 1, mobileMaxQuality: "low", upgradesTo: "GROWTH" },
  GROWTH: { key: "GROWTH", label: "Growth", sessions: 50_000, priceUsd: 249, retentionDays: 180, mobileMaxFps: 3, mobileMaxQuality: "standard", upgradesTo: "SCALE" },
  SCALE: { key: "SCALE", label: "Scale", sessions: 150_000, priceUsd: 599, retentionDays: 365, mobileMaxFps: MOBILE_MAX_FPS, mobileMaxQuality: "high", upgradesTo: "BUSINESS" },
  BUSINESS: { key: "BUSINESS", label: "Business", sessions: 500_000, priceUsd: 1_399, retentionDays: 730, mobileMaxFps: MOBILE_MAX_FPS, mobileMaxQuality: "high", upgradesTo: "ENTERPRISE" },
  ENTERPRISE: { key: "ENTERPRISE", label: "Enterprise", sessions: null, priceUsd: null, retentionDays: null, mobileMaxFps: MOBILE_MAX_FPS, mobileMaxQuality: "high", upgradesTo: null },
};

/** The self-serve upgrade ladder, in order — for the pricing page and the
 *  auto-upgrade walk. Enterprise is deliberately excluded (not self-serve). */
export const SELF_SERVE_LADDER: PlanKey[] = [
  "FREE",
  "STARTER",
  "GROWTH",
  "SCALE",
  "BUSINESS",
];

/* The ceiling MUST be non-decreasing along SELF_SERVE_LADDER: the auto-upgrade
   walk (smallestTierCovering) scans the ladder once and returns the first tier
   that covers current usage, so a non-monotonic column would let it skip the
   right tier. Asserted at module load — a bad price edit fails at boot, not in
   production billing. */
for (let i = 1; i < SELF_SERVE_LADDER.length; i++) {
  const prev = PLAN_TIERS[SELF_SERVE_LADDER[i - 1]!]!;
  const cur = PLAN_TIERS[SELF_SERVE_LADDER[i]!]!;
  if ((cur.sessions ?? Infinity) < (prev.sessions ?? Infinity))
    throw new Error(
      `PLAN_TIERS: ${cur.key} has a smaller session allowance than ${prev.key}; the upgrade ladder must be non-decreasing.`,
    );
}

/** Stored plan labels that predate this catalog, mapped to the nearest current
 *  paid tier. ONE list — resolvePlan and the background-AI cadence floor both
 *  read it, so a third caller can't reintroduce its own copy and drift. */
export const LEGACY_PLAN_ALIASES: Record<string, PlanKey> = {
  PRO: "STARTER",
  TEAM: "GROWTH",
};

/**
 * Whether billing + plans are in this build. Billing is Enterprise Edition, so
 * the proprietary `ee/` directory ships only in the cloud build; its absence is
 * the open-source / self-hosted build. Detected with a runtime require of a
 * dependency-free ee marker (the ee barrel can't be required here — it pulls in
 * BillingService, which imports this file). When billing is absent, there are no
 * plan ceilings: every workspace runs unlimited.
 */
function detectBillingEnabled(): boolean {
  try {
    require("../ee/present");
    return true;
  } catch {
    return false;
  }
}
export const BILLING_ENABLED = detectBillingEnabled();

/** Resolve any stored plan string — including the legacy PRO/TEAM values that
 *  predate this catalog — to a tier. PRO/TEAM map to their nearest current
 *  paid tier so a legacy row still renders a coherent plan. Unknown → FREE.
 *
 *  In the open-source / self-hosted build (no billing) EVERY workspace resolves
 *  to the unlimited Enterprise tier — no retention ceiling, full mobile fps/
 *  quality, no AI cadence floor or manual-refresh throttle. All plan-derived
 *  caps funnel through here, so this one short-circuit makes the whole product
 *  unlimited when billing isn't present, without touching the stored plan. */
export function resolvePlan(plan: string | null | undefined): PlanTier {
  if (!BILLING_ENABLED) return PLAN_TIERS.ENTERPRISE;
  const p = (plan ?? "FREE").toUpperCase();
  if (p in PLAN_TIERS) return PLAN_TIERS[p as PlanKey];
  const legacy = LEGACY_PLAN_ALIASES[p];
  if (legacy) return PLAN_TIERS[legacy];
  return PLAN_TIERS.FREE;
}

/* Every label Workspace.plan can actually hold MUST be a known tier or a known
   legacy alias. Asserted at module load against the Prisma enum itself, because
   TypeScript cannot: PlanKey is a hand-written union with no compile-time link
   to `enum WorkspacePlan`, so adding a label to the schema and forgetting this
   file produces no error anywhere — it just falls through resolvePlan's
   unknown → FREE, and the new (paid) tier silently inherits FREE's background-AI
   cadence floor, i.e. a paying customer throttled to the free refresh rate with
   no signal at all. Fail at boot instead, same as the ladder check above. */
for (const label of Object.keys(WorkspacePlan)) {
  if (!(label in PLAN_TIERS) && !(label in LEGACY_PLAN_ALIASES))
    throw new Error(
      `WorkspacePlan.${label} has no entry in PLAN_TIERS and no LEGACY_PLAN_ALIASES mapping; add one or it silently resolves to FREE (pricing, retention, the background-AI cadence floor AND the manual-refresh throttle — a paying tier would inherit Free's 2/day cap).`,
    );
}

/** The retention ceiling (days) for a plan — the most a workspace on it can keep
 *  recordings. null = unlimited. Used to cap the retention SETTING and to bound
 *  the purge, so a downgraded workspace's retention shrinks to its new plan. */
export function planRetentionDays(plan: string | null | undefined): number | null {
  return resolvePlan(plan).retentionDays;
}

/** The highest mobile capture FPS a plan may set. */
export function planMobileMaxFps(plan: string | null | undefined): number {
  return resolvePlan(plan).mobileMaxFps;
}

/** The highest mobile screenshot quality a plan may set. */
export function planMobileMaxQuality(
  plan: string | null | undefined,
): MobileQuality {
  return resolvePlan(plan).mobileMaxQuality;
}

export function mobileQualityRank(q: MobileQuality): number {
  return MOBILE_QUALITY_RANK[q];
}

/** Clamp a requested fps to [1, plan max] — used on read so a downgraded
 *  workspace's stored higher fps can't keep capturing above its new plan. */
export function capMobileFps(
  plan: string | null | undefined,
  fps: number,
): number {
  return Math.min(Math.max(1, Math.floor(fps)), planMobileMaxFps(plan));
}

/** Clamp a requested quality to the plan's ceiling (same downgrade guarantee). */
export function capMobileQuality(
  plan: string | null | undefined,
  q: MobileQuality,
): MobileQuality {
  const max = planMobileMaxQuality(plan);
  return MOBILE_QUALITY_RANK[q] <= MOBILE_QUALITY_RANK[max] ? q : max;
}

/** How many EXTRA days a bookmark buys, per the `extendBookmarked` setting.
 *  null = "never expire" (unbounded), which only a plan with no retention
 *  ceiling can actually deliver — see bookmarkedRetentionDays. */
export function bookmarkExtensionDays(code: string | null | undefined): number | null {
  switch (code) {
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "365d":
      return 365;
    default:
      // "never" (and any unrecognised value, which must not silently become a
      // SHORTER lifetime — erring long is recoverable, erring short deletes).
      return null;
  }
}

/**
 * Effective lifetime (days) of a BOOKMARKED session: the default retention plus
 * whatever the bookmark extension buys, clamped to the plan ceiling.
 *
 * The clamp is the whole point. Bookmarking was an unlimited-retention bypass:
 * the purge simply excluded `bookmarked: true`, so a FREE workspace capped at 30
 * days could keep a session forever just by starring it, and the
 * `extendBookmarked` setting it appeared to obey was never read by anything.
 *
 * null = keep forever, and is only ever returned when the plan itself has no
 * ceiling (Enterprise) AND the workspace asked for "never expire".
 */
export function bookmarkedRetentionDays(
  plan: string | null | undefined,
  retentionDays: number,
  extendBookmarked: string | null | undefined,
): number | null {
  const planMax = planRetentionDays(plan);
  const extra = bookmarkExtensionDays(extendBookmarked);
  if (planMax == null) return extra == null ? null : retentionDays + extra;
  if (extra == null) return planMax;
  return Math.min(retentionDays + extra, planMax);
}

/* ---- Stripe linkage (Phase 3) ---------------------------------------------
   Each paid tier's Stripe Price id comes from env — the owner creates the
   Products/Prices in their Stripe dashboard and pastes the ids as
   STRIPE_PRICE_STARTER / _GROWTH / _SCALE / _BUSINESS. Free and Enterprise have
   no Stripe price (Free isn't charged; Enterprise is invoiced manually). Kept
   out of the tier table so the catalog stays pure data and the env lookup is
   explicit. */
export function stripePriceEnvKey(plan: PlanKey): string | null {
  if (plan === "FREE" || plan === "ENTERPRISE") return null;
  return `STRIPE_PRICE_${plan}`;
}

export function stripePriceId(plan: PlanKey): string | undefined {
  const key = stripePriceEnvKey(plan);
  return key ? process.env[key] : undefined;
}

/**
 * Price ids that still belong to a plan but are NO LONGER the one we sell.
 *
 * Stripe Prices are immutable, so a price change means creating a new Price and
 * repointing STRIPE_PRICE_<PLAN>. Every existing subscriber stays on the old id
 * until the migration sweep moves them. During that window their subscription
 * events still have to map back to a plan — otherwise planForPriceId returns
 * null, and BOTH consumers (the webhook and the reconcile sweep) skip the plan
 * update behind `if (plan && ...)`, silently and with no log. So the superseded
 * ids are listed here, comma-separated, and can be cleared once the sweep
 * reports nothing left to migrate.
 *
 *   STRIPE_PRICE_GROWTH_PREVIOUS=price_oldA,price_oldB
 */
export function previousStripePriceIds(plan: PlanKey): string[] {
  if (plan === "FREE" || plan === "ENTERPRISE") return [];
  return (process.env[`STRIPE_PRICE_${plan}_PREVIOUS`] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Every price id that maps to this plan — current first. */
export function stripePriceIdsFor(plan: PlanKey): string[] {
  const current = stripePriceId(plan);
  return [...(current ? [current] : []), ...previousStripePriceIds(plan)];
}

/** True when this price belongs to the plan but has been superseded — i.e. the
 *  subscription is due to be migrated to the current Price. */
export function isSupersededPriceId(plan: PlanKey, priceId: string): boolean {
  const current = stripePriceId(plan);
  return current != null && priceId !== current &&
    previousStripePriceIds(plan).includes(priceId);
}

/** A Stripe price id → the plan it represents. The webhook's authority for
 *  "which plan did they just subscribe to" — reads the price off the
 *  subscription rather than trusting client-supplied metadata. */
export function planForPriceId(priceId: string): PlanKey | null {
  for (const key of SELF_SERVE_LADDER) {
    if (key === "FREE") continue;
    // Current AND superseded: a customer mid-migration must still resolve.
    if (stripePriceIdsFor(key).includes(priceId)) return key;
  }
  return null;
}

/** Every paid tier a customer can buy WITHOUT talking to sales — exactly the
 *  set that needs a Stripe price id. Free has nothing to charge; Enterprise is
 *  invoiced by hand. */
export const BILLABLE_PLANS: PlanKey[] = SELF_SERVE_LADDER.filter(
  (k) => k !== "FREE",
);

/**
 * Boot-time check that every billable tier has a Stripe price id configured.
 *
 * Why this has to fail at BOOT and not at checkout: the two directions of the
 * env → price mapping fail in opposite, equally silent ways. Forward,
 * `stripePriceId()` returns undefined and Checkout is created against a missing
 * price. Backward — the direction that actually costs money — `planForPriceId()`
 * cannot map an unrecognised price back to a tier, so a
 * `customer.subscription.created` webhook for a plan the customer has ALREADY
 * PAID for resolves to null and the grant is dropped. Stripe considers the
 * event delivered; nothing retries. The customer is charged and stays on Free.
 *
 * A duplicate id is the same class of bug with a worse blast radius: two tiers
 * sharing one price makes planForPriceId() return whichever comes first in the
 * ladder, so a Business customer can be silently granted Starter forever.
 *
 * Returns the problems rather than throwing so the caller decides between hard
 * fail and loud log — a deployment with Stripe entirely unwired (no
 * STRIPE_SECRET_KEY) is a legitimate local-dev state, not a misconfiguration.
 */
export function validateStripePriceConfig(): string[] {
  const problems: string[] = [];
  const seen = new Map<string, PlanKey>();
  for (const plan of BILLABLE_PLANS) {
    const envKey = stripePriceEnvKey(plan)!;
    const id = stripePriceId(plan)?.trim();
    if (!id) {
      problems.push(
        `${envKey} is not set — ${PLAN_TIERS[plan].label} ($${PLAN_TIERS[plan].priceUsd}/mo) cannot be sold, and a webhook for it cannot be mapped back to the plan.`,
      );
      continue;
    }
    // Stripe price ids are `price_…`. A `prod_…` here is the single most common
    // setup mistake (the dashboard shows the Product id more prominently than
    // the Price id) and produces a resource_missing at checkout, far from cause.
    if (!id.startsWith("price_"))
      problems.push(
        `${envKey}="${id}" does not look like a Stripe Price id (expected "price_…"; "prod_…" is the Product, not the Price).`,
      );
    const dupe = seen.get(id);
    if (dupe)
      problems.push(
        `${envKey} and ${stripePriceEnvKey(dupe)} are both "${id}" — planForPriceId() would grant ${dupe} to ${plan} customers.`,
      );
    else seen.set(id, plan);
  }
  return problems;
}

/* ---- Presentation layer for the Change Plan page ---------------------------
   The comparison dimensions a buyer evaluates — kept separate from PLAN_TIERS
   (the billing math) so pricing stays lean and the copy/limits below are the
   owner's to tune without touching how money is computed. AI is billed at
   provider cost; `aiCapUsd` is the monthly hard cap that protects against
   runaway spend and scales with the plan (the Phase-4 platform cap). Overage is
   not per-unit — a plan auto-upgrades to the next at its ceiling. */
export interface PlanDetail {
  description: string;
  /** The DELTA from the tier below — "Everything in X, plus:" reads best. The
   *  page renders each card's list STANDALONE (no inheritance prefix), so a
   *  line that qualifies only its own tier — Free's AI cadence, which the paid
   *  tiers don't share — belongs on that tier and nowhere else. */
  features: string[];
  /** Monthly AI allowance, in USD at our provider cost — sized at ~15% of plan
   *  price so the rest is margin. Shown to users ONLY as credits (usdToCredits);
   *  beyond it they top up. null = custom (Enterprise). */
  aiCapUsd: number | null;
  support: string;
  /** What happens at the session ceiling. */
  overage: string;
  recommended?: boolean;
}

/* ---- Background-AI cadence floor ------------------------------------------
   The two SCHEDULED AI producers — the intel pass (intel + intel-storyline, one
   pair per pass) and the storyline narration (narrate) — spend a workspace's AI
   allowance with NO user in the loop. Measured against the live AiUsageLedger at
   z-ai/glm-5.2 (avg µ¢/call ÷ 1,000): intel 717 + intel-storyline 489 = ~1,206
   credits per pass, narrate ~136. At the stored defaults (6h intel / 12h
   storyline) that is 120 × 1,206 + 60 × 136 ≈ 153,000 credits a month — 153% of
   Free's 100,000-credit allowance — so a Free user could be out of credits
   before ever asking a question, having spent the whole taster on background
   jobs they never saw. That figure is the WORST case, a continuously-active
   workspace: the intel pass also requires changed facts (selectDue's
   factsFingerprint/lastActivityAt conjuncts), so a quiet workspace spends less.
   We size the floor against the worst case because that is the engaged
   evaluator we least want to strand. Floored to 24h the pair costs
   30 × 1,206 + 30 × 136 ≈ 40,300/mo (~40%), leaving ~59,700 credits ≈ 43 Ask
   turns at ~1,383 credits a turn, and insights still refresh daily.

   This is a FLOOR, not an override: a workspace that deliberately chose a
   SLOWER cadence (or 0 = off) keeps it. max(stored, floor) — never min, never
   assignment — or we'd silently speed a workspace up, i.e. spend MORE on its
   behalf than it asked for, which is the exact failure this exists to prevent.

   It lives here, next to aiCapUsd, because the floor and the allowance are one
   pricing decision: change the cap and the sustainable cadence moves with it.
   Both call sites (intel.service selectDue's SQL, workspace-precompute's
   narrateDue gate) and the Free plan card's copy read THIS record, so the policy
   cannot drift between the two producers or go stale on the pricing page. Paid
   tiers are 0 (no floor) — their caps are 10-210x Free's, so background spend is
   immaterial there and today's behaviour is preserved exactly. */
export const AI_CADENCE_FLOOR_HOURS: Record<PlanKey, number> = {
  FREE: 24,
  STARTER: 0,
  GROWTH: 0,
  SCALE: 0,
  BUSINESS: 0,
  ENTERPRISE: 0,
};

/** The minimum hours between BACKGROUND AI passes for a plan (0 = no floor). */
export function planAiCadenceFloorHours(plan: string | null | undefined): number {
  return AI_CADENCE_FLOOR_HOURS[resolvePlan(plan).key];
}

/** Every plan LABEL Workspace.plan can hold, paired with its floor — built from
 *  the Prisma enum itself (not from PlanKey, which is a hand-written union) so
 *  the intel sweep's CASE covers legacy PRO/TEAM and any label added later. The
 *  module-load assertion above guarantees each one resolves to a real tier, so
 *  the ELSE branch is genuinely unreachable rather than load-bearing. */
export function planAiCadenceFloorPairs(): Array<{ plan: string; hours: number }> {
  return Object.keys(WorkspacePlan).map((plan) => ({
    plan,
    hours: planAiCadenceFloorHours(plan),
  }));
}

/** Human phrasing for a cadence in hours, for plan copy — so a card can quote
 *  the floor instead of hardcoding a word that goes stale the moment the floor
 *  is retuned (the exact staleness PLAN_DETAILS avoids for allowances). */
export function cadenceLabel(hours: number): string {
  if (hours === 24) return "daily";
  if (hours === 1) return "hourly";
  if (hours % 24 === 0) return `every ${hours / 24} days`;
  return `every ${hours} hours`;
}

/* ---- Manual-AI-refresh throttle -------------------------------------------
   The other half of the cadence decision above: the "regenerate insights"
   button forces an intel pass on demand, outside the floor. Same measured unit
   cost — intel 717 + intel-storyline 489 ≈ 1,206 credits a pass — so on Free's
   100,000-credit allowance ~83 clicks drain the MONTH, and ~49 clicks burn back
   everything the 24h floor saves. Nothing today bounds that: the endpoint is
   only @RequiresRole("MEMBER").

   Sizing, at the same worst case the floor is sized against. Free background
   (24h-floored) ≈ 30 × 1,206 + 30 × 136 ≈ 40,300/mo, leaving ~59,700 credits ≈
   43 Ask turns at ~1,383 a turn. Manual spend is N × 30 × 1,206 a month, so
   N=1 leaves ~23,600 (~17 Ask turns) and N=2 already overshoots the allowance
   by ~12,600 in the every-single-day case. So this is deliberately NOT sized to
   the 30-consecutive-day worst case, and the reason is that the MONTH is
   already bounded elsewhere: LlmService.resolve() refuses before opening a
   socket once credits run out, so this record cannot and need not be a second
   budget control. What is unbounded today is a SITTING — 83 clicks in one
   afternoon silently zeroes the month, and the symptom the user meets is "Ask
   stopped working", remote from its cause. 2/day caps one sitting at ~2,412
   credits (2.4% of the allowance) while never binding the realistic engaged
   evaluator (~4-8 clicks a MONTH, after real deploys); 1/day would reject the
   second refresh on a two-deploy day, which is the exact case the button
   exists for. The 2-every-day tail is knowingly accepted: the credit gate owns
   that message, and it is the right owner of it.

   Paid tiers are 0 = NO LIMIT (same convention as AI_CADENCE_FLOOR_HOURS —
   never "zero refreshes"). Their allowances are 10-210x Free's: even STARTER
   would need ~23 clicks a day sustained for a month to drain the headroom left
   after background spend, which is scripted abuse and belongs to the HTTP
   throttler, not to plan policy. That also makes this change a strict no-op for
   every paying customer. It lives beside the floor because cadence, allowance
   and throttle are ONE decision — retune the cap and all three move. */
export const AI_MANUAL_PASSES_PER_DAY: Record<PlanKey, number> = {
  FREE: 2,
  STARTER: 0,
  GROWTH: 0,
  SCALE: 0,
  BUSINESS: 0,
  ENTERPRISE: 0,
};

/** How many MANUAL intel passes a plan may force per rolling 24h (0 = no limit).
 *  Routed through resolvePlan so legacy PRO/TEAM labels inherit a real tier's
 *  policy instead of yielding undefined. */
export function planManualPassesPerDay(plan: string | null | undefined): number {
  return AI_MANUAL_PASSES_PER_DAY[resolvePlan(plan).key];
}

export const PLAN_DETAILS: Record<PlanKey, PlanDetail> = {
  FREE: {
    description: "Evaluate Replayfy on a single product.",
    // Allowances are rendered from PLAN_TIERS, not repeated here — a hardcoded
    // count goes stale the first time pricing moves. The AI line follows the
    // same rule in BOTH of its numbers: the credit count renders from aiCapUsd
    // via planCards(), and the cadence word is derived from the floor that
    // actually governs the sweep, so retuning AI_CADENCE_FLOOR_HOURS.FREE can
    // never leave the pricing page promising a refresh rate we don't run.
    features: [
      "Full replay + product analytics",
      "Web + mobile SDKs",
      `Replayfy AI, refreshed ${cadenceLabel(AI_CADENCE_FLOOR_HOURS.FREE)}, within the included allowance`,
      "Community support",
    ],
    aiCapUsd: 1, // 100K credits — a taster
    support: "Community",
    overage: "Recording pauses at the cap",
  },
  STARTER: {
    description: "For small teams shipping their first product.",
    features: ["Unlimited seats", "90-day retention", "Email support"],
    aiCapUsd: 10, // ~15% of $69 → 1M credits
    support: "Email",
    overage: "Auto-upgrades to Growth",
  },
  GROWTH: {
    description: "For teams that live in their session data.",
    features: ["Replayfy AI included", "180-day retention", "Priority support"],
    aiCapUsd: 37, // ~15% of $249 → 3.7M credits
    support: "Priority email",
    overage: "Auto-upgrades to Scale",
    recommended: true,
  },
  SCALE: {
    description: "For established products with serious traffic.",
    features: ["1-year retention", "SSO", "Shared Slack channel"],
    aiCapUsd: 90, // ~15% of $599 → 9M credits
    support: "Priority + Slack",
    overage: "Auto-upgrades to Business",
  },
  BUSINESS: {
    description: "For high-volume products and larger orgs.",
    features: ["2-year retention", "Audit logs", "Dedicated support"],
    aiCapUsd: 210, // ~15% of $1,399 → 21M credits
    support: "Dedicated",
    overage: "Talk to us near the ceiling",
  },
  ENTERPRISE: {
    description: "For organizations with security, compliance, and volume needs.",
    features: ["SAML / SCIM", "Custom retention", "Self-host option", "SLA"],
    aiCapUsd: null,
    support: "SLA + dedicated",
    overage: "Custom",
  },
};

/* ---- AI credits -----------------------------------------------------------
   AI is billed to us at provider cost (AiUsageLedger.costMicroCents; 1 USD =
   1e8 µ¢), but shown to users as CREDITS — big, generous-feeling numbers rather
   than a small dollar figure ("2M credits" reads richer than "$20"). Fixed
   ratio: 100,000 credits = $1, i.e. 1 credit = 1,000 µ¢. ONLY the backend sees
   the USD; every user-facing surface shows credits. */
export const CREDITS_PER_USD = 100_000;
export const MICROCENTS_PER_CREDIT = 1_000;
export function usdToCredits(usd: number): number {
  return Math.round(usd * CREDITS_PER_USD);
}
export function microCentsToCredits(microCents: number | bigint): number {
  return Math.floor(Number(microCents) / MICROCENTS_PER_CREDIT);
}
/** The monthly AI credit allowance bundled in a plan (null = custom/Enterprise). */
export function planAiCredits(plan: string | null | undefined): number | null {
  const usd = PLAN_DETAILS[resolvePlan(plan).key].aiCapUsd;
  return usd != null ? usdToCredits(usd) : null;
}

/** The full catalogue the Change Plan page renders — pricing merged with its
 *  presentation, in display order, Enterprise last. AI is exposed as CREDITS
 *  (never the USD cap), and each plan carries its implied per-session price. */
export function planCards() {
  const order: PlanKey[] = [...SELF_SERVE_LADDER, "ENTERPRISE"];
  return order.map((key) => {
    const t = PLAN_TIERS[key];
    const d = PLAN_DETAILS[key];
    return {
      key: t.key,
      label: t.label,
      sessions: t.sessions,
      priceUsd: t.priceUsd,
      retentionDays: t.retentionDays,
      upgradesTo: t.upgradesTo,
      description: d.description,
      features: d.features,
      support: d.support,
      overage: d.overage,
      recommended: d.recommended,
      // AI shown as credits; the USD cap stays server-side.
      aiCredits: d.aiCapUsd != null ? usdToCredits(d.aiCapUsd) : null,
      // Implied unit price for the card ("$0.0050 / session"). null for Free
      // ($0 → meaningless) and custom.
      perSessionUsd:
        t.priceUsd != null && t.priceUsd > 0 && t.sessions
          ? t.priceUsd / t.sessions
          : null,
    };
  });
}
