import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import {
  getPostgresClient,
  type ApiKeyScope,
  type Prisma,
} from "@replay/db-postgres";
import { decodeCursor, paginateRows, parseLimit } from "../common/cursor";
import { paginated } from "../common/api-response";
import { ApiKeyCache } from "./api-keys.cache";

const PREFIX: Record<ApiKeyScope, string> = {
  PUBLIC: "rpl_pk_",
  SERVER: "rpl_sk_",
  WEBHOOK: "whsec_",
};

export interface CreateApiKeyBody {
  name: string;
  scope: ApiKeyScope;
  envs?: string[];
}

@Injectable()
export class ApiKeysService {
  private readonly db = getPostgresClient();

  constructor(private readonly cache: ApiKeyCache) {}

  async list(
    workspaceId: number,
    opts: { cursor?: string; limit?: string; scope?: ApiKeyScope },
  ) {
    const take = parseLimit(opts.limit, 25, 100);
    const cursorId = decodeCursor(opts.cursor);
    const where: Prisma.ApiKeyWhereInput = { workspaceId };
    if (opts.scope) where.scope = opts.scope;
    const rows = await this.db.apiKey.findMany({
      where:
        cursorId !== undefined ? { ...where, id: { lt: cursorId } } : where,
      orderBy: { id: "desc" },
      take: take + 1,
    });
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);
    return paginated(
      items.map((k) => this.toSummary(k)),
      nextCursor,
    );
  }

  async create(workspaceId: number, userId: number, body: CreateApiKeyBody) {
    const minted = this.mintSecret(body.scope);
    const row = await this.db.apiKey.create({
      data: {
        workspaceId,
        name: body.name,
        scope: body.scope,
        prefix: minted.prefix,
        keyHash: minted.keyHash,
        // Persist the raw key ONLY for a publishable (PUBLIC) key so the Install
        // page can re-reveal it. SERVER/WEBHOOK stay null → shown-once at mint.
        publicKey: body.scope === "PUBLIC" ? minted.rawKey : null,
        envs: body.envs ?? [],
        createdById: userId,
      },
    });
    await this.cache.set(minted.keyHash, {
      workspaceId,
      scope: row.scope,
      keyId: row.id,
    });
    return { ...this.toSummary(row), rawKey: minted.rawKey };
  }

  /**
   * Idempotent bootstrap of the workspace's default PUBLIC SDK key — the one
   * the onboarding Install step puts in the snippet.
   *
   * Onboarding used to do this client-side as list-then-create, which is a
   * read-then-write race with nothing holding it closed: React 18 StrictMode
   * fires the effect twice, both passes saw an empty list, and both POSTed — so
   * a brand-new workspace ended up with two "Production" keys. Two tabs, or a
   * refresh mid-request, reproduce it in production too.
   *
   * The advisory lock is what actually makes this safe: it is transaction-scoped
   * and keyed on the workspace, so concurrent callers serialise per workspace
   * (never globally) and the loser's SELECT runs after the winner's INSERT is
   * visible, returning the same key instead of minting a second one. No schema
   * change and no unique constraint needed.
   *
   * `rawKey` is the full publishable key, returned BOTH when this call mints the
   * key and on repeat calls (sourced from the stored `publicKey` column) — so the
   * Install snippet always gets a WORKING key. The 6-char `prefix` is a display
   * label, NOT a valid ingest credential; never embed it in an SDK.
   */
  async bootstrapPublicKey(workspaceId: number, userId: number) {
    return this.db.$transaction(async (tx) => {
      // Access pattern: single-row advisory lock + one indexed lookup on
      // (workspaceId, scope). Both are O(1) per call and the lock is held only
      // for the length of this tiny transaction, so it does not serialise
      // anything beyond concurrent bootstraps of the SAME workspace.
      // ::int is required, not cosmetic — Prisma binds a JS number as bigint, and
      // pg_advisory_xact_lock has (bigint) and (int, int) overloads but no
      // (int, bigint), so the unqualified form fails to resolve at runtime.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('api-key-bootstrap'), ${workspaceId}::int)`;
      const existing = await tx.apiKey.findFirst({
        where: { workspaceId, scope: "PUBLIC", revokedAt: null },
        orderBy: { id: "asc" },
      });
      // Return the STORED publishable key so a repeat bootstrap (StrictMode, a
      // second tab, a refresh) still hands back a working key. Rows minted before
      // the publicKey column existed have it null — the raw key can't be recovered
      // from the hash, so those reveal only after a rotate.
      if (existing)
        return {
          ...this.toSummary(existing),
          rawKey: existing.publicKey ?? undefined,
        };

      const minted = this.mintSecret("PUBLIC");
      const row = await tx.apiKey.create({
        data: {
          workspaceId,
          name: "Production",
          scope: "PUBLIC",
          prefix: minted.prefix,
          keyHash: minted.keyHash,
          publicKey: minted.rawKey,
          envs: [],
          createdById: userId,
        },
      });
      await this.cache.set(minted.keyHash, {
        workspaceId,
        scope: row.scope,
        keyId: row.id,
      });
      return { ...this.toSummary(row), rawKey: minted.rawKey };
    });
  }

  /**
   * The workspace's publishable (rpl_pk_) key for the Install snippet. Read-only
   * and MEMBER-visible: a PUBLIC key ships in client app code, so revealing it
   * adds no secrecy risk — unlike SERVER/WEBHOOK keys, which are never returned
   * here and stay shown-once at creation.
   *
   * Access pattern: at most two indexed `findFirst` on (workspaceId) — a workspace
   * holds only a handful of keys, so the scope/publicKey filters scan nothing on
   * top of @@index([workspaceId]). Not a hot path (called on Install-page load).
   *
   * Prefer a key we can actually REVEAL (publicKey stored), newest first — so a
   * freshly generated or rotated PUBLIC key immediately powers the Install snippet
   * without the caller having to rotate the single oldest key. Fall back to the
   * oldest PUBLIC key with `publicKey: null` only to report its prefix when a
   * workspace has legacy keys, none of them revealable yet (the raw value can't be
   * recovered from the hash). Returns null when there is no PUBLIC key at all.
   */
  async getPublicKey(workspaceId: number) {
    const revealable = await this.db.apiKey.findFirst({
      where: {
        workspaceId,
        scope: "PUBLIC",
        revokedAt: null,
        publicKey: { not: null },
      },
      orderBy: { id: "desc" },
    });
    if (revealable)
      return { ...this.toSummary(revealable), publicKey: revealable.publicKey };
    const legacy = await this.db.apiKey.findFirst({
      where: { workspaceId, scope: "PUBLIC", revokedAt: null },
      orderBy: { id: "asc" },
    });
    return legacy ? { ...this.toSummary(legacy), publicKey: null } : null;
  }

  async revoke(workspaceId: number, id: number) {
    const existing = await this.db.apiKey.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException("API key not found");
    await this.db.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    await this.cache.invalidate(existing.keyHash);
    return { id, revoked: true };
  }

  // Rotation swaps the secret on the SAME row: callers keep the key's id, name
  // and grants, and only the credential changes. The old secret dies the moment
  // the new hash overwrites it — there is no grace period.
  async rotate(workspaceId: number, id: number) {
    const existing = await this.db.apiKey.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException("API key not found");
    // Revoking is permanent by contract, so refuse rather than mint a secret
    // that lookup() would reject anyway for a row whose revokedAt is set.
    if (existing.revokedAt)
      throw new ConflictException("Cannot rotate a revoked API key");
    const minted = this.mintSecret(existing.scope);
    const row = await this.db.apiKey.update({
      where: { id },
      data: {
        prefix: minted.prefix,
        keyHash: minted.keyHash,
        // Keep the stored publishable copy in step with the rotated secret (PUBLIC
        // only); non-PUBLIC keys never store their raw value, so this stays null.
        publicKey: existing.scope === "PUBLIC" ? minted.rawKey : null,
        rotatedAt: new Date(),
        // lastUsedAt described the secret we just destroyed; carrying it over
        // would report the new secret as used before it has ever authenticated.
        lastUsedAt: null,
      },
    });
    await this.cache.invalidate(existing.keyHash);
    await this.cache.set(minted.keyHash, {
      workspaceId,
      scope: row.scope,
      keyId: row.id,
    });
    return { ...this.toSummary(row), rawKey: minted.rawKey };
  }

  private mintSecret(scope: ApiKeyScope) {
    const prefix = PREFIX[scope] ?? PREFIX.PUBLIC;
    const tail = randomBytes(18).toString("hex");
    const rawKey = `${prefix}${tail}`;
    return {
      rawKey,
      keyHash: createHash("sha256").update(rawKey).digest("hex"),
      prefix: `${prefix}${tail.slice(0, 6)}`,
    };
  }

  private toSummary = (k: Prisma.ApiKeyGetPayload<{}>) => ({
    id: k.id,
    name: k.name,
    scope: k.scope,
    prefix: k.prefix,
    envs: k.envs,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    rotatedAt: k.rotatedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  });
}
