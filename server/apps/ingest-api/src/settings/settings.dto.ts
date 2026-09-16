import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import type { DataRegion, LlmProviderMode } from "@replay/db-postgres";

const RECORDING_TRIGGERS = ["always", "identified", "sample"] as const;
const MOBILE_QUALITIES = ["low", "standard", "high"] as const;
const DATA_REGIONS = ["US", "EU"] as const;
// Includes BYOK on purpose: the LlmService itself rejects BYOK with a helpful
// 400 message, so letting it validate here preserves that exact behavior
// (dropping it would swap the message for a generic validation error).
const LLM_MODES = ["DISABLED", "PLATFORM", "BYOK"] as const;

/**
 * PATCH /v1/settings/recording — partial update of RecordingConfig. Every
 * capture toggle + recording-behavior field the SDK config reads is declared
 * so `whitelist` keeps the whole blob; the service merges it over the stored
 * defaults. Assignable to `Partial<RecordingConfig>`.
 */
export class SetRecordingDto {
  @IsOptional()
  @IsBoolean()
  captureConsole?: boolean;

  @IsOptional()
  @IsBoolean()
  captureNetwork?: boolean;

  @IsOptional()
  @IsBoolean()
  captureNetworkHeaders?: boolean;

  @IsOptional()
  @IsBoolean()
  captureNetworkBodies?: boolean;

  @IsOptional()
  @IsBoolean()
  captureErrors?: boolean;

  // legacy alias kept for backwards compat
  @IsOptional()
  @IsBoolean()
  captureHeaders?: boolean;

  @IsOptional()
  @IsBoolean()
  capturePerformance?: boolean;

  @IsOptional()
  @IsBoolean()
  recordCanvas?: boolean;

  @IsOptional()
  @IsBoolean()
  recordCrossOriginIframes?: boolean;

  @IsOptional()
  @IsBoolean()
  autoplayNextRecording?: boolean;

  @IsOptional()
  @IsIn(RECORDING_TRIGGERS)
  recordingTrigger?: (typeof RECORDING_TRIGGERS)[number];

  @IsOptional()
  @IsNumber()
  minDurationSeconds?: number;

  @IsOptional()
  @IsNumber()
  mobileFps?: number;

  @IsOptional()
  @IsIn(MOBILE_QUALITIES)
  mobileQuality?: (typeof MOBILE_QUALITIES)[number];
}

/**
 * PATCH /v1/settings/masking — partial update of MaskingConfig. Selector /
 * pattern / host lists are arbitrary user-supplied strings, kept permissive
 * (generous per-element MaxLength, never rejected on content). Assignable to
 * `Partial<MaskingConfig>`.
 */
export class SetMaskingDto {
  @IsOptional()
  @IsBoolean()
  maskAllInputs?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  maskSelectors?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  blockSelectors?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  redactUrlPatterns?: string[];

  @IsOptional()
  @IsBoolean()
  blockCreditCardText?: boolean;

  @IsOptional()
  @IsBoolean()
  stripQueryParams?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  allowedQueryParams?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  allowedHosts?: string[];
}

/**
 * PATCH /v1/settings/retention. NOTE: the old inline body type only declared
 * `retentionDays`, but the service reads `extendBookmarked` + `keepErrorsLonger`
 * too (it takes `Partial<RetentionConfig>`). All three are declared here or
 * `whitelist` would silently strip the two extras. Assignable to
 * `Partial<RetentionConfig>`.
 */
export class SetRetentionDto {
  @IsOptional()
  @IsInt()
  retentionDays?: number;

  // Documented set is "never" | "30d" | "90d" | "365d", but the underlying
  // type is a plain `string`; kept as a free string so an unlisted value is
  // stored, not rejected.
  @IsOptional()
  @IsString()
  @MaxLength(16)
  extendBookmarked?: string;

  @IsOptional()
  @IsBoolean()
  keepErrorsLonger?: boolean;
}

/**
 * PATCH /v1/settings/region. `dataRegion` is required (the handler passes
 * `body.dataRegion` straight into `setRegion(workspaceId, DataRegion)`); the
 * service enforces the write-once + US/EU rules.
 */
export class SetRegionDto {
  @IsIn(DATA_REGIONS)
  dataRegion!: DataRegion;
}

/**
 * PATCH /v1/settings/sampling. NOTE: the old inline body type only declared
 * `samplingRate`, but the service reads the full SamplingConfig
 * (`alwaysRecordErrors` / `alwaysRecordIdentified` / `alwaysRecordOnUrls`).
 * All four are declared so `whitelist` keeps them. Assignable to
 * `Partial<SamplingConfig>`.
 */
export class SetSamplingDto {
  @IsOptional()
  @IsNumber()
  samplingRate?: number;

  @IsOptional()
  @IsBoolean()
  alwaysRecordErrors?: boolean;

  @IsOptional()
  @IsBoolean()
  alwaysRecordIdentified?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  alwaysRecordOnUrls?: string[];
}

/**
 * PATCH /v1/settings/ai-mode. `enabled` is required to stay assignable to the
 * service param `{ enabled: boolean }` (the service reads `enabled !== false`).
 */
export class SetAiModeDto {
  @IsBoolean()
  enabled!: boolean;
}

/**
 * PATCH /v1/settings/intel-interval. `hours` required to stay assignable to the
 * service param `{ hours: number }` (0 = off; clamped 0..168 in the service).
 */
export class SetIntelIntervalDto {
  @IsNumber()
  hours!: number;
}

/**
 * PATCH /v1/settings/business. `avgOrderValueCents` is `number | null` — null
 * CLEARS the value (dashboard falls back to reach-only). `@IsOptional` lets
 * null (and an omitted key) skip `@IsNumber`; the field stays present-shaped so
 * it is assignable to `{ avgOrderValueCents: number | null }`.
 */
export class SetBusinessDto {
  @IsOptional()
  @IsNumber()
  avgOrderValueCents!: number | null;
}

/**
 * PATCH /v1/settings/llm — LlmService.setConfig body. `apiKey` is write-only:
 * "" or null CLEARS the stored key, so NO MinLength (the "" sentinel must pass)
 * and `@IsOptional` lets null skip `@IsString`. The *Model fields are nullable
 * for the same clear-the-override reason. Assignable to the setConfig param.
 */
export class SetLlmDto {
  @IsOptional()
  @IsIn(LLM_MODES)
  mode?: LlmProviderMode;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  provider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  guardModel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  causeModel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  askModel?: string | null;

  @IsOptional()
  @IsNumber()
  dailyTokenBudget?: number;
}
