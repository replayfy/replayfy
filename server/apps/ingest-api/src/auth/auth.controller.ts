import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtUserGuard } from "../common/auth.guard";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser, type UserAuthContext } from "../common/auth.context";
import { AuthService } from "./auth.service";
import { LoginDto, SignupDto } from "./auth.dto";
import {
  callbackUrl,
  dashboardErrorUrl,
  dashboardSuccessUrl,
  getProviderConfig,
  signState,
  verifyState,
  type OAuthProvider
} from "./oauth";

// Brute-force / credential-stuffing guard: 20 auth requests per minute per IP,
// far below the global limit. Covers login/signup/password/verify uniformly.
@Throttle(20, 60)
@Controller("v1/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  async login(@Body() body: LoginDto) {
    if (!body?.email || !body?.password) {
      throw new BadRequestException("email and password are required");
    }
    return this.authService.login(body.email, body.password);
  }

  @Post("signup")
  async signup(@Body() body: SignupDto) {
    return this.authService.signup(body);
  }

  @Post("logout")
  logout() {
    return { ok: true };
  }

  @Post("verify")
  verify(@Body() body: { token: string }) {
    return this.authService.confirmVerification(body?.token);
  }

  @Post("resend-verification")
  async resend(@Body() body: { email: string }) {
    await this.authService.resendVerification(body?.email ?? "");
    return { ok: true };
  }

  @Post("invite/inspect")
  inspectInvite(@Body() body: { token: string }) {
    return this.authService.inspectInvite(body?.token);
  }

  @Post("invite/accept")
  acceptInvite(
    @Body() body: { token: string; password: string; name?: string },
  ) {
    return this.authService.acceptInvite(
      body?.token,
      body?.password,
      body?.name,
    );
  }

  /**
   * Forgot-password entry point. Always 200 so the response can't be used to
   * enumerate accounts. The email (if it exists) is delivered async via the
   * Bull email queue.
   */
  @Post("password/forgot")
  forgotPassword(@Body() body: { email: string }) {
    return this.authService.requestPasswordReset(body?.email ?? "");
  }

  @Post("password/reset")
  resetPassword(@Body() body: { token: string; password: string }) {
    return this.authService.confirmPasswordReset(body?.token, body?.password);
  }

  /** "Email me a sign-in link" — always {ok:true} (no account enumeration).
   *  Covered by the controller-wide @Throttle(20,60) per IP. */
  @Post("magic/request")
  magicRequest(@Body() body: { email: string }) {
    return this.authService.requestMagicLink(body?.email ?? "");
  }

  /** Consume the emailed token → a session (mirrors verify's response shape). */
  @Post("magic/consume")
  magicConsume(@Body() body: { token: string }) {
    return this.authService.consumeMagicLink(body?.token);
  }

  /**
   * OAuth start — 302 to the provider's auth URL. We sign a `state` query
   * param so the callback can verify the round trip is ours (CSRF defence).
   * Provider env vars must be set, otherwise we 400 with a clear message.
   */
  @Get("oauth/:provider/start")
  startOAuth(
    @Param("provider") provider: OAuthProvider,
    @Res() res: Response
  ) {
    const cfg = getProviderConfig(provider);
    if (!cfg) {
      throw new BadRequestException(
        `OAuth provider "${provider}" is not configured. Set ${provider.toUpperCase()}_CLIENT_ID and _CLIENT_SECRET.`
      );
    }
    const state = signState({ provider });
    const url = new URL(cfg.authUrl);
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", callbackUrl(provider));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", cfg.scope);
    url.searchParams.set("state", state);
    if (provider === "google") {
      // Force the account chooser so users can switch quickly.
      url.searchParams.set("prompt", "select_account");
    }
    res.redirect(url.toString());
  }

  @Get("oauth/:provider/callback")
  async oauthCallback(
    @Param("provider") provider: OAuthProvider,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") providerError: string | undefined,
    @Res() res: Response
  ) {
    if (providerError) return res.redirect(dashboardErrorUrl(providerError));
    if (!code || !state) return res.redirect(dashboardErrorUrl("missing_code"));
    const verified = verifyState(state);
    if (!verified || verified.provider !== provider) {
      return res.redirect(dashboardErrorUrl("bad_state"));
    }
    const cfg = getProviderConfig(provider);
    if (!cfg) return res.redirect(dashboardErrorUrl("provider_unconfigured"));
    try {
      const session = await this.authService.completeOAuthLogin(cfg, code);
      return res.redirect(dashboardSuccessUrl(session.token!));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "oauth_failed";
      return res.redirect(dashboardErrorUrl(msg));
    }
  }
}

// User-scoped, not workspace-scoped: /me is how the dashboard discovers that a
// freshly verified user has zero workspaces and needs onboarding, so it cannot
// require one. Every handler here keys off userId alone.
@Controller("v1/me")
@UseGuards(JwtUserGuard)
export class MeController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  async me(@CurrentUser() user: UserAuthContext) {
    return this.authService.me(user.userId);
  }

  @Patch()
  async update(
    @CurrentUser() user: UserAuthContext,
    @Body() body: { name?: string; avatarUrl?: string },
  ) {
    return this.authService.updateMe(user.userId, body);
  }

  @Post("password")
  async changePassword(
    @CurrentUser() user: UserAuthContext,
    @Body() body: { oldPassword: string; newPassword: string },
  ) {
    return this.authService.updatePassword(
      user.userId,
      body?.oldPassword ?? "",
      body?.newPassword ?? "",
    );
  }
}
