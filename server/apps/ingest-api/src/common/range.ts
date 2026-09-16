/**
 * Shared "named range" → time window resolver.
 *
 * Every page that filters by a date range posts a string like `7d`,
 * `30d`, `today`, `yesterday` etc. Each service used to inline its own
 * table — three slightly different copies that drifted out of sync.
 * Most painfully: `today` was mapped to a rolling 24-hour window on
 * Insights and was missing entirely on Dashboard (silently falling
 * back to 7d). Both wrong: "Today" means *since midnight today* and
 * "Yesterday" means *the calendar day before that*.
 *
 * `resolveRange()` returns a { since, until?, priorSince, priorUntil? }
 * tuple so callers get both the current window and the comparable
 * prior window (used for "+12% vs last week" style deltas) in one shot.
 */

const DAY_MS = 86_400_000;

export interface RangeWindow {
  /** Inclusive lower bound for "current window". */
  since: Date;
  /** Exclusive upper bound; only set for calendar ranges. */
  until?: Date;
  /** Inclusive lower bound for the equivalent prior window. */
  priorSince: Date;
  /** Exclusive upper bound for the prior window. */
  priorUntil: Date;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function resolveRange(
  range = "7d",
  fromTs?: number,
  toTs?: number,
): RangeWindow {
  // Explicit custom range wins. Build the prior window as the equally-
  // sized span immediately preceding the custom one so deltas remain
  // comparable.
  if (fromTs && toTs && toTs > fromTs) {
    const since = new Date(fromTs);
    const until = new Date(toTs);
    const span = toTs - fromTs;
    return {
      since,
      until,
      priorSince: new Date(fromTs - span),
      priorUntil: since,
    };
  }

  const now = Date.now();

  switch (range) {
    case "today": {
      // Calendar day, midnight-anchored. Prior window is yesterday.
      const since = startOfToday();
      const until = new Date(since.getTime() + DAY_MS);
      const priorSince = new Date(since.getTime() - DAY_MS);
      return { since, until, priorSince, priorUntil: since };
    }
    case "yesterday": {
      const todayStart = startOfToday();
      const since = new Date(todayStart.getTime() - DAY_MS);
      const until = todayStart;
      const priorSince = new Date(since.getTime() - DAY_MS);
      return { since, until, priorSince, priorUntil: since };
    }
    case "24h":
    case "1d":
      return rollingWindow(DAY_MS);
    case "7d":
      return rollingWindow(7 * DAY_MS);
    case "14d":
      return rollingWindow(14 * DAY_MS);
    case "30d":
      return rollingWindow(30 * DAY_MS);
    case "90d":
      return rollingWindow(90 * DAY_MS);
    case "365d":
      return rollingWindow(365 * DAY_MS);
    default:
      return rollingWindow(7 * DAY_MS);
  }

  function rollingWindow(windowMs: number): RangeWindow {
    const since = new Date(now - windowMs);
    const priorSince = new Date(now - windowMs * 2);
    return { since, priorSince, priorUntil: since };
  }
}

/** Convenience wrapper for callers that only need `since`. */
export function resolveSince(range = "7d"): Date {
  return resolveRange(range).since;
}
