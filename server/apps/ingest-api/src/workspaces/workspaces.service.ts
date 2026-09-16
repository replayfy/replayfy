import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { getPostgresClient, WorkspaceRole } from "@replay/db-postgres";
import { decodeCursor, paginateRows, parseLimit } from "../common/cursor";
import { paginated } from "../common/api-response";
import { generateRandomToken } from "../auth/jwt";
import { slugify } from "../common/slug";
import { EmailService } from "../email/email.service";
import { QueueService } from "../queue/queue.service";
import { NotificationsService } from "../notifications/notifications.service";

interface CreateWorkspaceInput {
  name: string;
  slug?: string;
  domain?: string;
  swatch?: string;
  env?: "PRODUCTION" | "STAGING" | "DEVELOPMENT";
  plan?: "FREE" | "PRO" | "TEAM" | "ENTERPRISE";
  dataRegion?: "US" | "EU";
}

interface ListMembersOptions {
  workspaceId: number;
  cursor?: string;
  limit?: string;
}

interface CreateInviteInput {
  email: string;
  // Optional: the service defaults an omitted role to MEMBER (see createInvite).
  role?: WorkspaceRole;
}

@Injectable()
export class WorkspacesService {
  private readonly db = getPostgresClient();

  constructor(
    private readonly email: EmailService,
    private readonly queue: QueueService,
    private readonly notifications: NotificationsService,
  ) {}

  async listForUser(userId: number) {
    const memberships = await this.db.workspaceMember.findMany({
      where: { userId },
      include: {
        workspace: {
          include: { _count: { select: { members: true } } },
        },
      },
      orderBy: { id: "asc" },
    });
    return memberships.map((m) =>
      this.toSummary(m.workspace, m.role, m.workspace._count.members),
    );
  }

  /** Access pattern: one point-read on Workspace.slug, which is @unique and so
   *  already carries a unique index — no scan, and no index to add.
   *  Advisory only: any answer here can be raced between the check and the
   *  write, so createForUser catches the constraint itself.
   *
   *  Runs the SHARED slugify, not a local copy: the form sends a name, and a
   *  check that answered for different text than the create derives is exactly
   *  how a green "available" tick ends in a unique-constraint 500. */
  async slugAvailable(raw: string): Promise<{ slug: string; available: boolean }> {
    const slug = slugify(raw ?? "");
    const taken = await this.db.workspace.findUnique({
      where: { slug },
      select: { id: true },
    });
    return { slug, available: !taken };
  }

  async createForUser(userId: number, input: CreateWorkspaceInput) {
    if (!input?.name?.trim()) throw new NotFoundException("name is required");
    const slug = slugify(input.slug ?? input.name);
    try {
      const workspace = await this.db.workspace.create({
        data: {
          slug,
          name: input.name.trim(),
          domain: input.domain,
          swatch: input.swatch,
          env: input.env ?? "PRODUCTION",
          // `plan` is NOT client-settable — a new workspace always starts FREE.
          // Entitlement changes flow through Stripe (billing webhook) only;
          // trusting a `plan` field in the request body was a paid-tier
          // mass-assignment bypass (free ENTERPRISE quota, no payment).
          plan: "FREE",
          dataRegion: input.dataRegion,
          members: {
            create: { userId, role: "OWNER" },
          },
        },
      });
      return this.toSummary(workspace, "OWNER");
    } catch (e) {
      // P2002 = unique violation. The create is the real gate — slugAvailable is
      // advisory and can always be raced — so answer 409 rather than letting a
      // raw Prisma error surface as a 500. Narrowed to the slug target so an
      // unrelated constraint still throws loudly instead of being mislabelled.
      const err = e as { code?: string; meta?: { target?: string[] | string } };
      const target = err?.meta?.target;
      const onSlug = Array.isArray(target)
        ? target.includes("slug")
        : typeof target === "string" && target.includes("slug");
      if (err?.code === "P2002" && onSlug)
        throw new ConflictException(`replayfy.io/${slug} is already taken.`);
      throw e;
    }
  }

