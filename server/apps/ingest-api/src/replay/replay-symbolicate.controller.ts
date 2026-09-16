import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { CurrentWorkspaceId } from "../common/auth.context";
import { JwtAuthGuard } from "../common/auth.guard";
import { SymbolicationService } from "./symbolication.service";

/**
 * Dashboard-UI-facing crash + ANR stack deobfuscation.
 *
 * Lives in the replay module (alongside the symbol-upload route on
 * ``ReplayIngestController``) since deobfuscation is a replay-domain
 * operation — the dashboard module only handles overview-style
 * counters. Workspace-authed (`JwtAuthGuard`) because the
 * dashboard's logged-in user calls it on demand when expanding an
 * error row, not the SDK.
 *
 * Why a dedicated controller rather than a method on
 * ``ReplayIngestController``: the ingest controller is API-key
 * authed (SDK traffic) and lives on a separate guard surface;
 * mixing JwtAuthGuard onto specific methods invites
 * mis-decoration. Separate controller keeps the auth model
 * one-controller-one-guard.
 */
@Controller("v1/replay")
@UseGuards(JwtAuthGuard)
export class ReplaySymbolicateController {
  constructor(private readonly symbolication: SymbolicationService) {}

  /**
   * Symbolicate a single crash / ANR stack trace using the
   * customer's uploaded `mapping.txt` (Android JVM) or `.so`
   * debug binaries (Android NDK).
   *
   * Called by the dashboard's crash + ANR detail card when the
   * user expands a row. Returns the deobfuscated stack if symbols
   * are available + the SDK shipped `appVersion` + `appBuild`
   * with the crash. Falls back to the raw input when:
   *   - the customer hasn't uploaded symbols for this version yet
   *   - the input stack doesn't match any known obfuscated names
   *   - storage isn't configured (local dev without R2 env)
   *
   * Always returns 200 with the best-available stack — never
   * fails the dashboard render.
   */
  @Post("symbolicate")
  async symbolicate(
    @CurrentWorkspaceId() workspaceId: number,
    @Body()
    body: {
      platform: string;
      version: string;
      build: string;
      kind: string;
      stack: string;
    },
  ): Promise<{ stack: string; symbolicated: boolean }> {
    // Defensive guards — the dashboard SHOULD send well-formed
    // values, but a stale client could miss a field. Respond with
    // the raw stack rather than a 4xx so the UI doesn't break when
    // the SDK didn't ship appVersion (older client installs).
    if (!body?.stack || !body?.platform || !body?.version || !body?.build) {
      return { stack: body?.stack ?? "", symbolicated: false };
    }
    if (body.platform !== "android" && body.platform !== "ios") {
      return { stack: body.stack, symbolicated: false };
    }
    const symbolicated = await this.symbolication.symbolicate(
      {
        workspaceId,
        platform: body.platform,
        version: body.version,
        build: body.build,
      },
      body.kind ?? "uncaught",
      body.stack,
    );
    return {
      stack: symbolicated,
      // True when we actually changed the stack — caller can show
      // an "auto-deobfuscated" badge in that case.
      symbolicated: symbolicated !== body.stack,
    };
  }
}
