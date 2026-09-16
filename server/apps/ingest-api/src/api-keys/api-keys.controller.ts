import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { ApiKeyScope } from "@replay/db-postgres";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import {
  CurrentAuth,
  CurrentWorkspaceId,
  type AuthContext,
} from "../common/auth.context";
import { ApiKeysService } from "./api-keys.service";
import { CreateApiKeyDto } from "./api-keys.dto";

// API keys grant SDK ingest access — they're a workspace credential, so
// only members+ can mint/rotate/revoke. VIEWERs can't even list them
// because the secret key prefix is sensitive; we keep the list endpoint
// open to authenticated workspace members of any role though, since the
// API just returns hashed-prefix views.
@Controller("v1/api-keys")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ApiKeysController {
  constructor(private readonly service: ApiKeysService) {}

  @Get()
  @RequiresRole("MEMBER")
  list(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("scope") scope?: ApiKeyScope,
  ) {
    return this.service.list(workspaceId, { cursor, limit, scope });
  }

  // The workspace's publishable key for the Install snippet. MEMBER-visible: a
  // publishable (rpl_pk_) key ships in client app code, so it's non-secret —
  // SERVER/WEBHOOK keys are never revealed here (they stay shown-once at mint).
  // A pure GET; declared before the :id routes and safe since no GET :id exists.
  @Get("public")
  @RequiresRole("MEMBER")
  getPublic(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.getPublicKey(workspaceId);
  }

  @Post()
  @RequiresRole("ADMIN")
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateApiKeyDto) {
    return this.service.create(auth.workspaceId, auth.userId, body);
  }

  // Onboarding's "give me the project key for the snippet" call. Declared BEFORE
  // the parameterised routes so "bootstrap" is never swallowed as an :id, and
  // kept separate from POST / because it is idempotent: repeat calls (StrictMode,
  // a second tab, a refresh) return the same key rather than minting another.
  @Post("bootstrap")
  @RequiresRole("ADMIN")
  bootstrap(@CurrentAuth() auth: AuthContext) {
    return this.service.bootstrapPublicKey(auth.workspaceId, auth.userId);
  }

  @Delete(":id")
  @RequiresRole("ADMIN")
  revoke(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.revoke(workspaceId, id);
  }

  // Rotation reuses the existing row, so createdById still belongs to whoever
  // minted the key — the acting user isn't recorded here.
  @Post(":id/rotate")
  @RequiresRole("ADMIN")
  rotate(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.rotate(workspaceId, id);
  }
}