  async get(workspaceId: number, userId: number) {
    await this.requireMembership(workspaceId, userId);
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
    });
    if (!ws) throw new NotFoundException("Workspace not found");
    const member = await this.db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    return this.toSummary(ws, member?.role ?? "MEMBER");
  }

  async update(
    workspaceId: number,
    userId: number,
    input: Partial<CreateWorkspaceInput>,
  ) {
    await this.requireRole(workspaceId, userId, ["OWNER", "ADMIN"]);
    const ws = await this.db.workspace.update({
      where: { id: workspaceId },
      data: {
        name: input.name,
        domain: input.domain,
        swatch: input.swatch,
        env: input.env,
        // `plan` intentionally omitted — see createForUser. Plan/entitlement is
        // owned by the Stripe billing webhook, never a client-supplied body.
      },
    });
    return this.toSummary(ws, "ADMIN");
  }

  /**
   * Soft-delete now, hard-delete later. We tombstone the workspace
   * immediately so logged-in users stop seeing it, then enqueue a Bull job
   * that batch-deletes sessions / Mongo batches / ClickHouse rows. The job
   * is idempotent and survives the API restarting half-way through.
   */
  async remove(workspaceId: number, userId: number) {
    await this.requireRole(workspaceId, userId, ["OWNER"]);
    await this.db.workspace.update({
      where: { id: workspaceId },
      data: { deletedAt: new Date() },
    });
    await this.queue.enqueueWorkspaceDelete({
      workspaceId,
      triggeredBy: userId,
      requestedAt: Date.now(),
    });
  }

  async listMembers({ workspaceId, cursor, limit }: ListMembersOptions) {
    const take = parseLimit(limit, 25, 100);
    const cursorId = decodeCursor(cursor);
    const rows = await this.db.workspaceMember.findMany({
      where: {
        workspaceId,
        ...(cursorId !== undefined ? { id: { lt: cursorId } } : {}),
      },
      include: { user: true },
      orderBy: { id: "desc" },
      take: take + 1,
    });
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);
    return paginated(
      items.map((m) => ({
        id: m.id,
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        initials: m.user.initials,
        role: m.role,
        lastActiveAt: m.lastActiveAt?.toISOString() ?? null,
        createdAt: m.createdAt.toISOString(),
      })),
      nextCursor,
    );
  }

  private memberSummary(m: {
    id: number;
    userId: number;
    role: WorkspaceRole;
    lastActiveAt: Date | null;
    createdAt: Date;
    user: { email: string | null; name: string | null; initials: string | null };
  }) {
    return {
      id: m.id,
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      initials: m.user.initials,
      role: m.role,
      lastActiveAt: m.lastActiveAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
    };
  }

  /** Change a member's role. OWNER/ADMIN only. The workspace OWNER is
   *  protected — their role can never be changed (403), so ownership can't be
   *  demoted or transferred through this route. */
  async updateMemberRole(
    workspaceId: number,
    actorUserId: number,
    memberId: number,
    role: WorkspaceRole,
  ) {
    const actor = await this.requireRole(workspaceId, actorUserId, [
      "OWNER",
      "ADMIN",
    ]);
    // Only an existing OWNER may grant the OWNER role. Without this an ADMIN
    // could promote any member (or themselves) to OWNER and mint a second owner
    // — a privilege escalation the DTO's @IsEnum can't catch, because OWNER is a
    // valid enum value. (Demoting an existing owner is separately blocked below.)
    if (role === "OWNER" && actor.role !== "OWNER") {
      throw new ForbiddenException("Only an owner can grant the owner role.");
    }
    const member = await this.db.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
      include: { user: true },
    });
    if (!member) throw new NotFoundException("Member not found");
    // The workspace owner is protected — their role can't be changed (and the
    // owner can't demote themselves). Ownership transfer is out of scope here.
    if (member.role === "OWNER") {
      throw new ForbiddenException("The workspace owner's role can't be changed.");
    }
    const updated = await this.db.workspaceMember.update({
      where: { id: memberId },
      data: { role },
      include: { user: true },
    });
    return this.memberSummary(updated);
  }

  /** Remove a member from the workspace. OWNER/ADMIN only. The workspace OWNER
   *  is protected — they can never be removed (403), so a workspace can't be
   *  left without an owner. */
  async removeMember(workspaceId: number, actorUserId: number, memberId: number) {
    await this.requireRole(workspaceId, actorUserId, ["OWNER", "ADMIN"]);
    const member = await this.db.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
    });
    if (!member) throw new NotFoundException("Member not found");
    // The workspace owner can't be removed (and can't delete their own account
    // here) — this protects against locking a workspace out of ownership.
    if (member.role === "OWNER") {
      throw new ForbiddenException("The workspace owner can't be removed.");
    }
    await this.db.workspaceMember.delete({ where: { id: memberId } });
    return { removed: true };
  }

  /** The signed-in user removes THEMSELVES from a workspace. Any member may leave;
   *  the LAST remaining OWNER may not — that would strand the workspace with no
   *  owner (removeMember above already blocks removing an owner from the other
   *  direction). They must hand ownership to another member or delete the
   *  workspace first. Scoped to the caller's own membership, so no role guard on
   *  the target is needed — you can only ever leave on your own behalf. */
  async leaveWorkspace(workspaceId: number, userId: number) {
    // The last-owner check and the delete run in ONE transaction, and for an
    // owner we take a row lock on this workspace's OWNER memberships
    // (SELECT ... FOR UPDATE). Without the lock this is a TOCTOU race: two
    // owners leaving at the same instant could both read owners=2, both pass
    // the guard, and both delete — leaving the workspace with no owner, the
    // exact invariant this method exists to protect (a sequential test can't
    // surface it). The lock serialises concurrent owner-leaves on the same
    // workspace, so the second re-reads the reduced set and is refused.
    return this.db.$transaction(async (tx) => {
      const member = await tx.workspaceMember.findFirst({
        where: { workspaceId, userId },
      });
      if (!member) {
        throw new NotFoundException("You're not a member of this workspace.");
      }
      if (member.role === "OWNER") {
        // Locks ONLY this workspace's owner rows — a handful, reached via the
        // @@index([workspaceId]); a bounded set, not a table scan, so it
        // scales. A non-owner needs no lock: leaving can't touch the owner
        // invariant, so that path skips straight to the delete.
        const owners = await tx.$queryRaw<Array<{ id: number }>>`
          SELECT "id" FROM "WorkspaceMember"
          WHERE "workspaceId" = ${workspaceId} AND "role" = 'OWNER'::"WorkspaceRole"
          FOR UPDATE`;
        if (owners.length <= 1) {
          throw new ForbiddenException(
            "You're the only owner of this workspace. Transfer ownership to another member, or delete the workspace, before leaving.",
          );
        }
      }
      await tx.workspaceMember.delete({ where: { id: member.id } });
      return { left: true };
    });
  }

  async listInvites(workspaceId: number, userId: number) {
    await this.requireRole(workspaceId, userId, ["OWNER", "ADMIN"]);
    const invites = await this.db.invite.findMany({
      where: { workspaceId, acceptedAt: null },
      orderBy: { id: "desc" },
    });
    return invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      sentAt: i.sentAt.toISOString(),
    }));
  }

  async createInvite(
    workspaceId: number,
    userId: number,
    input: CreateInviteInput,
  ) {
    const member = await this.requireRole(workspaceId, userId, [
      "OWNER",
      "ADMIN",
    ]);
    // Same owner cap as updateMemberRole: an ADMIN may invite MEMBER/ADMIN, but
    // only an existing OWNER may invite someone straight in as OWNER — otherwise
    // the invite, once accepted, would mint a second owner.
    if (input.role === "OWNER" && member.role !== "OWNER") {
      throw new ForbiddenException("Only an owner can invite a new owner.");
    }
    const email = input.email?.trim().toLowerCase();
    if (!email) throw new ForbiddenException("Email is required");

    // Pre-flight #1: don't invite someone already in the workspace.
    // We look up the User by email then check if they have a membership
    // on this workspace. Beats letting the invite fly + having the
    // accept handler fail with a confusing "already a member" error
    // a click later.
    const existingUser = await this.db.user.findUnique({ where: { email } });
    if (existingUser) {
      const existingMember = await this.db.workspaceMember.findFirst({
        where: { workspaceId, userId: existingUser.id },
      });
      if (existingMember) {
        throw new ForbiddenException(
          `${email} is already a member of this workspace.`,
        );
      }
    }
    // Pre-flight #2: don't double-issue invites. If there's a pending
    // (unaccepted, unexpired) invite for the same email, refuse — the
    // sender should resend the existing one via the kebab menu so the
    // accept link the recipient already received keeps working.
    const pending = await this.db.invite.findFirst({
      where: {
        workspaceId,
        email,
        acceptedAt: null,
        expiredAt: { gt: new Date() },
      },
    });
    if (pending) {
      throw new ForbiddenException(
        `A pending invite for ${email} already exists. Resend it from the Team tab.`,
      );
    }

    const token = generateRandomToken(24);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    // Invites are short-lived — 1 hour matches the copy in the email and
    // keeps stolen links from being useful for long.
    const expiredAt = new Date(Date.now() + 60 * 60 * 1000);
    const invite = await this.db.invite.create({
      data: {
        workspaceId,
        email,
        role: input.role ?? "MEMBER",
        tokenHash,
        sentById: userId,
        expiredAt,
      },
      include: { workspace: true },
    });
    const inviter = await this.db.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    const inviteUrl = `${process.env.APP_BASE_URL ?? "http://127.0.0.1:5180"}/?invite=${token}`;
    void this.email.sendInvite({
      to: invite.email,
      workspaceName: invite.workspace.name,
      inviteUrl,
      inviterName: inviter?.name ?? inviter?.email ?? undefined,
    });
    // Notify the inviting admin that the invite went out. Confirms the
    // action and shows up in the bell so they remember to follow up.
    void this.notifications.emit({
      workspaceId,
      userId,
      kind: "TEAM_INVITE_SENT",
      payload: {
        email: invite.email,
        role: invite.role,
        workspaceName: invite.workspace.name,
      },
    });
    return {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      inviteToken: token,
      inviteUrl,
      member: { role: member.role },
    };
  }

  /**
   * Resend a pending invite. Since the original token can't be recovered from
   * the stored hash, we rotate to a fresh token and re-send the email. The
   * previous link goes dead — that's a feature, not a bug.
   */
  async resendInvite(workspaceId: number, userId: number, inviteId: number) {
    await this.requireRole(workspaceId, userId, ["OWNER", "ADMIN"]);
    const existing = await this.db.invite.findUnique({
      where: { id: inviteId },
      include: { workspace: true },
    });
    if (!existing) throw new ForbiddenException("Invite not found");
    if (existing.acceptedAt)
      throw new ForbiddenException("Invite already accepted");

    const newToken = generateRandomToken(24);
    const newHash = createHash("sha256").update(newToken).digest("hex");
    const expiredAt = new Date(Date.now() + 60 * 60 * 1000);
    await this.db.invite.update({
      where: { id: inviteId },
      data: { tokenHash: newHash, sentAt: new Date(), expiredAt },
    });

    const inviter = await this.db.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    const inviteUrl = `${process.env.APP_BASE_URL ?? "http://127.0.0.1:5180"}/?invite=${newToken}`;
    void this.email.sendInvite({
      to: existing.email,
      workspaceName: existing.workspace.name,
      inviteUrl,
      inviterName: inviter?.name ?? inviter?.email ?? undefined,
    });
    return { id: existing.id, email: existing.email, inviteUrl };
  }

  async cancelInvite(workspaceId: number, userId: number, inviteId: number) {
    await this.requireRole(workspaceId, userId, ["OWNER", "ADMIN"]);
    await this.db.invite.delete({ where: { id: inviteId } });
  }

  /** Look up an invite by token hash, public for acceptance flow. */
  async findInviteByTokenHash(tokenHash: string) {
    return this.db.invite.findUnique({
      where: { tokenHash },
      include: { workspace: true },
    });
  }

  /** Mark invite accepted and add the user as a member. */
  async acceptInvite(tokenHash: string, userId: number) {
    const invite = await this.findInviteByTokenHash(tokenHash);
    if (!invite || invite.acceptedAt)
      throw new ForbiddenException("Invite is invalid or already used");
    if (invite.expiredAt && invite.expiredAt.getTime() < Date.now())
      throw new ForbiddenException("Invite has expired");
    await this.db.$transaction([
      this.db.invite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      }),
      this.db.workspaceMember.upsert({
        where: {
          workspaceId_userId: { workspaceId: invite.workspaceId, userId },
        },
        create: { workspaceId: invite.workspaceId, userId, role: invite.role },
        update: { role: invite.role },
      }),
    ]);
    return invite;
  }

  private async requireMembership(workspaceId: number, userId: number) {
    const m = await this.db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!m) throw new ForbiddenException("Not a member of this workspace");
    return m;
  }

  private async requireRole(
    workspaceId: number,
    userId: number,
    roles: WorkspaceRole[],
  ) {
    const m = await this.requireMembership(workspaceId, userId);
    if (!roles.includes(m.role))
      throw new ForbiddenException("Insufficient permissions");
    return m;
  }

  private toSummary(
    ws: {
      id: number;
      slug: string;
      name: string;
      domain: string | null;
      env: string;
      plan: string;
      swatch: string | null;
      retentionDays: number;
      samplingRate: number;
      createdAt: Date;
    },
    role: string,
    memberCount?: number,
  ) {
    return {
      id: ws.id,
      slug: ws.slug,
      name: ws.name,
      domain: ws.domain,
      env: ws.env,
      plan: ws.plan,
      swatch: ws.swatch,
      retentionDays: ws.retentionDays,
      samplingRate: ws.samplingRate,
      role,
      memberCount,
      createdAt: ws.createdAt.toISOString(),
    };
  }
}
