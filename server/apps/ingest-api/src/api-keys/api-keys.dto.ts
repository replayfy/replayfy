import { IsArray, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

// Mirror of the Prisma ApiKeyScope enum. Kept as a local const so @IsIn has
// runtime values while the type stays assignable to ApiKeyScope (a string
// literal union), which is what the service's CreateApiKeyBody expects.
const SCOPES = ["PUBLIC", "SERVER", "WEBHOOK"] as const;

/**
 * Create-api-key body. Declares every field the service actually reads
 * (name, scope, envs) so the global ValidationPipe whitelist can't strip a
 * real field. `prefix`, `keyHash`, `createdById`, etc. are minted/derived
 * server-side and are DELIBERATELY absent so a client can't self-assign them.
 */
export class CreateApiKeyDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn(SCOPES)
  scope!: (typeof SCOPES)[number];

  // Freeform list of environment labels the key is scoped to (e.g.
  // "PRODUCTION"). Optional; defaults to [] in the service.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  envs?: string[];
}
