import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import type { CohortKind } from "@replay/db-postgres";

// CohortKind enum mirror (packages/db-postgres schema: enum CohortKind { AUTO
// MANUAL }). Kept as a runtime array so @IsIn can validate; `kind` is still
// typed as CohortKind so the DTO stays assignable to the service param.
const COHORT_KINDS = ["AUTO", "MANUAL"] as const;

/**
 * Create-cohort body. Declares every field cohorts.service.create reads —
 * name / description / kind / filter — so the global whitelist pipe keeps them
 * all. `filter` is the freeform dashboard filter tree ({type,groups,...}); it is
 * validated only as "an object" (no @ValidateNested), so the entire nested tree
 * passes through untouched rather than being stripped condition-by-condition.
 */
export class CreateCohortDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsIn(COHORT_KINDS)
  kind?: CohortKind;

  @IsOptional()
  @IsObject()
  filter?: Record<string, unknown>;
}

/**
 * Update-cohort body — cohorts.service.update reads name / description / filter
 * (all optional patch fields). `filter` kept permissive/untouched as above.
 */
export class UpdateCohortDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsObject()
  filter?: Record<string, unknown>;
}

/**
 * Add-members body — cohorts.service.addMembers reads `userIds` (EndUser ids to
 * attach to a MANUAL cohort). Validated as an int array; the service still
 * coerces + filters non-finite entries downstream.
 */
export class AddCohortMembersDto {
  @IsArray()
  @IsInt({ each: true })
  userIds!: number[];
}

/**
 * Preview body — cohorts.service.preview reads `filter` (the candidate filter
 * tree). Optional because the controller defaults an absent filter to an empty
 * {type:"and",groups:[]}; kept as a bare @IsObject so the nested tree survives
 * whitelisting.
 */
export class PreviewCohortDto {
  @IsOptional()
  @IsObject()
  filter?: Record<string, unknown>;
}
