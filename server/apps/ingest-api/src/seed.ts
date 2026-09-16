/**
 * Idempotent dev seed.
 * Creates:
 *  - admin@local user (password: admin)
 *  - "Loop, Inc." workspace owned by admin@local
 *  - one Public API key for the workspace (printed once)
 *  - 3 demo end-users + 4 demo sessions with realistic counters
 *  - Seeds workspace_id-aware projection rows in ClickHouse
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { createHash, randomBytes } from "crypto";
import {
  getPostgresClient,
  disconnectPostgres,
  ApiKeyScope,
  CohortKind,
  PlaylistKind,
  WorkspaceRole,
  WorkspaceEnv,
  WorkspacePlan,
} from "@replay/db-postgres";
import { hashPassword } from "./auth/password";

loadEnv();
loadEnv({ path: ".env.local", override: true });

async function main() {
  const db = getPostgresClient();
  const email = "admin@local";

  const passwordHash = hashPassword("admin");
  const user = await db.user.upsert({
    where: { email },
    create: {
      email,
      name: "Admin",
      initials: "AD",
      passwordHash,
      emailVerifiedAt: new Date(),
    },
    update: { passwordHash, emailVerifiedAt: new Date() },
  });

  const workspace = await db.workspace.upsert({
    where: { slug: "loop" },
    create: {
      slug: "loop",
      name: "Loop, Inc.",
      domain: "loop.dev",
      env: WorkspaceEnv.PRODUCTION,
      plan: WorkspacePlan.PRO,
      swatch: "#2c2f7c",
    },
    update: {},
  });

  await db.workspaceMember.upsert({
    where: {
      workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
    },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      role: WorkspaceRole.OWNER,
    },
    update: { role: WorkspaceRole.OWNER },
  });

  // ensure at least one API key exists; print the raw value the first time we make one
  const existingKeys = await db.apiKey.count({
    where: { workspaceId: workspace.id },
  });
  let revealedKey: string | undefined;
  if (existingKeys === 0) {
    const tail = randomBytes(18).toString("hex");
    revealedKey = `rpl_pk_${tail}`;
    await db.apiKey.create({
      data: {
        workspaceId: workspace.id,
        name: "Production",
        scope: ApiKeyScope.PUBLIC,
        prefix: `rpl_pk_${tail.slice(0, 6)}`,
        keyHash: createHash("sha256").update(revealedKey).digest("hex"),
        envs: ["prod"],
        createdById: user.id,
      },
    });
  }

  // 3 demo end-users
  const demoUsers = [
    {
      distinctId: "u_maya",
      email: "maya.kowalski@loop.dev",
      name: "Maya Kowalski",
      initials: "MK",
      plan: "Pro",
      browser: "Chrome",
      os: "macOS",
      device: "Desktop",
      city: "Berlin",
      country: "DE",
      flag: "🇩🇪",
      isOnline: true,
    },
    {
      distinctId: "u_theo",
      email: "theo.lindqvist@loop.dev",
      name: "Theo Lindqvist",
      initials: "TL",
      plan: "Team",
      browser: "Safari",
      os: "macOS",
      device: "Desktop",
      city: "Stockholm",
      country: "SE",
      flag: "🇸🇪",
      isOnline: false,
    },
    {
      distinctId: "u_priya",
      email: "priya.mehta@loop.dev",
      name: "Priya Mehta",
      initials: "PM",
      plan: "Enterprise",
      browser: "Firefox",
      os: "Linux",
      device: "Desktop",
      city: "Mumbai",
      country: "IN",
      flag: "🇮🇳",
      isOnline: true,
    },
  ];
  const upsertedUsers = [];
  for (const u of demoUsers) {
    upsertedUsers.push(
      await db.endUser.upsert({
        where: {
          workspaceId_distinctId: {
            workspaceId: workspace.id,
            distinctId: u.distinctId,
          },
        },
        create: { ...u, workspaceId: workspace.id, lastSeenAt: new Date() },
        update: { isOnline: u.isOnline, lastSeenAt: new Date() },
      }),
    );
  }

  // 4 demo sessions if there are none
  const sessionCount = await db.session.count({
    where: { workspaceId: workspace.id },
  });
  if (sessionCount === 0) {
    const baseTime = Date.now();
    const seeds = [
      {
        user: upsertedUsers[0],
        minsAgo: 47,
        durationMs: 312_000,
        pageCount: 6,
        clickCount: 41,
        rageCount: 3,
        errorCount: 2,
        deadCount: 1,
        startUrl: "/product/aurora-lamp",
      },
      {
        user: upsertedUsers[1],
        minsAgo: 88,
        durationMs: 92_000,
        pageCount: 2,
        clickCount: 12,
        rageCount: 0,
        errorCount: 0,
        deadCount: 0,
        startUrl: "/",
      },
      {
        user: upsertedUsers[2],
        minsAgo: 23,
        durationMs: 482_000,
        pageCount: 9,
        clickCount: 67,
        rageCount: 1,
        errorCount: 5,
        deadCount: 0,
        startUrl: "/checkout",
      },
      {
        user: upsertedUsers[0],
        minsAgo: 5,
        durationMs: 24_000,
        pageCount: 1,
        clickCount: 3,
        rageCount: 0,
        errorCount: 0,
        deadCount: 0,
        startUrl: "/dashboard",
      },
    ];
    for (const s of seeds) {
      const startedAt = new Date(baseTime - s.minsAgo * 60_000);
      const endedAt = new Date(startedAt.getTime() + s.durationMs);
      const publicId = `ses_${randomBytes(4).toString("hex")}`;
      const session = await db.session.create({
        data: {
          publicId,
          workspaceId: workspace.id,
          endUserId: s.user.id,
          status: s.minsAgo < 5 ? "LIVE" : "COMPLETED",
          startedAt,
          endedAt,
          durationMs: s.durationMs,
          pageCount: s.pageCount,
          clickCount: s.clickCount,
          rageCount: s.rageCount,
          deadCount: s.deadCount,
          errorCount: s.errorCount,
          startUrl: s.startUrl,
          platform: "web",
          sdkName: "@replay/web-sdk",
          sdkVersion: "0.1.0",
        },
      });
      await db.sessionPath.create({
        data: { sessionId: session.id, sequence: 0, url: s.startUrl },
      });
    }
  }

  // a sample playlist and cohort
  await db.playlist.upsert({
    where: { id: 1 },
    create: {
      workspaceId: workspace.id,
      ownerId: user.id,
      title: "Checkout failures this week",
      description: "Auto-updated · errors in last 7d",
      pinned: true,
      kind: PlaylistKind.AUTO,
      filter: { errorCount: { gt: 0 } },
    },
    update: {},
  });
  await db.cohort.upsert({
    where: { id: 1 },
    create: {
      workspaceId: workspace.id,
      ownerId: user.id,
      name: "Power users (Pro)",
      description: "Pro plan · ≥10 sessions · last seen ≤7d",
      kind: CohortKind.AUTO,
      filter: { plan: "Pro" },
      membersCount: 1,
    },
    update: {},
  });

  process.stdout.write("\nSeed complete.\n");
  process.stdout.write(
    'Login:  POST /v1/auth/login   { email: "admin@local", password: "admin" }\n',
  );
  if (revealedKey) {
    process.stdout.write(`Raw API key (shown once): ${revealedKey}\n`);
  } else {
    process.stdout.write(
      "(API keys already exist — issue a new one through the dashboard if you need the raw value.)\n",
    );
  }
  await disconnectPostgres();
}

main().catch(async (e) => {
  process.stderr.write(
    `Seed failed: ${e instanceof Error ? e.stack : String(e)}\n`,
  );
  await disconnectPostgres();
  process.exit(1);
});
