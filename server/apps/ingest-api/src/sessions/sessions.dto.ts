import { IsBoolean, IsNumber, IsObject, IsOptional } from "class-validator";

/**
 * PATCH /v1/sessions/:publicId body. Only the two mutable flags the service
 * writes (`bookmarked`, `viewed`); everything else on a session is derived and
 * must not be client-settable, so whitelist stripping it is the desired guard.
 */
export class UpdateSessionDto {
  @IsOptional()
  @IsBoolean()
  bookmarked?: boolean;

  @IsOptional()
  @IsBoolean()
  viewed?: boolean;
}

/**
 * POST /v1/sessions/:publicId/share body.
 *
 * `panels` is a per-key visibility map merged over DEFAULT_PANELS in the
 * service. It is kept as a freeform object ON PURPOSE: the service's real
 * SharePanels shape has SEVEN keys (events/console/network/perf/comments plus
 * the mobile-only crashes/screens), more than the controller's old inline type
 * enumerated. Declaring @IsObject() whitelists the top-level `panels` key while
 * leaving every nested key untouched, so mobile clients' crashes/screens flags
 * are preserved instead of being silently stripped.
 */
export class CreateShareDto {
  @IsOptional()
  @IsObject()
  panels?: Record<string, boolean>;

  @IsOptional()
  @IsNumber()
  expiresInHours?: number;
}
