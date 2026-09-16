import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { type FunnelFilter, type FunnelStep } from "./funnels.service";

// Count unit accepted by compute/preview/breakdown. Kept as a const tuple so
// the DTO field type stays assignable to the service's `"session" | "user"`.
const METRICS = ["session", "user"] as const;

/**
 * Bodies for the funnels controller. The global ValidationPipe runs with
 * `whitelist: true`, so any property NOT declared here is STRIPPED before the
 * service sees it. Every field the controller/service reads is declared 1:1.
 *
 * `steps` (FunnelStep[]) and `filter` (FunnelFilter — a dynamic segment blob
 * with nested `operators` / `userAttributes` maps) are intentionally validated
 * only at the TOP level (@IsArray / @IsObject, no @ValidateNested). That
 * whitelists the key while passing the whole nested value through UNTOUCHED —
 * the service does its own deep validation (`assertValidSteps`) and
 * normalisation (`normalizeFilter` / `toSegment`).
 */
export class CreateFunnelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  // Ordered step list; each element (name/kind/matchType/value) passes through
  // untouched — validated deeply by the service's assertValidSteps.
  @IsArray()
  steps!: FunnelStep[];

  @IsOptional()
  @IsInt()
  windowDays?: number;

  /** "Pin to dashboard" on create. */
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  /** Segment scope — arbitrary FunnelFilter blob, kept whole. */
  @IsOptional()
  @IsObject()
  filter?: FunnelFilter;
}

export class UpdateFunnelDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsArray()
  steps?: FunnelStep[];

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsInt()
  windowDays?: number;

  /**
   * null clears the segment; undefined leaves the stored one untouched.
   * @IsOptional() lets BOTH null and undefined through (class-validator skips
   * all validators when the value is null or undefined), so the service still
   * sees the null and can distinguish "clear" from "leave".
   */
  @IsOptional()
  @IsObject()
  filter?: FunnelFilter | null;
}

/** Ad-hoc compute for the builder's live preview pane (steps only, no id). */
export class PreviewFunnelDto {
  @IsArray()
  steps!: FunnelStep[];

  @IsOptional()
  @IsString()
  @MaxLength(32)
  range?: string;

  @IsOptional()
  @IsInt()
  windowDays?: number;

  @IsOptional()
  @IsObject()
  filter?: FunnelFilter;

  // Explicit epoch-ms window for the "Custom" date range picker.
  @IsOptional()
  @IsInt()
  fromTs?: number;

  @IsOptional()
  @IsInt()
  toTs?: number;

  @IsOptional()
  @IsIn(METRICS)
  metric?: (typeof METRICS)[number];
}

/** Daily-bucketed conversion timeline — steps OR a saved funnelId. */
export class TimelineFunnelDto {
  @IsOptional()
  @IsArray()
  steps?: FunnelStep[];

  @IsOptional()
  @IsInt()
  funnelId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  range?: string;

  @IsOptional()
  @IsObject()
  filter?: FunnelFilter;

  @IsOptional()
  @IsInt()
  fromTs?: number;

  @IsOptional()
  @IsInt()
  toTs?: number;

  // session (default) vs user mode — the Sessions/Users toggle. Same field
  // Preview + Breakdown declare; without it here the global whitelisting
  // ValidationPipe stripped it, so the toggle never reached the over-time query
  // and the chart was identical in both modes.
  @IsOptional()
  @IsIn(METRICS)
  metric?: (typeof METRICS)[number];
}

/** Funnel conversion split by a dimension — steps OR a saved funnelId. */
export class BreakdownFunnelDto {
  @IsOptional()
  @IsArray()
  steps?: FunnelStep[];

  @IsOptional()
  @IsInt()
  funnelId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  range?: string;

  @IsOptional()
  @IsInt()
  windowDays?: number;

  @IsOptional()
  @IsObject()
  filter?: FunnelFilter;

  @IsOptional()
  @IsInt()
  fromTs?: number;

  @IsOptional()
  @IsInt()
  toTs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  dimension?: string;

  @IsOptional()
  @IsInt()
  topN?: number;

  @IsOptional()
  @IsIn(METRICS)
  metric?: (typeof METRICS)[number];
}

/** Body for POST /v1/funnels/:id/dropoff-cohort — materialise a MANUAL cohort of
 *  the identified users who dropped out at `stepIndex` (the step they failed to
 *  reach; ≥1 since a drop-off is a transition OUT of the prior step). fromTs/toTs
 *  override the funnel's rolling window (the Custom date range picker). */
export class DropoffCohortDto {
  @IsInt()
  @Min(1)
  stepIndex!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @IsOptional()
  @IsInt()
  fromTs?: number;

  @IsOptional()
  @IsInt()
  toTs?: number;
}
