import { WorkspaceRole } from "@replay/db-postgres";
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

const ENVS = ["PRODUCTION", "STAGING", "DEVELOPMENT"] as const;
const REGIONS = ["US", "EU"] as const;

/**
 * Create-workspace body. Note what is DELIBERATELY absent: `plan`. The global
 * ValidationPipe's `whitelist` strips any field not declared here, so a client
 * can no longer self-assign a paid plan on create (defense-in-depth with
 * workspaces.service, which always creates FREE). Same for update below.
 */
export class CreateWorkspaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  domain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  swatch?: string;

  @IsOptional()
  @IsIn(ENVS)
  env?: (typeof ENVS)[number];

  @IsOptional()
  @IsIn(REGIONS)
  dataRegion?: (typeof REGIONS)[number];
}

export class UpdateWorkspaceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  domain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  swatch?: string;

  @IsOptional()
  @IsIn(ENVS)
  env?: (typeof ENVS)[number];
}

/**
 * Change a member's role. `role` is validated against the WorkspaceRole enum so
 * a garbage value is a 400 rather than a 500 from Prisma. IMPORTANT: enum
 * validation alone does NOT stop an ADMIN choosing `OWNER` (it is a valid enum
 * member) — that privilege cap lives in WorkspacesService.updateMemberRole,
 * where only an existing OWNER may grant the OWNER role.
 */
export class UpdateMemberRoleDto {
  @IsEnum(WorkspaceRole)
  role!: WorkspaceRole;
}

/**
 * Create an invite. `role` is optional (the service defaults it to MEMBER) and
 * enum-checked. As with member-role updates, granting `OWNER` is capped in the
 * service to existing owners — the DTO can't express that because OWNER is a
 * valid enum value.
 */
export class CreateInviteDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsEnum(WorkspaceRole)
  role?: WorkspaceRole;
}
