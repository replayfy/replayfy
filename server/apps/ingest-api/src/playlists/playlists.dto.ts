import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import type { PlaylistKind } from "@replay/db-postgres";

const KINDS = ["AUTO", "MANUAL"] as const;

/**
 * Create-playlist body. Declares every field the service's `create` reads
 * (title, description, kind, filter, pinned) so the global ValidationPipe's
 * `whitelist` keeps them all instead of silently stripping any.
 *
 * `filter` is a freeform condition tree (`{ conditions: [...] }`) evaluated by
 * the playlist filter compiler at runtime; @IsObject keeps the whole nested
 * value untouched while still whitelisting the top-level key.
 */
export class CreatePlaylistDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsIn(KINDS)
  kind?: PlaylistKind;

  @IsOptional()
  @IsObject()
  filter?: unknown;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

/**
 * Update-playlist body. Mirrors the fields the service's `update` reads
 * (title, description, pinned, filter). All optional — a PATCH may send any
 * subset. `filter` kept intact via @IsObject as in create above.
 */
export class UpdatePlaylistDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsObject()
  filter?: unknown;
}

/**
 * Add-session body. `sessionId` is accepted as EITHER a numeric api id or a
 * `ses_…` public id string (see PlaylistsService.resolveSessionId), so it must
 * NOT be narrowed with @IsString or @IsNumber — either would reject one of the
 * two valid shapes AND, under `whitelist`, a rejected/undeclared value is
 * stripped. @IsDefined keeps the field and accepts both types while still
 * requiring it to be present.
 */
export class AddSessionDto {
  @IsDefined()
  sessionId!: number | string;
}
