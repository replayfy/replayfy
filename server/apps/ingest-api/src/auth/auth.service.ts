import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import {
  getPostgresClient,
  WorkspaceRole,
  WorkspaceEnv,
  WorkspacePlan,
} from "@replay/db-postgres";
import { Inject } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS_CLIENT } from "../common/redis.module";
import { EmailService } from "../email/email.service";
import { signJwt } from "./jwt";
import { hashPassword, verifyPassword } from "./password";
import { callbackUrl, type OAuthProfile, type ProviderConfig } from "./oauth";
import { uniqueSlug } from "../common/slug";

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 60 * 60 * 1000;          // 1 hour
const RESET_TTL_MS = 10 * 60 * 1000;           // 10 minutes
const MAGIC_TTL_MS = 10 * 60 * 1000;           // 10 minutes

export interface SessionUser {
  id: number;
  email: string;
  name: string | null;
  initials: string | null;
  avatarUrl: string | null;
}

export interface AuthSession {
  token: string | null;
  user: SessionUser;
  /** null when the user has no workspace yet — onboarding creates the first. */
  workspaceId: number | null;
  firstWorkspace?: boolean;
  pendingVerification?: boolean;
}

export interface WorkspaceMembershipSummary {
  workspaceId: number;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  workspace: {
    id: number;
    slug: string;
    name: string;
    domain: string | null;
    env: string;
    plan: string;
    swatch: string | null;
  };
}

interface SignupInput {
  email: string;
  password: string;
  name?: string;
}

/**
 * The only Workspace columns auth ever hands back. `workspace: true` pulled the
 * whole row — 16 columns including FOUR jsonb blobs (samplingConfig,
 * retentionConfig, recordingConfig, maskingConfig) that no auth response reads
 * — once per membership, on every login and every /me. Postgres TOASTs large
 * jsonb, so each was its own side-table fetch on the hottest path in the app.
 */
const AUTH_WORKSPACE_SELECT = {
  id: true,
  slug: true,
  name: true,
  domain: true,
  env: true,
  plan: true,
  swatch: true,
} as const;

// A valid throwaway password hash used ONLY to equalize login timing: when the
// email doesn't exist we still run one scrypt against this so the response time
// can't distinguish a registered email from an unknown one (the no-user path
// used to return before hashing — a ~18x timing side-channel for enumeration).
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(24).toString("hex"));

@Injectable()
export class AuthService {
  private readonly db = getPostgresClient();

