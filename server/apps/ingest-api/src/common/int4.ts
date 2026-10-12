/** Upper bound of a Postgres INT4 column (Prisma `Int`). */
export const INT4_MAX = 2_147_483_647;

/**
 * Coerce a CLIENT-DERIVED number into a value an INT4 column always accepts:
 * rounded, clamped to [0, INT4_MAX], NaN → 0.
 *
 * Every SDK timestamp and metric is untrusted input. A browser with a jumping
 * clock (or a bot faking one) can stretch a session across weeks, and a single
 * `durationMs` past ~24.8 days made Postgres refuse the whole session write
 * ("Unable to fit integer value … into an INT4"), so the batch could never
 * persist. Clamp at the boundary where an SDK number becomes a column value.
 */
export function toInt4(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (value >= INT4_MAX) return INT4_MAX;
  return Math.round(value);
}

/**
 * The BigInt-column counterpart: rounded, clamped to [0, 2^53 - 1], NaN → 0.
 * Below the INT8 maximum, and exact when read back as a JS number.
 */
export function toSafeInt(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (value >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return Math.round(value);
}
