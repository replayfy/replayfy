import { IsNumber, IsOptional } from "class-validator";

/**
 * Body for PATCH v1/dashboard/storyline-interval. The controller coerces this to
 * `Number(body?.hours ?? 12)` and the service clamps it to 0–168, so the only
 * field the code reads is the optional numeric `hours` (0 = narration off).
 */
export class SetStorylineIntervalDto {
  @IsOptional()
  @IsNumber()
  hours?: number;
}