  constructor(
    private readonly email: EmailService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** At most one email of `kind` per `id` per window. SET NX returns "OK" only
   *  the first time in the window, null after — so a user hammering login (or
   *  the magic-link box) triggers exactly one send per 10 minutes, never a
   *  storm. Redis failure fails OPEN (better a rare duplicate email than a
   *  swallowed one), which is the opposite trade-off from the AI throttle: an
   *  extra verification email is harmless, a silently-dropped one strands the
   *  user. */
  private async emailCooldownOk(
    kind: string,
    id: number | string,
  ): Promise<boolean> {
    try {
      const first = await this.redis.set(
        `auth:cooldown:${kind}:${id}`,
        "1",
        "EX",
        600,
        "NX",
      );
      return first === "OK";
    } catch {
      return true;
    }
  }

  async login(email: string, password: string): Promise<AuthSession> {
    // Canonicalize on READ exactly as we do on WRITE (register/OAuth/invite all
    // store lowercased) — otherwise a login as "User@x.com" misses the account
    // stored as "user@x.com". findUnique still rides the unique index (no scan).
    const normalized = email?.trim().toLowerCase() ?? "";
    const user = await this.db.user.findUnique({
      where: { email: normalized },
      include: { memberships: true },
    });
    // Always run exactly one scrypt — against the real hash if the account
    // exists, else against a constant dummy — so an unknown email and a wrong
    // password take the same time (defeats timing-based user enumeration). Same
    // opaque "Invalid credentials" for both.
    const ok = verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user?.passwordHash || !ok)
      throw new UnauthorizedException("Invalid credentials");
    if (!user.emailVerifiedAt) {
      // The old verification link expires after 24h (VERIFY_TTL_MS), so a user
      // who didn't verify in time was permanently stuck: "check your inbox" for
      // a link that's already dead. Send a FRESH one on the login attempt, but
      // Redis-gated to one per 10 minutes so repeated logins don't spam.
      if (await this.emailCooldownOk("verify", user.id)) {
        await this.issueVerification(user.id, user.email, user.name);
      }
      throw new ForbiddenException(
        "Email not verified — we've emailed you a fresh verification link. Check your inbox.",
      );
    }
    // No membership is a legitimate state now: signup creates no workspace, so
    // a user who never finished onboarding must still be able to log in and go
    // back to it.
    const membership = user.memberships[0];
    const workspaceId = membership?.workspaceId ?? null;
    await this.db.user.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() },
    });
    const token = signJwt({
      userId: user.id,
      email: user.email,
      workspaceId,
    });
    return {
      token,
      workspaceId,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        initials: user.initials,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  async signup(input: SignupInput): Promise<AuthSession> {
    const email = input.email?.trim().toLowerCase();
    if (!email || !input.password)
      throw new BadRequestException("email and password are required");
    if (input.password.length < 6)
      throw new BadRequestException("password must be at least 6 characters");
    const exists = await this.db.user.findUnique({ where: { email } });
    // A signup against an email that is registered but NEVER verified is almost
    // always the same person coming back to an expired link, so re-send it
    // rather than dead-ending them on "already exists".
    //
    // Deliberately NOT doing two things here, both of which are account
    // takeover: this returns no session (signup normally hands back a token, so
    // anyone could claim a stranger's pending signup just by typing their
    // address), and it does not touch the stored password (an attacker could
    // otherwise write their own password onto the account, wait for the real
    // owner to click the verify link that lands in the OWNER's inbox, and log
    // in afterwards). The mail goes to the address itself, which is the only
    // party that can act on it, so the flow stays proof-of-ownership.
    if (exists && !exists.emailVerifiedAt) {
      await this.issueVerification(exists.id, exists.email, exists.name);
      throw new ConflictException(
        "That email is already registered but not verified — we've sent a new verification link. Check your inbox.",
      );
    }
    if (exists)
      throw new ConflictException("An account with that email already exists");

    const name = input.name?.trim() || email.split("@")[0];
    const initials = name
      .split(" ")
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();

    // Deliberately no workspace here — onboarding creates the one and only
    // workspace, with the name/slug/region the user actually picks. Creating a
    // throwaway one first left every account with a dead `X's Workspace`
    // alongside the real one.
    // Self-host escape hatch. Verification is a MAGIC LINK, so with no working
    // mail server it can never be clicked and login stays blocked forever
    // (login() refuses until emailVerifiedAt is set). AUTH_AUTOVERIFY marks the
    // email verified at creation and returns a real session immediately — the
    // same shape confirmVerification() hands a fresh signup (no workspace yet →
    // onboarding). Default OFF: on a publicly reachable instance this drops the
    // proof-of-ownership the link provides (anyone could mint verified
    // accounts), so it is a single/trusted-instance bootstrap switch. The
    // turnkey stack ships Mailpit, so the link is available (at :8025) even
    // without this.
    const autoVerifyRaw = (process.env.AUTH_AUTOVERIFY ?? "").toLowerCase();
    const autoVerify =
      autoVerifyRaw === "true" || autoVerifyRaw === "1" || autoVerifyRaw === "yes";
    const user = await this.db.user.create({
      data: {
        email,
        name,
        initials,
        passwordHash: hashPassword(input.password),
        ...(autoVerify ? { emailVerifiedAt: new Date() } : {}),
      },
    });
    if (autoVerify) {
      return {
        token: signJwt({ userId: user.id, email: user.email, workspaceId: null }),
        pendingVerification: false,
        workspaceId: null,
        firstWorkspace: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          initials: user.initials,
          avatarUrl: user.avatarUrl,
        },
      };
    }
    // Issue verification token + send email — no JWT until they verify.
    const verifyUrl = await this.issueVerification(
      user.id,
      user.email,
      user.name,
    );
    void verifyUrl;
    return {
      token: null,
      pendingVerification: true,
      workspaceId: null,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        initials: user.initials,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  /** Returns the verification URL (also emails it). */
  async issueVerification(
    userId: number,
    email: string,
    name?: string | null,
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await this.db.emailVerification.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
      },
    });
    const base = process.env.APP_BASE_URL ?? "http://127.0.0.1:5180";
    const verifyUrl = `${base}/verify?token=${token}`;
    void this.email.sendVerify({ to: email, name: name ?? null, verifyUrl });
    return verifyUrl;
  }

  /** Look up token, verify, mark user verified. */
  async confirmVerification(token: string): Promise<AuthSession> {
    if (!token) throw new BadRequestException("Missing token");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const record = await this.db.emailVerification.findUnique({
      where: { tokenHash },
      include: {
        user: { include: { memberships: { include: { workspace: { select: { name: true } } } } } },
      },
    });
    if (!record || record.usedAt)
      throw new NotFoundException(
        "Verification link is invalid or already used",
      );
    if (record.expiresAt.getTime() < Date.now())
      throw new BadRequestException("Verification link has expired");
    await this.db.$transaction([
      this.db.emailVerification.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.db.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      }),
    ]);
    const user = record.user;
    // A password signup has no workspace at this point — verification is what
    // hands them the token they onboard with. Only an invited user who arrives
    // here already has one.
    const membership = user.memberships[0];
    const workspaceId = membership?.workspaceId ?? null;
    const jwt = signJwt({
      userId: user.id,
      email: user.email,
      workspaceId,
    });
    if (membership) {
      void this.email.sendWelcome({
        to: user.email,
        workspaceName: membership.workspace.name,
      });
    }
    return {
      token: jwt,
      pendingVerification: false,
      workspaceId,
      firstWorkspace: !membership,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        initials: user.initials,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.db.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!user || user.emailVerifiedAt) return; // silently no-op
    await this.issueVerification(user.id, user.email, user.name);
  }

  /** Look up an invite metadata by raw token — for the accept screen to render. */
  async inspectInvite(rawToken: string) {
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const invite = await this.db.invite.findUnique({
      where: { tokenHash },
      include: { workspace: { select: { name: true, slug: true } } },
    });
    if (!invite || invite.acceptedAt)
      throw new NotFoundException("Invite is invalid or already used");
    return {
      email: invite.email,
      role: invite.role,
      workspaceName: invite.workspace.name,
      workspaceSlug: invite.workspace.slug,
    };
  }

  /**
   * Accept an invite. If the invited email has an existing user, log them in;
   * otherwise create the user with the provided password.
   */
  async acceptInvite(
    rawToken: string,
    password: string,
    name?: string,
  ): Promise<AuthSession> {
    if (!rawToken) throw new BadRequestException("Missing token");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const invite = await this.db.invite.findUnique({
      where: { tokenHash },
    });
    if (!invite || invite.acceptedAt)
      throw new NotFoundException("Invite is invalid or already used");
    if (invite.expiredAt && invite.expiredAt.getTime() < Date.now())
      throw new BadRequestException("Invite has expired");

    let user = await this.db.user.findUnique({
      where: { email: invite.email.toLowerCase() },
    });
    if (!user) {
      if (!password || password.length < 6)
        throw new BadRequestException("password must be at least 6 characters");
      const initials = (name || invite.email)
        .split(/\s+/)
        .map((p) => p[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();
      user = await this.db.user.create({
        data: {
          email: invite.email.toLowerCase(),
          name: name?.trim() || invite.email.split("@")[0],
          initials,
          passwordHash: hashPassword(password),
          // Invite acceptance implicitly verifies the email since the token was delivered to it.
          emailVerifiedAt: new Date(),
        },
      });
    } else if (!user.emailVerifiedAt) {
      // Accepting via mail link verifies the email.
      await this.db.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      });
    }

    await this.db.$transaction([
      this.db.invite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      }),
      this.db.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: invite.workspaceId,
            userId: user.id,
          },
        },
        create: {
          workspaceId: invite.workspaceId,
          userId: user.id,
          role: invite.role,
        },
        update: { role: invite.role },
      }),
    ]);

    const token = signJwt({
      userId: user.id,
      email: user.email,
      workspaceId: invite.workspaceId,
    });
    return {
      token,
      workspaceId: invite.workspaceId,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        initials: user.initials,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  async updateMe(
    userId: number,
    patch: { name?: string; avatarUrl?: string },
  ): Promise<SessionUser> {
    const name = patch.name?.trim();
    const initials = name
      ? name
          .split(/\s+/)
          .map((p) => p[0])
          .slice(0, 2)
          .join("")
          .toUpperCase()
      : undefined;
    const user = await this.db.user.update({
      where: { id: userId },
      data: {
        ...(name ? { name, initials } : {}),
        ...(patch.avatarUrl !== undefined
          ? { avatarUrl: patch.avatarUrl?.trim() || null }
          : {}),
      },
    });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      initials: user.initials,
      avatarUrl: user.avatarUrl,
    };
  }

  /**
   * Update an authenticated user's password. Old password must match — this
   * protects against a stolen session bumping the password and locking the
   * real user out.
   */
  async updatePassword(userId: number, oldPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException("New password must be at least 6 characters");
    }
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User not found");
    // User.passwordHash is nullable in the schema (invited users without a
    // password). If it's null we treat the change-password flow as a soft
    // upgrade — let any current value through and just set the new hash.
    if (user.passwordHash && !verifyPassword(oldPassword, user.passwordHash)) {
      throw new BadRequestException("Current password is incorrect");
    }
    await this.db.user.update({
      where: { id: userId },
      data: { passwordHash: hashPassword(newPassword) }
    });
    // Invalidate any pending reset tokens since the password just rotated.
    await this.db.passwordReset.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() }
    });
    return { ok: true };
  }

  /**
   * Email-driven password reset request. Always returns ok=true so an
   * attacker can't enumerate which emails are real. The reset link expires
   * after 10 minutes — short window keeps a leaked inbox from causing
   * lasting damage.
   */
  async requestPasswordReset(email: string) {
    const normalized = email?.trim().toLowerCase();
    if (!normalized) return { ok: true };
    const user = await this.db.user.findUnique({ where: { email: normalized } });
    if (!user) return { ok: true };
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await this.db.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TTL_MS)
      }
    });
    const base = process.env.APP_BASE_URL ?? "http://127.0.0.1:5180";
    // Must match the dashboard route + query param the ResetPassword page reads
    // (router.tsx `/reset-password`, `params.get("token")`). The old
    // `/?reset=<token>` landed on the app root (login/home), never the
    // new-password screen — the email arrived but the reset couldn't be finished.
    const resetUrl = `${base}/reset-password?token=${token}`;
    void this.email.sendPasswordReset({ to: user.email, name: user.name, resetUrl, expiresInMinutes: RESET_TTL_MS / 60_000 });
    return { ok: true };
  }

  /**
   * "Email me a sign-in link instead" — passwordless login. Always returns
   * {ok:true} whether or not the email exists, so the response can't be used to
   * enumerate accounts (same contract as requestPasswordReset). Single-use,
   * 10-minute token; only its sha256 is stored. Redis-gated to one email per
   * user per 10 minutes so the box can't be used to spam someone's inbox.
   */
  async requestMagicLink(email: string): Promise<{ ok: true }> {
    const normalized = email?.trim().toLowerCase();
    if (!normalized) return { ok: true };
    const user = await this.db.user.findUnique({ where: { email: normalized } });
    if (!user) return { ok: true };
    if (!(await this.emailCooldownOk("magic", user.id))) return { ok: true };
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await this.db.magicLink.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + MAGIC_TTL_MS),
      },
    });
    const base = process.env.APP_BASE_URL ?? "http://127.0.0.1:5180";
    const magicUrl = `${base}/?magic=${token}`;
    void this.email.sendMagicLink({
      to: user.email,
      name: user.name,
      magicUrl,
      expiresInMinutes: MAGIC_TTL_MS / 60_000,
    });
    return { ok: true };
  }

  /**
   * Consume a magic-link token → a session. Rejects invalid/used/expired tokens,
   * marks it used in the same transaction (single-use), and — because arriving
   * via the emailed link PROVES the address — marks the email verified if it
   * wasn't, so a magic link doubles as verification (same as OAuth sign-in).
   */
  async consumeMagicLink(token: string): Promise<AuthSession> {
    if (!token) throw new BadRequestException("Missing token");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const record = await this.db.magicLink.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            memberships: { include: { workspace: { select: { name: true } } } },
          },
        },
      },
    });
    if (!record || record.usedAt)
      throw new NotFoundException("Sign-in link is invalid or already used");
    if (record.expiresAt.getTime() < Date.now())
      throw new BadRequestException("Sign-in link has expired");
    const user = record.user;
    await this.db.$transaction([
      this.db.magicLink.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      ...(user.emailVerifiedAt
        ? []
        : [
            this.db.user.update({
              where: { id: user.id },
              data: { emailVerifiedAt: new Date() },
            }),
          ]),
    ]);
    const membership = user.memberships[0];
    const workspaceId = membership?.workspaceId ?? null;
    const jwt = signJwt({ userId: user.id, email: user.email, workspaceId });
    return {
      token: jwt,
      pendingVerification: false,
      workspaceId,
      firstWorkspace: !membership,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        initials: user.initials,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  async confirmPasswordReset(rawToken: string, newPassword: string) {
    if (!rawToken) throw new BadRequestException("Missing token");
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException("New password must be at least 6 characters");
    }
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const record = await this.db.passwordReset.findUnique({ where: { tokenHash } });
    if (!record || record.usedAt) {
      throw new NotFoundException("Reset link is invalid or already used");
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("Reset link has expired — request a new one");
    }
    await this.db.$transaction([
      this.db.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      this.db.user.update({ where: { id: record.userId }, data: { passwordHash: hashPassword(newPassword) } })
    ]);
    return { ok: true };
  }

  async me(
    userId: number,
  ): Promise<{ user: SessionUser; memberships: WorkspaceMembershipSummary[] }> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: { memberships: { include: { workspace: { select: AUTH_WORKSPACE_SELECT } } } },
    });
    if (!user) throw new UnauthorizedException("User not found");
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        initials: user.initials,
        avatarUrl: user.avatarUrl,
      },
      memberships: user.memberships.map((m) => ({
        workspaceId: m.workspaceId,
        role: m.role,
        workspace: {
          id: m.workspace.id,
          slug: m.workspace.slug,
          name: m.workspace.name,
          domain: m.workspace.domain,
          env: m.workspace.env,
          plan: m.workspace.plan,
          swatch: m.workspace.swatch,
        },
      })),
    };
  }

  /**
   * Finish an OAuth round trip. Exchanges the code for an access token,
   * fetches the user profile, then upserts a User + a fresh workspace if
   * this email is brand new. Returns the same AuthSession shape password
   * login produces so the dashboard's auth bootstrap doesn't care which
   * path the user took.
   */
  async completeOAuthLogin(cfg: ProviderConfig, code: string): Promise<AuthSession> {
    const accessToken = await this.exchangeOAuthCode(cfg, code);
    const profile = await this.fetchOAuthProfile(cfg, accessToken);
    if (!profile.email) {
      throw new BadRequestException("OAuth provider did not return an email — we need it to identify your account.");
    }
    if (!profile.emailVerified) {
      throw new ForbiddenException("Verify your email with the OAuth provider before signing in.");
    }

    // Match on email — that's the identity we use across the product. If
    // we ever want strict provider-binding we can add (provider, providerUserId)
    // to a separate join table later.
    const existing = await this.db.user.findUnique({
      where: { email: profile.email },
      include: { memberships: true }
    });
    if (existing) {
      // Mark email as verified (OAuth covers that) and stamp lastSeen.
      await this.db.user.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
          avatarUrl: existing.avatarUrl ?? profile.avatarUrl ?? null,
          name: existing.name ?? profile.name ?? null
        }
      });
      // Same as password login: an account that signed up but never onboarded
      // has no workspace, and must still be able to get in.
      const membership = existing.memberships[0];
      const workspaceId = membership?.workspaceId ?? null;
      const token = signJwt({ userId: existing.id, email: existing.email, workspaceId });
      return {
        token,
        workspaceId,
        user: {
          id: existing.id,
          email: existing.email,
          name: existing.name,
          initials: existing.initials,
          avatarUrl: existing.avatarUrl ?? profile.avatarUrl ?? null
        }
      };
    }

    // Brand-new account — mirror the signup flow but skip the email
    // verification step (OAuth already verified it for us) and no
    // password is set (they'll log in via OAuth every time).
    const name = profile.name?.trim() || profile.email.split("@")[0];
    const initials = name
      .split(" ")
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
    // No workspace here, matching password signup: onboarding is the only
    // creator, so an OAuth user lands on the same empty state and picks their
    // own name/slug/region instead of inheriting a stray "<name>'s Workspace".
    const user = await this.db.user.create({
      data: {
        email: profile.email,
        name,
        initials,
        avatarUrl: profile.avatarUrl,
        emailVerifiedAt: new Date(),
      },
    });
    const token = signJwt({ userId: user.id, email: user.email, workspaceId: null });
    return {
      token,
      firstWorkspace: true,
      workspaceId: null,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        initials: user.initials,
        avatarUrl: user.avatarUrl
      }
    };
  }

  private async exchangeOAuthCode(cfg: ProviderConfig, code: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: callbackUrl(cfg.provider),
      grant_type: "authorization_code"
    });
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: params
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BadRequestException(`OAuth token exchange failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) throw new BadRequestException("OAuth provider did not return an access_token");
    return data.access_token;
  }

  private async fetchOAuthProfile(cfg: ProviderConfig, accessToken: string): Promise<OAuthProfile> {
    const res = await fetch(cfg.userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "replay-api" }
    });
    if (!res.ok) throw new BadRequestException(`OAuth userinfo fetch failed: ${res.status}`);
    const raw = await res.json();
    const profile = cfg.extractProfile(raw);
    if (!profile) throw new BadRequestException("OAuth profile missing required fields");
    if (!profile.email && cfg.fetchEmailIfMissing) {
      profile.email = (await cfg.fetchEmailIfMissing(accessToken)) ?? "";
    }
    return profile;
  }

  // Deterministic accent-color picker — same seed always returns the same
  // swatch, so a workspace's color is stable across reloads but spread out
  // across a curated palette.
  private static pickSwatch(seed: string): string {
    const palette = [
      "#2c2f7c",
      "#0d7373",
      "#9a4b1f",
      "#5b3a7c",
      "#1f5e3b",
      "#7b1f4a",
      "#2d3a55",
    ];
    let h = 0;
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
  }
}
