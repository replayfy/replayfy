import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

/**
 * Alert bodies for the dashboard REST routes. The global ValidationPipe runs
 * `whitelist: true`, so ONLY the keys declared here survive onto `@Body()` —
 * every field the controller/service actually reads is declared 1:1 below.
 *
 * `metric` / `comparator` stay plain `@IsString` rather than `@IsIn(...)`:
 * AlertsService.parseMetric/parseComparator are the source of truth (comparator
 * is matched case-INsensitively via `toUpperCase`), so an `@IsIn` here would
 * reject inputs the service accepts today. `destinations` is an arbitrary
 * provider-config JSON array — `@IsArray` whitelists the top-level key while
 * leaving the nested value fully intact for parseDestinations to normalise.
 * `emailTo` is never `@IsEmail` (legacy non-RFC accounts must keep working).
 */
export class CreateAlertDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  metric?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  comparator?: string;

  @IsOptional()
  @IsNumber()
  threshold?: number;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  emailTo?: string;

  /** External channels to fan out to when the alert fires — a JSON array of
   *  connected providers, e.g. [{"provider":"PAGERDUTY"},{"provider":"SLACK"}].
   *  Kept as a raw array so the whole nested value reaches parseDestinations. */
  @IsOptional()
  @IsArray()
  destinations?: unknown[];
}

/**
 * "Create alert from a dashboard Signal" body. Exactly one of incidentId /
 * issueId identifies the signal; the controller branches on which is present.
 */
export class AlertFromSignalDto {
  @IsOptional()
  @IsInt()
  incidentId?: number;

  @IsOptional()
  @IsInt()
  issueId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;
}

/**
 * "Create alert from a funnel" body. Watches a saved funnel's OVERALL conversion:
 * DROP_PCT fires on a relative drop vs the prior equal-length window; ABOVE/BELOW
 * compare the current conversion % directly against the threshold. Permissive
 * `comparator` (AlertsService.createFunnelAlert is the source of truth). v1 is
 * overall-only — no stepIndex (per-step needs a per-step rollup).
 */
export class AlertFromFunnelDto {
  @IsInt()
  funnelId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  comparator?: string;

  @IsNumber()
  threshold!: number;

  @IsOptional()
  @IsInt()
  windowDays?: number;

  /** Email recipients (validated + capped server-side). Empty → the creator's
   *  account email. Funnel-conversion alerts are email-only. */
  @IsOptional()
  @IsArray()
  recipients?: string[];
}

/**
 * Edit-alert body — only the supplied fields change. Same permissive metric/
 * comparator/destinations handling as CreateAlertDto (see class note above).
 */
export class UpdateAlertDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  metric?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  comparator?: string;

  @IsOptional()
  @IsNumber()
  threshold?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** External channels to fan out to when the alert fires. Pass [] to route to
   *  the in-app bell + email only. Kept raw for parseDestinations. */
  @IsOptional()
  @IsArray()
  destinations?: unknown[];

  /** FUNNEL_CONVERSION only — edit the email recipient list (these alerts are
   *  email-only, so there is no channel to change, just who gets emailed).
   *  Validated + capped server-side; empty clears → creator-email fallback. */
  @IsOptional()
  @IsArray()
  recipients?: string[];

  /** FUNNEL_CONVERSION only — the comparison window in days (clamped 1..90). */
  @IsOptional()
  @IsInt()
  windowDays?: number;
}
