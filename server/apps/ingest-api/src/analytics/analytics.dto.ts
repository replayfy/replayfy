import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from "class-validator";

const GRANULARITIES = ["day", "week", "month"] as const;

/**
 * Trends query builder body. Top-level validation only (mirrors the Funnels
 * DTOs): the ValidationPipe strips any undeclared property, and AnalyticsService
 * does the deep per-series validation + whitelisting so a malformed series /
 * filter can never reach the SQL.
 */
export class TrendsSeriesDto {
  @IsOptional() @IsArray() series?: unknown[];

  // nullable dimension — null means "no breakdown"
  @IsOptional()
  @ValidateIf((o) => o.breakdown !== null)
  @IsString()
  @MaxLength(64)
  breakdown?: string | null;

  @IsOptional() @IsString() @MaxLength(32) range?: string;
  @IsOptional() @IsInt() from?: number;
  @IsOptional() @IsInt() to?: number;
  @IsOptional() @IsIn(GRANULARITIES) granularity?: string;
  @IsOptional() @IsBoolean() compare?: boolean;
  @IsOptional() @IsArray() filters?: unknown[];
}
