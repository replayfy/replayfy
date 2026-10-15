import { Injectable } from "@nestjs/common";
import {
  getPostgresClient,
  Prisma,
  type Session,
  type SessionStatus,
} from "@replay/db-postgres";
import { getMongoClient } from "@replay/db-mongo";
import {
  ensureClickHouseSchema,
  insertProjectionRows,
  type ProjectionRow,
} from "@replay/db-clickhouse";
import type {
  ConsoleEventData,
  CustomEventData,
  ErrorEventData,
  NavigationEventData,
  NetworkEventData,
  PerformanceEventData,
  ReplayBatchEnvelope,
  ReplayEvent,
  TapEventData,
} from "@replay/replay-schema";
import { PlaylistsService } from "../playlists/playlists.service";
import { CohortsService } from "../cohorts/cohorts.service";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";
import { WorkspacePerfDailyService } from "../workspace-perf-daily/workspace-perf-daily.service";
import { SignalsService } from "../signals/signals.service";
import type { ReplayBatchJob } from "../queue/queue.types";
import { redactBody, redactHeaders, isHostAllowed } from "./redactor";
import { resolveGeo } from "./geo";
import { webDeviceFacts } from "../common/device-facts";
import { mergeSessionCustomProps } from "../common/session-props";
import { INT4_MAX, toInt4, toSafeInt } from "../common/int4";
import { truncateWellFormed, wellFormed } from "../common/well-formed";
import { workspaceScopedSessionId } from "../common/session-id";

const LIVE_THRESHOLD_MS = 30_000;

/** What persist() did: stored the batch, or skipped a resend of a batch that
 *  was already fully persisted. */
export type PersistOutcome = "persisted" | "duplicate";

@Injectable()
export class ReplayPersistenceService {
  private readonly db = getPostgresClient();
  private readonly mongo = getMongoClient();
  private schemaReady: Promise<void> | null = null;

  constructor(
    private readonly playlists: PlaylistsService,
    private readonly cohorts: CohortsService,
    private readonly stats: WorkspaceStatsService,
    private readonly perfDaily: WorkspacePerfDailyService,
    private readonly signals: SignalsService,
  ) {}

  /**
   * Persist one replay batch. Returns "duplicate" (and writes nothing) when a
   * batch with the same (workspace, session, segment, sequence) key was already
   * fully persisted — see priorDelivery.
   */
  async persist(job: ReplayBatchJob): Promise<PersistOutcome> {
    const { workspaceId, envelope, identify, ip, fingerprint, geoCountry } = job;

    if (!this.schemaReady) {
      this.schemaReady = ensureClickHouseSchema().catch((e) => {
        process.stderr.write(
          `ClickHouse schema init failed: ${(e as Error).message}\n`,
        );
      });
    }

    // Resolve the Session row FIRST: the Mongo batch, the Session row and the
    // ClickHouse rows must all use the id THIS workspace owns (see
    // resolveSessionTarget) — never another workspace's session. In parallel,
    // and before ANY side effect: was this exact batch already fully persisted?
    // That lookup assumes the raw id, which the session is stored under unless
    // another workspace owns it; only then does it need a second lookup.
    const [target, priorUnderRawId] = await Promise.all([
      this.resolveSessionTarget(workspaceId, envelope.sessionId),
      this.priorDelivery(workspaceId, envelope.sessionId, envelope),
    ]);
    const prior =
      target.publicId === envelope.sessionId
        ? priorUnderRawId
        : await this.priorDelivery(workspaceId, target.publicId, envelope);
    if (prior?.persistedAt) {
      // First write wins. With segment-keyed batches the same key only comes
      // back as a RESEND of the same batch (pagehide re-delivery, failed-batch
      // retry, next-page outbox, mobile retries), whose events are already in
      // the replay and counted. Skipping it saves rewriting its blob and every
      // other write (and keeps an earlier page's resend out of the session's
      // page list, see upsertPaths). Replacing only the Mongo copy would leave
      // the replay out of step with the counts and ClickHouse rows of the first
      // copy, which are never added twice (applyBatchCounts). A same-key batch
      // with different events means a broken SDK: logged, not applied.
      if (prior.eventCount !== envelope.events.length) {
        process.stderr.write(
          `replay batch ${workspaceId}:${target.publicId}:${envelope.segmentId}:${envelope.sequence} ` +
            `re-sent with ${envelope.events.length} events (stored: ${prior.eventCount}); kept the stored copy\n`,
        );
      }
      return "duplicate";
    }
    const startedAt = envelope.events[0]?.ts ?? envelope.sentAt;
    const endedAt =
      envelope.events[envelope.events.length - 1]?.ts ?? envelope.sentAt;

    // The rrweb blob (Mongo) is independent of the Postgres FK chain, so start
    // it concurrently with endUser→session instead of blocking on it first.
    const mongoP = this.writeMongoBatch(
      envelope,
      target.publicId,
      startedAt,
      endedAt,
      workspaceId,
      prior?.id ?? null,
    );
    // Attach a no-op rejection handler AT CREATION so a Mongo failure during the
    // endUser/session awaits below (or before pgTail reaches `await mongoP`)
    // can't surface as an UNHANDLED rejection — Node's default policy would
    // crash the whole worker over one transient Mongo hiccup. The real
    // `await mongoP` inside pgTail still observes + propagates the error, so the
    // job rejects for a clean single-job BullMQ retry.
    void mongoP.catch(() => undefined);
    const endUserId = await this.upsertEndUser(
      envelope,
      workspaceId,
      identify,
      ip,
      fingerprint,
      geoCountry,
    );
    // A REAL identity is one identify() actually carried (distinctId or email) —
    // NOT the fingerprint/anon fallback upsertEndUser resolves otherwise. Gates
    // the anonymous→identified stitching below so it fires only on a genuine
    // identify(), never on ordinary anonymous traffic.
    const hasRealIdentity = !!(
      identify?.distinctId?.trim() || identify?.email?.trim()
    );
    const sessionRow = await this.upsertSession({
      workspaceId,
      rawSessionId: envelope.sessionId,
      sessionPublicId: target.publicId,
      existing: target.existing,
      endUserId,
      envelope,
      startedAt,
      endedAt,
      fingerprint,
      ip,
      geoCountry,
      hasRealIdentity,
    });
    // `finalize` = this batch flipped the session to COMPLETED. The projection
    // stays on the fast BATCHED path even for finalize: a per-finalize
    // synchronous wait-for-flush insert would turn a worker that has fallen
    // behind (sessions aging into COMPLETED before they're processed) into a
    // self-amplifying finalize storm. The responsive derive below reads CH
    // best-effort instead — the session's earlier events are already queryable
    // and only its last ~1s batch may lag; the nightly backfill reconciles.
    const finalize = sessionRow.status === "COMPLETED";
    // The ClickHouse projection hits a different store, so start it now and run
    // it CONCURRENTLY with the Postgres tail. Whether the job WAITS for it is
    // gated below on the insert-batcher flag — see the await at the end.
    //
    // Only the attempt that applied this batch's counts to the Session
    // (sessionRow.applied, see applyBatchCounts) projects its events, and it
    // starts them here, before any later write can fail: a Bull retry of a
    // batch whose counts an earlier attempt already applied must not insert
    // its ClickHouse rows a second time (session_events is a plain MergeTree,
    // so duplicates are never merged away).
    const chProjection = sessionRow.applied
      ? this.projectToClickhouse(
          workspaceId,
          sessionRow.id,
          sessionRow.publicId,
          envelope,
        )
      : Promise.resolve();
    // Observed below (logged or awaited); this only keeps a rejection while
    // the awaits in between run from being UNHANDLED (see mongoP above).
    void chProjection.catch(() => undefined);
    // When THIS batch is the one that first associates a real identity with the
    // session (the first identified batch, or the anon→identified flip
    // mid-session), retroactively claim the user's EARLIER anonymous sessions on
    // the same device. upsertSession returns the flag so the reassignment runs
    // ONCE per session — not on every steady-state batch. Web (unlike mobile)
    // had already pinned anonymous sessions to a fingerprint-keyed "ghost"
    // EndUser, so this also retires that ghost. See claimAnonymousSessionsOnIdentify.
    if (sessionRow.claimAnonymous && fingerprint && endUserId != null) {
      await this.claimAnonymousSessionsOnIdentify(
        workspaceId,
        fingerprint,
        endUserId,
      );
    }
    // The Postgres tail IS always awaited — it holds the authoritative session
    // records. It keeps the two same-Session-row UPDATEs (customProps +
    // pageCount) serial (avoids row-lock contention / lost updates) and joins
    // the Mongo write before the segment, which references its mongoBatchId. A
    // failure here rejects the job for a retry — the durable-store contract is
    // unchanged.
    const pgTail = (async () => {
      // Snapshot identify()'s custom traits onto THIS session (not just the
      // last-write-wins EndUser blob) so the player's Properties tab shows the
      // values set during this specific session. `customProps` already excludes
      // the promoted plan/email/name fields. See common/session-props.ts.
      if (identify?.customProps) {
        await mergeSessionCustomProps(
          this.db,
          workspaceId,
          sessionRow.id,
          identify.customProps as Record<string, unknown>,
        );
      }
      await this.upsertPaths(workspaceId, sessionRow.id, envelope);
      const mongoBatchId = await mongoP;
      // A create race with another workspace over the same raw id moved this
      // session to its workspace-scoped id after the Mongo write had started
      // under the raw one: re-file the batch so the player (which reads by the
      // session's publicId) finds it. Only on that race; a point update by _id
      // (select: Prisma would otherwise read the whole events blob back).
      if (sessionRow.publicId !== target.publicId) {
        await this.mongo.replayBatch.update({
          where: { id: mongoBatchId },
          data: { sessionId: sessionRow.publicId },
          select: { id: true },
        });
      }
      await this.upsertSegment(
        sessionRow.id,
        envelope,
        startedAt,
        endedAt,
        mongoBatchId,
      );
      return mongoBatchId;
    })();

    // CH-completion policy, gated on the app-level insert batcher:
    //  - Batcher ON (default): the projection is best-effort by contract — its
    //    insert errors are swallowed, Mongo holds the durable rrweb copy, and
    //    the nightly backfill re-derives CH. Awaiting it never triggered a retry
    //    (it can't reject), it only pinned every job to the batch-flush window
    //    (~200ms), which would cap worker drain at concurrency/window. So we let
    //    the job complete on the authoritative Postgres+Mongo writes and let the
    //    projection rows coalesce + flush in the background (guarded so a build-
    //    phase throw can't become an unhandled rejection).
    //  - Batcher OFF (CLICKHOUSE_BATCH_INSERT=0): CH is awaited alongside the
    //    tail so the job doesn't complete until the insert has run. A failed
    //    insert still fails the job, but its retry does not insert the rows
    //    again (the counts were applied, see chProjection above): they are lost
    //    rather than risked twice.
    let mongoBatchId: string;
    if ((process.env.CLICKHOUSE_BATCH_INSERT ?? "1") === "1") {
      void chProjection.catch((e) => {
        process.stderr.write(
          `ch projection failed for session ${sessionRow.id}: ${(e as Error).message}\n`,
        );
      });
      mongoBatchId = await pgTail;
    } else {
      [, mongoBatchId] = await Promise.all([chProjection, pgTail]);
    }

    // Every awaited write succeeded: only now record the batch as persisted, so
    // a later delivery of it stops at priorDelivery above. A failure anywhere
    // above rejected the job before this line, and Bull's retry runs the batch
    // again: the Mongo copy and segment row are rewritten in place, a page the
    // first attempt already recorded is not recorded again (upsertPaths), and
    // the counts and ClickHouse rows are not applied twice (applyBatchCounts).
    // (upsertPaths dedupes against the session's LATEST page only: an
    // unmarked delivery of an earlier page's batch that arrives after the
    // session moved on, i.e. a resend of a batch stored before this marker
    // existed or whose marker write failed, records that page once more.)
    // Set BEFORE the fire-and-forget follow-ups below, so a resend never
    // re-runs the perf-daily bump either.
    await this.markBatchPersisted(mongoBatchId);

    // AUTO cohort membership is now maintained WITHOUT an inline per-session
    // eval: upsertEndUser marks the user "dirty" (O(1) Redis SADD) only when a
    // static attribute actually changed, and a 15s drainer applies the deltas
    // — so there's no per-session cohort storm here anymore (that's what used to
    // collapse worker drain ~900/s→~20/s), and it needs no INGEST_RESPONSIVE_EVAL
    // gate. Behavioral/activity cohorts are refreshed by the slower cohort cron.
    //
    // Responsive AUTO playlist evaluation stays inline (gated): if this session
    // now matches an auto-updated playlist's filter, add it immediately instead
    // of waiting for the sweep. INGEST_RESPONSIVE_EVAL=0 defers it on a
    // high-throughput node. Best-effort — the cron catches any miss.
    if (process.env.INGEST_RESPONSIVE_EVAL !== "0") {
      this.playlists
        .evaluateForSession(workspaceId, sessionRow.id)
        .catch((e) => {
          process.stderr.write(
            `playlist eval failed for session ${sessionRow.id}: ${(e as Error).message}\n`,
          );
        });
    }

    // Web-vitals rollup bump. Best-effort — if the upsert fails the
    // nightly reconcile recomputes the row from authoritative session
    // data, so a missed bump never produces wrong-forever numbers on
    // the dashboard.
    if (sessionRow.worstLcp != null && sessionRow.worstLcp > 0) {
      this.perfDaily
        .bumpForSession({
          workspaceId,
          startedAt: sessionRow.startedAt,
          worstLcp: sessionRow.worstLcp,
          worstClsX1000: sessionRow.worstClsX1000,
          worstFid: sessionRow.worstFid,
          longTaskTotalMs: sessionRow.longTaskTotalMs,
        })
        .catch((e) => {
          process.stderr.write(
            `perf-daily bump failed for session ${sessionRow.id}: ${(e as Error).message}\n`,
          );
        });
    }

    // Responsive Overview-signal derivation for a just-finalized session —
    // gated on the SAME responsive-eval switch as the cohort/playlist evaluation
    // above (it is per-session, best-effort, and the nightly backfill re-derives
    // everything). A high-throughput worker node sets INGEST_RESPONSIVE_EVAL=0
    // to defer the whole finalize fan-out — this derive pulls in the signal-daily
    // reconcile + session-cards — which also stops a fallen-behind worker from
    // entering a finalize storm. It reads CH best-effort (see the projection
    // note above); the backfill fills any last-batch lag. (Sessions flipped to
    // COMPLETED out-of-band by the retention sweep skip this hook and are covered
    // by that same backfill.)
    if (finalize && process.env.INGEST_RESPONSIVE_EVAL !== "0") {
      void this.signals.deriveForSession(sessionRow.id).catch(() => undefined);
    }
    return "persisted";
  }

  /**
   * An earlier delivery of THIS batch, if one was stored. The key is the
   * [projectId, sessionId, sequence, segmentId] unique index:
   *  - projectId (= this workspace): a colliding sessionId from ANOTHER
   *    workspace can never be found (and overwritten or skipped) here.
   *  - segmentId: a reload or same-tab navigation resumes the session id in a
   *    new segment whose sequence restarts at 1. Without it, the new page
   *    load's batch N matched the previous load's batch N (its snapshot and
   *    events overwritten in the replay).
   *
   * Why the dedupe marker lives on this Mongo document (persistedAt) and not in
   * Redis: the Mongo write already looked this key up on every batch (the
   * lookup moved here, it was not added), so reading the marker costs no extra
   * query and setting it one single-op update (markBatchPersisted); the field
   * is a few bytes on a document that exists anyway, and it lasts exactly as
   * long as the batch. A Redis key per batch would sit in the queue's Redis,
   * which runs noeviction: roughly 170 bytes for every batch of the last N
   * days, growing with traffic, and a resend arriving after the TTL (a
   * next-page outbox flushed days later) would still be counted twice.
   *
   * The marker is the cheap early exit for a COMPLETE batch. It is not what
   * keeps the counts single: a batch whose earlier attempt failed part-way is
   * unmarked and runs again, and applyBatchCounts makes that rerun add nothing
   * the earlier attempt already added.
   *
   * Access pattern: one point read on that unique index, narrowed to three
   * small fields (the old lookup fetched the whole events blob), so it is O(1)
   * per batch at any collection size. A second read only when the session is
   * stored under its workspace-scoped id.
   */
  private async priorDelivery(
    workspaceId: number,
    sessionPublicId: string,
    envelope: ReplayBatchEnvelope,
  ): Promise<{ id: string; persistedAt: Date | null; eventCount: number } | null> {
    return this.mongo.replayBatch.findFirst({
      where: {
        projectId: String(workspaceId),
        sessionId: sessionPublicId,
        sequence: envelope.sequence,
        segmentId: envelope.segmentId,
      },
      select: { id: true, persistedAt: true, eventCount: true },
    });
  }

  /**
   * Record that every side effect of this batch succeeded (see priorDelivery).
   *
   * Access pattern: ONE Mongo update command, a point match on _id, run on
   * every persisted batch. A raw command because the Prisma calls cost more on
   * this hot path: `replayBatch.update` issues three operations (an aggregate
   * to find the id, the update, then an aggregate that reads the WHOLE
   * document back, events blob included), and `updateMany` two.
   *
   * Best-effort on purpose: failing the job here would make Bull re-run a
   * batch that is already complete (wasted work, nothing counted twice).
   * Logging it instead leaves the batch unmarked, so a later resend runs again
   * and applyBatchCounts adds nothing.
   */
  private async markBatchPersisted(mongoBatchId: string): Promise<void> {
    try {
      await this.mongo.$runCommandRaw({
        update: "ReplayBatch",
        updates: [
          {
            q: { _id: { $oid: mongoBatchId } },
            u: { $set: { persistedAt: { $date: new Date().toISOString() } } },
          },
        ],
      });
    } catch (e) {
      process.stderr.write(
        `could not mark replay batch ${mongoBatchId} persisted: ${(e as Error).message}\n`,
      );
    }
  }

  private async writeMongoBatch(
    envelope: ReplayBatchEnvelope,
    sessionPublicId: string,
    startedAt: number,
    endedAt: number,
    workspaceId: number,
    /** An earlier, not yet fully persisted delivery of this batch (a Bull
     *  retry after a partial failure): updated in place, never duplicated. */
    existingId: string | null,
  ) {
    // Both writes select only the id: without it Prisma reads the whole
    // document back, events blob included, just to return it.
    if (existingId) {
      const updated = await this.mongo.replayBatch.update({
        where: { id: existingId },
        data: {
          events: envelope.events as unknown as object,
          sentAt: BigInt(envelope.sentAt),
          startedAt: BigInt(startedAt),
          endedAt: BigInt(endedAt),
          eventCount: envelope.events.length,
          sdk: envelope.sdk as unknown as object,
          page: envelope.page as unknown as object,
          projectId: String(workspaceId),
        },
        select: { id: true },
      });
      return updated.id;
    }
    const created = await this.mongo.replayBatch.create({
      data: {
        projectId: String(workspaceId),
        sessionId: sessionPublicId,
        segmentId: envelope.segmentId,
        sequence: envelope.sequence,
        sentAt: BigInt(envelope.sentAt),
        startedAt: BigInt(startedAt),
        endedAt: BigInt(endedAt),
        eventCount: envelope.events.length,
        sdk: envelope.sdk as unknown as object,
        page: envelope.page as unknown as object,
        events: envelope.events as unknown as object,
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Resolve which EndUser row owns this batch.
   *
   * Resolution rules:
   *  1. If identify() ran with a distinctId, that's the user. We tag the row
   *     with the fingerprint so subsequent anonymous sessions on the same browser
   *     don't get re-bucketed.
   *  2. Else if identify() ran with email only, use email as the distinctId.
   *  3. Else use the fingerprint. Many sessions on the same browser collapse
   *     into the same EndUser.
   *  4. Hard fallback: the session id (kept as `anon_…`) — used only if neither
   *     identify() nor fingerprint were provided.
   *
   * Same browser, different email = different EndUser by design.
   */
  /** Accept a value as an avatar URL only when it's a plain http/https string of
   *  sane length — mirrors the reference user model, which URL-validates its
   *  avatar. Anything else (numbers, objects, data:/javascript: URIs, absurdly
   *  long strings) returns undefined so it never lands in an <img src>. */
  private validPictureUrl(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    const s = v.trim();
    if (s.length < 8 || s.length > 2048) return undefined;
    return /^https?:\/\/\S+$/i.test(s) ? s : undefined;
  }

  private async upsertEndUser(
    envelope: ReplayBatchEnvelope,
    workspaceId: number,
    identify: ReplayBatchJob["identify"],
    ip: string | undefined,
    fingerprint: string | undefined,
    geoCountry: string | undefined,
  ): Promise<number | null> {
    const distinctId =
      identify?.distinctId?.trim() ||
      identify?.email?.trim().toLowerCase() ||
      fingerprint ||
      `anon_${envelope.sessionId.slice(0, 16)}`;
    const ua = envelope.page.userAgent ?? "";
    const { browser, browserVersion, os, osVersion, device } = webDeviceFacts(
      ua,
      envelope.page.viewport?.width,
    );
    const viewport = `${envelope.page.viewport?.width ?? 0}x${envelope.page.viewport?.height ?? 0}`;
    const tz = (envelope.page as { timezone?: string }).timezone;
    const initials = identify?.name
      ? identify.name
          .split(" ")
          .map((p) => Array.from(p)[0] ?? "")
          .slice(0, 2)
          .join("")
          .toUpperCase()
      : undefined;

    const customProps = {
      ...(identify?.customProps as object | undefined),
      ...(fingerprint ? { fingerprint } : {}),
    };

    // Avatar URL — accept the discrete `picture`/`avatar` identify traits OR the
    // same keys nested in customProps (some SDK callers only carry a generic
    // props bag). URL-validated (http/https only) so a stray non-URL value can
    // never reach an <img src> in the dashboard.
    const cp = customProps as Record<string, unknown>;
    const picture = this.validPictureUrl(
      identify?.picture ?? identify?.avatar ?? cp.picture ?? cp.avatar,
    );

    // IP → city/country resolution via local geoip-lite database. Cheap, no
    // network call, accurate to ~city level for most public IPs. The edge
    // country (Cloudflare) overrides geoip's country/flag when they disagree.
    const geo = resolveGeo(ip, geoCountry);

    // Pre-check existence so we can bump `usersTotal` only on actual
    // first-time creation. Adds one cheap PK lookup per batch but keeps
    // the workspace counter accurate without depending on reconcile.
    const preExisting = await this.db.endUser.findUnique({
      where: { workspaceId_distinctId: { workspaceId, distinctId } },
      // Static cohort-relevant fields too, so we can mark the user dirty for
      // attribute-cohort re-eval ONLY when one of them actually changes.
      select: {
        id: true,
        plan: true,
        browser: true,
        os: true,
        device: true,
        country: true,
        city: true,
        email: true,
        name: true,
      },
    });

    const row = await this.db.endUser.upsert({
      where: { workspaceId_distinctId: { workspaceId, distinctId } },
      create: {
        workspaceId,
        distinctId,
        email: identify?.email,
        name: identify?.name,
        initials,
        plan: identify?.plan,
        picture,
        browser,
        browserVersion,
        os,
        osVersion,
        device,
        viewport,
        timezone: tz,
        city: geo.city,
        state: geo.state,
        country: geo.country,
        flag: geo.flag,
        ip,
        customProps,
        isOnline: true,
        lastSeenAt: new Date(),
      },
      update: {
        email: identify?.email ?? undefined,
        name: identify?.name ?? undefined,
        initials: initials ?? undefined,
        plan: identify?.plan ?? undefined,
        // Only overwrite when a fresh valid URL arrives (same ?? undefined rule
        // as the other identity fields), so a later batch without the trait
        // doesn't wipe an avatar the customer already set.
        picture: picture ?? undefined,
        browser,
        browserVersion: browserVersion ?? undefined,
        os,
        osVersion: osVersion ?? undefined,
        device,
        viewport,
        timezone: tz ?? undefined,
        city: geo.city ?? undefined,
        state: geo.state ?? undefined,
        country: geo.country ?? undefined,
        flag: geo.flag ?? undefined,
        ip: ip ?? undefined,
        customProps,
        isOnline: true,
        lastSeenAt: new Date(),
      },
    });
    if (!preExisting) {
      this.stats.bump(workspaceId, { usersTotal: 1 }).catch(() => {});
    }
    // Cohort dirty-marking — flag this user for attribute-cohort re-evaluation
    // ONLY when a STATIC attribute actually changed (or the user is new). This
    // is the whole reason the incremental drainer stays cheap: identify/attr
    // changes are rare, so the dirty set stays small — it is NOT re-marked on
    // every session. Activity/time cohorts (sessions_count/event/is_online/
    // last_seen) are handled by the periodic behavioral recompute, so they're
    // intentionally not considered here. O(1) Redis SADD, fire-and-forget.
    const staticChanged =
      !preExisting ||
      preExisting.browser !== browser ||
      preExisting.os !== os ||
      preExisting.device !== device ||
      // country/city are written with `?? undefined` above (a null geo result
      // does NOT overwrite a known location), so a comparison against
      // `geo.x ?? null` would flag "changed" on every IP-less/city-unresolvable
      // session and re-storm the dirty set. Guard with `!= null` to match the
      // don't-overwrite-on-null write semantics — same shape as plan/email/name.
      (geo.country != null && preExisting.country !== geo.country) ||
      (geo.city != null && preExisting.city !== geo.city) ||
      (identify?.plan != null && preExisting.plan !== identify.plan) ||
      (identify?.email != null && preExisting.email !== identify.email) ||
      (identify?.name != null && preExisting.name !== identify.name);
    if (staticChanged) {
      this.cohorts.markUsersDirty(workspaceId, [row.id]).catch(() => {});
    }
    return row.id;
  }

  /** Extract UTM campaign params from a landing-page URL. Returns nulls when
   *  the URL is unparseable or carries no UTM tags. */
  private parseUtm(url: string | undefined): {
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
  } {
    const empty = { utmSource: null, utmMedium: null, utmCampaign: null };
    if (!url) return empty;
    try {
      const q = new URL(url).searchParams;
      return {
        // Decoded query values: "%00" decodes to NUL, which Postgres rejects.
        utmSource: ReplayPersistenceService.queryValue(q, "utm_source"),
        utmMedium: ReplayPersistenceService.queryValue(q, "utm_medium"),
        utmCampaign: ReplayPersistenceService.queryValue(q, "utm_campaign"),
      };
    } catch {
      return empty;
    }
  }

  /** A decoded query parameter, made storable (or null when absent). */
  private static queryValue(q: URLSearchParams, key: string): string | null {
    const v = q.get(key);
    return v === null ? null : wellFormed(v);
  }

  /**
   * Which Session row this batch belongs to. Session.publicId is the SDK's
   * client-chosen id and is globally unique, so it can already belong to
   * ANOTHER workspace: host-supplied ids that collide, or a workspace sending a
   * session id copied from someone else's share link. Writing into that row let
   * one workspace change another's session (counters, owner, custom props,
   * paths, segments). A session whose id is taken elsewhere is stored under a
   * server-derived id unique to this workspace instead (workspaceScopedSessionId).
   *
   * Access pattern: one point lookup on the Session.publicId unique btree (the
   * read upsertSession always did); a second one only on a collision.
   */
  private async resolveSessionTarget(
    workspaceId: number,
    rawSessionId: string,
  ): Promise<{ publicId: string; existing: Session | null }> {
    const byRawId = await this.db.session.findUnique({
      where: { publicId: rawSessionId },
    });
    if (!byRawId || byRawId.workspaceId === workspaceId) {
      return { publicId: rawSessionId, existing: byRawId };
    }
    const publicId = workspaceScopedSessionId(workspaceId, rawSessionId);
    const existing = await this.db.session.findUnique({ where: { publicId } });
    if (existing && existing.workspaceId !== workspaceId) {
      // Only possible on a sha256 prefix collision: refuse rather than write
      // into another workspace's session.
      throw new Error(`Session ${publicId} belongs to another workspace`);
    }
    return { publicId, existing };
  }

  private async upsertSession(args: {
    workspaceId: number;
    /** The SDK's session id, as sent. */
    rawSessionId: string;
    /** The id this workspace's session is stored under (resolveSessionTarget):
     *  the raw id, or its workspace-scoped form when another workspace owns it. */
    sessionPublicId: string;
    /** That session's row, already read by resolveSessionTarget (null: new). */
    existing: Session | null;
    endUserId: number | null;
    envelope: ReplayBatchEnvelope;
    startedAt: number;
    endedAt: number;
    /** The SDK's persistent per-browser id (localStorage). Stamped on the
     *  session so web — like mobile — has a real per-device id to group a
     *  user's sessions by, AND so a later identify() can retroactively claim the
     *  device's earlier anonymous sessions (see claimAnonymousSessionsOnIdentify,
     *  the web counterpart of mobile's linkEndUser). */
    fingerprint: string | undefined;
    /** The IP THIS session came from — resolved to its own geo on first batch,
     *  rather than inheriting whichever location the user was last seen at. */
    ip: string | undefined;
    /** Authoritative country ISO-2 from the edge (Cloudflare), overriding
     *  geoip's country/flag when they disagree with its own city. */
    geoCountry: string | undefined;
    /** True when THIS batch carried a real identify() (distinctId/email), so
     *  `endUserId` is the identified user. Lets the session's endUserId upgrade
     *  from the anonymous ghost to the identified user, and signals the caller to
     *  run the one-time retroactive claim. */
    hasRealIdentity: boolean;
  }, retriedOnConflict = false): Promise<
    Session & {
      claimAnonymous: boolean;
      /** True when THIS call added the batch's counts to the session; false
       *  when an earlier attempt at the same batch already had (see
       *  applyBatchCounts). The caller projects ClickHouse rows only when true. */
      applied: boolean;
    }
  > {
    const counts = ReplayPersistenceService.countEvents(args.envelope.events);
    const status: SessionStatus =
      Date.now() - args.endedAt < LIVE_THRESHOLD_MS ? "LIVE" : "COMPLETED";
    // Measure the raw JSON payload size for storage accounting. Cheap —
    // we're already serialising the events when we write to Mongo.
    const dataSize = BigInt(
      Buffer.byteLength(JSON.stringify(args.envelope.events), "utf8"),
    );
    const existing = args.existing;
    // Fire the one-time retroactive claim only when a real identity FIRST lands
    // on this session: on create (no existing row) with an identity, or on the
    // batch that flips an already-anonymous session onto the identified user.
    // Steady-state identified batches (endUserId already the identified user)
    // skip it, so the extra reads/writes are once-per-session, not per-batch.
    const claimAnonymous =
      args.hasRealIdentity &&
      !!args.fingerprint &&
      (existing ? existing.endUserId !== args.endUserId : true);
    if (existing) {
      // Merge new track-event names into the session's denormalised
      // list. Prisma doesn't have a native "array set-union" op, so we
      // do it in JS — fine because the list is tiny (typically ≤ 20
      // distinct names per session).
      const mergedEventNames =
        counts.trackNames.length > 0
          ? Array.from(
              new Set([...(existing.eventNames ?? []), ...counts.trackNames]),
            )
          : undefined;
      // Web-vitals + long-task aggregates. For LCP/CLS/FID we keep the
      // WORST value seen across the session (matches what an analyst
      // wants: "this user's worst experience on this page"). For long
      // tasks we accumulate count + total ms across batches and keep
      // the slowest single task. Peak heap is also a max.
      const perfUpdate: Record<string, unknown> = {};
      if (counts.perf.lcp !== null) {
        perfUpdate.worstLcp = Math.max(existing.worstLcp ?? 0, counts.perf.lcp);
      }
      if (counts.perf.clsX1000 !== null) {
        perfUpdate.worstClsX1000 = Math.max(
          existing.worstClsX1000 ?? 0,
          counts.perf.clsX1000,
        );
      }
      if (counts.perf.fid !== null) {
        perfUpdate.worstFid = Math.max(existing.worstFid ?? 0, counts.perf.fid);
      }
      if (counts.perf.inp !== null) {
        perfUpdate.worstInp = Math.max(existing.worstInp ?? 0, counts.perf.inp);
      }
      if (counts.perf.fcp !== null) {
        perfUpdate.worstFcp = Math.max(existing.worstFcp ?? 0, counts.perf.fcp);
      }
      if (counts.perf.ttfb !== null) {
        perfUpdate.worstTtfb = Math.max(existing.worstTtfb ?? 0, counts.perf.ttfb);
      }
      if (counts.perf.longTaskCount > 0) {
        // (longTaskCount itself is a count: added in applyBatchCounts.)
        perfUpdate.longTaskSlowestMs = Math.max(
          existing.longTaskSlowestMs ?? 0,
          counts.perf.longTaskSlowestMs,
        );
      }
      if (counts.perf.peakHeapBytes > 0) {
        perfUpdate.peakHeapBytes = BigInt(
          Math.max(
            Number(existing.peakHeapBytes ?? 0n),
            counts.perf.peakHeapBytes,
          ),
        );
      }
      // ---- Native vitals merge ----
      // Once-per-session metrics (coldStart, firstNetworkTtfb): only
      // write if the column is still null. Worst-of-session metrics:
      // Math.max into existing value. Counters: increment.
      const np = counts.nativePerf;
      if (np.coldStartMs !== null && existing.coldStartMs === null) {
        perfUpdate.coldStartMs = np.coldStartMs;
      }
      if (np.firstNetworkTtfbMs !== null && existing.firstNetworkTtfbMs === null) {
        perfUpdate.firstNetworkTtfbMs = np.firstNetworkTtfbMs;
      }
      if (np.firstMeaningfulRenderMs !== null) {
        perfUpdate.firstMeaningfulRenderMs = Math.max(
          existing.firstMeaningfulRenderMs ?? 0,
          np.firstMeaningfulRenderMs,
        );
      }
      if (np.tapResponseMs !== null) {
        perfUpdate.worstTapResponseMs = Math.max(
          existing.worstTapResponseMs ?? 0,
          np.tapResponseMs,
        );
      }
      if (np.frameDropPctX100 !== null) {
        perfUpdate.worstFrameDropPct = Math.max(
          existing.worstFrameDropPct ?? 0,
          np.frameDropPctX100,
        );
      }
      if (np.memoryRssMb !== null) {
        perfUpdate.worstMemoryRssMb = Math.max(
          existing.worstMemoryRssMb ?? 0,
          np.memoryRssMb,
        );
      }
      if (np.thermalState !== null) {
        perfUpdate.worstThermalState = Math.max(
          existing.worstThermalState ?? 0,
          np.thermalState,
        );
      }
      if (np.batteryDrainPctX100 !== null) {
        perfUpdate.batteryDrainPctPerMin = Math.max(
          existing.batteryDrainPctPerMin ?? 0,
          np.batteryDrainPctX100,
        );
      }
      // setMetadata() traits → session properties (only when present, so no
      // extra write on ordinary batches).
      if (Object.keys(counts.sessionProps).length > 0) {
        await mergeSessionCustomProps(
          this.db,
          args.workspaceId,
          existing.id,
          counts.sessionProps,
        );
      }
      // Everything in this update is idempotent (a set, a max, a set-union), so
      // a Bull retry may run it again. The batch's COUNTS are not: they are
      // added by applyBatchCounts below, exactly once per batch.
      const updatedRow = await this.db.session.update({
        // workspaceId too: a backstop so a session can only ever be updated by
        // its own workspace's batches (resolveSessionTarget already ensures it).
        where: { id: existing.id, workspaceId: args.workspaceId },
        data: {
          endedAt: new Date(args.endedAt),
          // Clamped: the span comes from SDK timestamps, and a client clock jump
          // past ~24.8 days would otherwise overflow the INT4 and fail the write.
          durationMs: toInt4(args.endedAt - existing.startedAt.getTime()),
          // A session becomes playable once ANY batch carried a full snapshot;
          // once true it stays true (never flip back on a later frame-less batch).
          ...(counts.fullSnapshot && !existing.hasFullSnapshot
            ? { hasFullSnapshot: true }
            : {}),
          status,
          // Upgrade the session onto the identified user the moment identify()
          // lands (hasRealIdentity) instead of staying pinned to whatever its
          // first anonymous batch resolved — this was the bug that stranded a
          // user's own session under a fingerprint ghost. Without identify, keep
          // the existing owner. The caller sweeps the user's OTHER sessions.
          endUserId: args.hasRealIdentity
            ? args.endUserId
            : (existing.endUserId ?? args.endUserId),
          ...(mergedEventNames ? { eventNames: mergedEventNames } : {}),
          ...(args.envelope.page.url && existing.startUrl === null
            ? { startUrl: args.envelope.page.url }
            : {}),
          ...perfUpdate,
        },
      });
      // LAST, so nothing between it and the caller's ClickHouse projection can
      // fail: see `applied` above.
      const added = await this.applyBatchCounts(
        existing.id,
        args.workspaceId,
        args.envelope,
        counts,
        dataSize,
        args.startedAt,
        args.endedAt,
      );
      // Bump workspace storage (only when this call added the batch) and, if
      // the session is transitioning from LIVE to COMPLETED, decrement the live
      // counter. Out-of-band, so a failure here can't undo the session update.
      const liveDelta =
        existing.status === "LIVE" && status === "COMPLETED" ? -1 : 0;
      if (added || liveDelta !== 0) {
        this.stats
          .bump(args.workspaceId, {
            storageBytes: added ? dataSize : 0n,
            liveSessions: liveDelta,
          })
          .catch(() => {});
      }
      // The row's other counters are from before applyBatchCounts; the caller
      // reads none of them. It does read longTaskTotalMs (the perf-daily bump),
      // which is the session's total WITH this batch, as it was before the
      // INT4 fix moved that increment out of the update above.
      return {
        ...updatedRow,
        ...(added ? { longTaskTotalMs: added.longTaskTotalMs } : {}),
        claimAnonymous,
        applied: added !== null,
      };
    }
    // First batch for this publicId → a new Session row.
    // Device facts for THIS session, from its first batch. The same values also
    // go to EndUser (upsertEndUser), but there they're last-write-wins across
    // every device the person uses — these are the session's own, set once.
    const sessionDevice = webDeviceFacts(
      args.envelope.page.userAgent ?? "",
      args.envelope.page.viewport?.width,
    );
    // Geo for THIS session, from ITS ip. Resolved here (not reused from
    // upsertEndUser) so the session owns its own location — a local geoip-lite
    // lookup, and only on the first batch, so the cost is negligible.
    const sessionGeo = resolveGeo(args.ip, args.geoCountry);
    // Optimistic insert. On the rare race where a concurrent batch for the SAME
    // publicId (parallel queue jobs / multiple PM2 workers) created the row
    // between our findUnique above and here, the unique(publicId) rejects with
    // P2002 — re-run ONCE so the retry's findUnique takes the (correctly-
    // incrementing) update path instead of crashing the whole batch.
    let createdRow: Session;
    try {
      createdRow = await this.db.session.create({
        data: {
          publicId: args.sessionPublicId,
          workspaceId: args.workspaceId,
          endUserId: args.endUserId,
          // Web had no per-device id before: only the mobile SDK stamped this, so
          // every web session collapsed into one NULL bucket. The fingerprint is
          // exactly that id and already reaches persist().
          anonymousId: args.fingerprint ?? null,
          ...sessionDevice,
          city: sessionGeo.city,
          state: sessionGeo.state,
          country: sessionGeo.country,
          flag: sessionGeo.flag,
          timezone: (args.envelope.page as { timezone?: string }).timezone ?? null,
          ip: args.ip ?? null,
          status,
          startedAt: new Date(args.startedAt),
          endedAt: new Date(args.endedAt),
          durationMs: toInt4(args.endedAt - args.startedAt),
          pageCount: 1,
          // The batch's COUNTS (clicks, errors, frames, data size, long tasks,
          // frozen frames, ANRs) are not set here: the row starts at the
          // schema's zeros and applyBatchCounts adds them below, exactly once
          // (a Bull retry after this insert finds the session and goes through
          // the update path, which must not find the counts already in).
          hasFullSnapshot: counts.fullSnapshot,
          eventNames: counts.trackNames,
          startUrl: args.envelope.page.url,
          // Entry referrer + UTM campaign tags, captured from the landing page
          // at session start. Power the referrer + utm* funnel/session filters.
          entryReferrer: args.envelope.page.referrer || null,
          ...this.parseUtm(args.envelope.page.url),
          revId: args.envelope.sdk.revId ?? null,
          userAgent: args.envelope.page.userAgent,
          platform: args.envelope.sdk.platform,
          sdkName: args.envelope.sdk.name,
          sdkVersion: args.envelope.sdk.version,
          // Host-app version + build are optional in the schema.
          // Both SDKs ship them from 0.0.2+; older sessions stay
          // null + the symbolication endpoint short-circuits to the
          // raw stack on the dashboard.
          appVersion: args.envelope.sdk.appVersion ?? null,
          appBuild: args.envelope.sdk.appBuild ?? null,
          viewport: `${args.envelope.page.viewport?.width ?? 0}x${args.envelope.page.viewport?.height ?? 0}`,
          // Web-vitals + long-task aggregates on first-write. Nulls mean
          // the SDK never emitted that metric for this session (e.g.
          // browser without the API, or page closed before fire).
          worstLcp: counts.perf.lcp,
          worstClsX1000: counts.perf.clsX1000,
          worstFid: counts.perf.fid, // legacy; new SDK emits inp
          worstInp: counts.perf.inp,
          worstFcp: counts.perf.fcp,
          worstTtfb: counts.perf.ttfb,
          longTaskSlowestMs: counts.perf.longTaskSlowestMs,
          peakHeapBytes: BigInt(counts.perf.peakHeapBytes),
          // Native vitals — null/0 for web sessions, populated for
          // iOS / Android / Flutter / RN sessions.
          coldStartMs: counts.nativePerf.coldStartMs,
          firstMeaningfulRenderMs: counts.nativePerf.firstMeaningfulRenderMs,
          worstTapResponseMs: counts.nativePerf.tapResponseMs,
          firstNetworkTtfbMs: counts.nativePerf.firstNetworkTtfbMs,
          worstFrameDropPct: counts.nativePerf.frameDropPctX100,
          worstMemoryRssMb: counts.nativePerf.memoryRssMb,
          worstThermalState: counts.nativePerf.thermalState,
          batteryDrainPctPerMin: counts.nativePerf.batteryDrainPctX100,
        },
      });
    } catch (e) {
      // Concurrency race lost: another batch created this publicId between our
      // lookup and this create. Re-run ONCE through the resolver — the winner
      // may be this workspace (→ update path) or another one (→ this session
      // moves to its workspace-scoped id). The guard stops a genuine repeated
      // failure (or a different unique violation) from looping.
      if (
        !retriedOnConflict &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        const again = await this.resolveSessionTarget(
          args.workspaceId,
          args.rawSessionId,
        );
        return this.upsertSession(
          { ...args, sessionPublicId: again.publicId, existing: again.existing },
          true,
        );
      }
      throw e;
    }
    // Create WON the race → bump the workspace counters now, so a lost create
    // race never over-counts sessionsTotal (the winner bumps its own). Storage
    // is bumped with the batch's counts, below.
    this.stats
      .bump(args.workspaceId, {
        sessionsTotal: 1,
        liveSessions: status === "LIVE" ? 1 : 0,
      })
      .catch(() => {});
    // setMetadata() traits present on the FIRST batch (create) — merge them too.
    if (Object.keys(counts.sessionProps).length > 0) {
      await mergeSessionCustomProps(
        this.db,
        args.workspaceId,
        createdRow.id,
        counts.sessionProps,
      );
    }
    // LAST, as on the update path.
    const added = await this.applyBatchCounts(
      createdRow.id,
      args.workspaceId,
      args.envelope,
      counts,
      dataSize,
      args.startedAt,
      args.endedAt,
    );
    if (added) {
      this.stats
        .bump(args.workspaceId, { storageBytes: dataSize })
        .catch(() => {});
    }
    return {
      ...createdRow,
      ...(added ? { longTaskTotalMs: added.longTaskTotalMs } : {}),
      claimAnonymous,
      applied: added !== null,
    };
  }

  /**
   * Retroactively fold a device's ANONYMOUS journey into the user who just
   * identified — the web counterpart of mobile's linkEndUser. Web (unlike
   * mobile, which leaves anonymous sessions endUserId=null) had already pinned
   * every anonymous session to a "ghost" EndUser keyed by the raw fingerprint,
   * so instead of claiming NULLs we reassign the ghost's sessions to the
   * identified user and then retire the emptied ghost.
   *
   * Called ONCE per session, at the identity-association moment (gated by
   * upsertSession's `claimAnonymous`), so it never runs on steady-state batches.
   */
  private async claimAnonymousSessionsOnIdentify(
    workspaceId: number,
    fingerprint: string,
    identifiedEndUserId: number,
  ): Promise<void> {
    // The ghost is the EndUser keyed by the raw fingerprint (distinctId ===
    // fingerprint). Absent (identify() came before any anonymous batch) or IS
    // the identified user → nothing to fold in.
    const ghost = await this.db.endUser.findUnique({
      where: {
        workspaceId_distinctId: { workspaceId, distinctId: fingerprint },
      },
      select: { id: true, firstSeenAt: true },
    });
    if (!ghost || ghost.id === identifiedEndUserId) return;

    // ONE set-based UPDATE, backed by @@index([workspaceId, anonymousId]): move
    // every session on this device still pinned to the ghost onto the identified
    // user. Access pattern: the (workspaceId, anonymousId) range is one device's
    // sessions — tens, never a table scan — so it scales to millions of rows.
    // Scoped to endUserId === ghost.id so a DIFFERENT identified user who shared
    // this browser keeps their own sessions (never an over-claim).
    await this.db.session.updateMany({
      where: { workspaceId, anonymousId: fingerprint, endUserId: ghost.id },
      data: { endUserId: identifiedEndUserId },
    });

    // Preserve the TRUE first-visit time: the identified row was created at
    // identify(), so without this the pre-identify journey's start is lost. Only
    // moves it earlier, and only for THIS user — indexed by PK.
    await this.db.endUser.updateMany({
      where: { id: identifiedEndUserId, firstSeenAt: { gt: ghost.firstSeenAt } },
      data: { firstSeenAt: ghost.firstSeenAt },
    });

    // Retire the now-empty ghost so it doesn't linger as a phantom 0-recording
    // user in the Users list. Safe: Session.endUser is optional (default
    // SetNull, so any session a concurrent anonymous batch raced in just goes
    // unlinked and self-heals on the next identify), and CohortMember cascades.
    // Best-effort — a delete race (P2025) must never fail the ingest job.
    try {
      await this.db.endUser.delete({ where: { id: ghost.id } });
      // The ghost was counted in usersTotal at creation; folding it into the
      // identified user means one fewer distinct person. Fire-and-forget.
      this.stats.bump(workspaceId, { usersTotal: -1 }).catch(() => {});
    } catch {
      /* ghost already deleted by a concurrent claim — fine */
    }
  }

  /**
   * Add one batch's counts to its Session EXACTLY ONCE, however often the
   * batch is processed: a Bull retry after a write failed part-way, a stalled
   * job re-run after a worker restart (every deploy's reload), or a resend
   * whose first delivery never got its persistedAt marker. Returns the
   * session's long-task total after adding them, or null when an earlier
   * attempt already had.
   *
   * One statement, so the claim and the counts commit together or not at all:
   * the CTE inserts this batch's SessionSegment row (the per-batch record that
   * its counts are in), and the UPDATE adds the counts only if that insert
   * claimed the row. upsertSegment later fills in the row's mongoBatchId.
   *
   * `ON CONFLICT DO NOTHING` names no index on purpose: until the follow-up
   * migration drops the deprecated (sessionId, sequence) unique, a later page
   * load's batch N conflicts with the previous load's batch N there, and so
   * claims nothing. The NOT EXISTS tells the two conflicts apart: it reads the
   * statement's snapshot (it never sees the claim's own insert), so it is true
   * exactly when no row for THIS (session, sequence, segment) existed before.
   * Such a batch gets its counts like before this method existed; only a retry
   * of it is not protected, and only until that index is gone.
   *
   * Access pattern: one INSERT and one primary-key UPDATE, both through unique
   * indexes ((sessionId, sequence, segmentPublicId) for the claim and the NOT
   * EXISTS probe, the Session pkey for the update), O(1) per batch at any
   * table size. It replaces the increments the session UPDATE carried (or the
   * counts the session INSERT carried) and the separate saturating UPDATE of
   * the perf totals, so it adds at most one statement per batch. Two batches
   * of one session serialize on the Session row lock, as their updates always
   * did; the segment insert's foreign-key check takes only a KEY SHARE lock on
   * that row, which does not conflict with the update's lock, so the two
   * batches cannot deadlock.
   *
   * The perf running totals saturate at the INT4 maximum instead of
   * overflowing (a plain increment past it makes Postgres reject this and
   * every later batch of the session). The per-batch counts are bounded by a
   * batch's event count, as with the Prisma increments they replace.
   */
  private async applyBatchCounts(
    sessionId: number,
    workspaceId: number,
    envelope: ReplayBatchEnvelope,
    counts: ReturnType<typeof ReplayPersistenceService.countEvents>,
    dataSize: bigint,
    startedAt: number,
    endedAt: number,
  ): Promise<{ longTaskTotalMs: number } | null> {
    const np = counts.nativePerf;
    const longTaskCount = counts.perf.longTaskCount;
    const longTaskMs = longTaskCount > 0 ? counts.perf.longTaskTotalMs : 0;
    // Timestamps go in as ISO text cast to the column type, so the stored wall
    // time is UTC like every Prisma write, whatever the server's TimeZone.
    const rows = await this.db.$queryRaw<Array<{ longTaskTotalMs: number }>>`
      WITH claim AS (
        INSERT INTO "SessionSegment"
          ("sessionId", "segmentPublicId", "sequence", "eventCount", "startedAt", "endedAt")
        VALUES (
          ${sessionId}, ${envelope.segmentId}, ${envelope.sequence},
          ${envelope.events.length},
          ${new Date(startedAt).toISOString()}::timestamp(3),
          ${new Date(endedAt).toISOString()}::timestamp(3)
        )
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      UPDATE "Session" SET
        "clickCount"          = "clickCount" + ${counts.click},
        "rageCount"           = "rageCount" + ${counts.rage},
        "errorCount"          = "errorCount" + ${counts.error},
        "deadCount"           = "deadCount" + ${counts.dead},
        "consoleCount"        = "consoleCount" + ${counts.console},
        "consoleErrorCount"   = "consoleErrorCount" + ${counts.consoleError},
        "networkCount"        = "networkCount" + ${counts.network},
        "tapCount"            = "tapCount" + ${counts.tap},
        "nativeSnapshotCount" = "nativeSnapshotCount" + ${counts.nativeSnapshot},
        "frameCount"          = "frameCount" + ${counts.frames},
        "dataSizeBytes"       = "dataSizeBytes" + ${dataSize},
        "longTaskCount"       = "longTaskCount" + ${longTaskCount},
        "longTaskTotalMs"     = LEAST("longTaskTotalMs"::bigint  + ${longTaskMs}, ${INT4_MAX})::int,
        "frozenFrameCount"    = LEAST("frozenFrameCount"::bigint + ${np.frozenFrameCount}, ${INT4_MAX})::int,
        "anrCount"            = LEAST("anrCount"::bigint         + ${np.anrCount}, ${INT4_MAX})::int
      WHERE id = ${sessionId}
        AND "workspaceId" = ${workspaceId}
        AND (
          EXISTS (SELECT 1 FROM claim)
          OR NOT EXISTS (
            SELECT 1 FROM "SessionSegment"
            WHERE "sessionId" = ${sessionId}
              AND "sequence" = ${envelope.sequence}
              AND "segmentPublicId" = ${envelope.segmentId}
          )
        )
      RETURNING "longTaskTotalMs"`;
    return rows[0] ?? null;
  }

  private async upsertSegment(
    sessionId: number,
    envelope: ReplayBatchEnvelope,
    startedAt: number,
    endedAt: number,
    mongoBatchId: string,
  ) {
    // Keyed per segment, like the Mongo batch: a new page load's batch N is its
    // own row, not an overwrite of the previous load's batch N. One upsert on
    // the (sessionId, sequence, segmentPublicId) unique index.
    try {
      await this.db.sessionSegment.upsert({
        where: {
          sessionId_sequence_segmentPublicId: {
            sessionId,
            sequence: envelope.sequence,
            segmentPublicId: envelope.segmentId,
          },
        },
        create: {
          sessionId,
          segmentPublicId: envelope.segmentId,
          sequence: envelope.sequence,
          eventCount: envelope.events.length,
          startedAt: new Date(startedAt),
          endedAt: new Date(endedAt),
          mongoBatchId,
        },
        update: {
          endedAt: new Date(endedAt),
          eventCount: envelope.events.length,
          mongoBatchId,
        },
      });
    } catch (e) {
      // Transition only: until the follow-up migration drops the old
      // (sessionId, sequence) unique index, a later page load's batch N
      // collides with it. Skip that one row rather than fail the job: the
      // replay itself is already stored in Mongo, and nothing reads
      // SessionSegment to load a recording. Matches ONLY that index's
      // violation (Prisma reports its columns as the target). Remove with the
      // follow-up migration.
      const target = (e as Prisma.PrismaClientKnownRequestError).meta?.target;
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        Array.isArray(target) &&
        target.length === 2 &&
        target[0] === "sessionId" &&
        target[1] === "sequence"
      ) {
        return;
      }
      throw e;
    }
  }

  private async upsertPaths(
    workspaceId: number,
    sessionId: number,
    envelope: ReplayBatchEnvelope,
  ) {
    if (!envelope.page.url) return;
    const max = await this.db.sessionPath.findFirst({
      where: { sessionId },
      orderBy: { sequence: "desc" },
      select: { sequence: true, url: true },
    });
    if (max?.url === envelope.page.url) return;
    await this.db.sessionPath.create({
      data: {
        sessionId,
        sequence: (max?.sequence ?? -1) + 1,
        url: envelope.page.url,
      },
    });
    // The session row is created with pageCount 1 for its landing page, which
    // is also the first path recorded here; counting it again made every web
    // session report one page more than it visited. Only a later page counts.
    if (!max) return;
    await this.db.session.update({
      where: { id: sessionId, workspaceId },
      data: { pageCount: { increment: 1 } },
    });
  }

  private async projectToClickhouse(
    workspaceId: number,
    sessionId: number,
    sessionPublicId: string,
    envelope: ReplayBatchEnvelope,
  ) {
    // Pull the workspace's allowed-host list once per batch — we cache the
    // last fetch on the row so this is cheap.
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { allowedHosts: true },
    });
    const allowedHosts = ws?.allowedHosts ?? [];

    // Per-column defaults for non-network / non-tap rows so the
    // ClickHouse INSERT covers every column the schema declares
    // (otherwise INSERT errors on missing fields).
    const empty = {
      request_headers: "",
      response_headers: "",
      request_body: "",
      response_body: "",
      connection_rtt: 0,
      connection_effective_type: "",
      ui_class: "",
      ui_value: "",
      ui_id: "",
      ui_type: "",
      bounds_x: 0,
      bounds_y: 0,
      bounds_w: 0,
      bounds_h: 0,
      point_x: 0,
      point_y: 0,
      is_sensitive: 0,
      gesture: "",
      pinch_scale_x1000: 0,
      route: "",
    };

    // Track the current route as we walk the envelope's events so
    // tap rows can carry the route they fired on. Mobile SDKs emit
    // `custom { kind: "screen" | "session_property" }` for screen
    // changes, plus the snapshot trigger string. We just sniff
    // `event.data.route` on tap events themselves since they
    // already carry it; this var is for screen-row generation.
    let currentRoute = "";
    // Release the session ran (appVersion, falling back to web revId) —
    // denormalised onto every event row for release-scoped analysis.
    const release =
      envelope.sdk.appVersion || envelope.sdk.revId || "";

    const rows: ProjectionRow[] = [];
    for (const event of envelope.events) {
      const base = {
        workspace_id: workspaceId,
        session_id: sessionId,
        session_public_id: sessionPublicId,
        sequence: envelope.sequence,
        event_id: event.id,
        event_type: event.type,
        timestamp: event.ts,
        offset_ms: event.offsetMs,
        release,
      };
      if (event.type === "console") {
        const d = event.data as ConsoleEventData;
        rows.push({
          ...base,
          ...empty,
          kind: "console",
          level: d.level ?? "",
          message: d.message ?? "",
          method: "",
          url: "",
          status_code: 0,
          duration_ms: 0,
          error: "",
          stack: d.stack ?? "",
          raw: JSON.stringify(d),
        });
      } else if (event.type === "network") {
        const d = event.data as NetworkEventData;
        // Drop entirely if workspace has an allowlist and this host isn't on it.
        if (!isHostAllowed(d.url ?? "", allowedHosts)) continue;
        const redactedReqHeaders = redactHeaders(d.requestHeaders) ?? {};
        const redactedResHeaders = redactHeaders(d.responseHeaders) ?? {};
        const redactedReqBody = redactBody(d.requestBody) ?? "";
        const redactedResBody = redactBody(d.responseBody) ?? "";
        rows.push({
          ...base,
          ...empty,
          kind: "network",
          level: "",
          message: "",
          method: d.method ?? "",
          url: d.url ?? "",
          status_code: d.statusCode ?? 0,
          duration_ms: d.durationMs ?? 0,
          error: d.error ?? "",
          stack: "",
          raw: "", // raw kept empty for network — full info lives in the named columns
          request_headers: JSON.stringify(redactedReqHeaders),
          response_headers: JSON.stringify(redactedResHeaders),
          request_body: redactedReqBody,
          response_body: redactedResBody,
          connection_rtt: d.connectionRtt ?? 0,
          connection_effective_type: d.connectionEffectiveType ?? "",
        });
      } else if (event.type === "navigation") {
        // Web page-view / SPA route change (also the SDK's initial "load"
        // navigation event). Project it as a `screen` row with `route` = the URL
        // PATH, so funnel "Viewed page" steps (which match the `route` column)
        // AND the step-value autocomplete work for WEB — mirroring how mobile
        // `screen` events populate route. Without this case web page-views were
        // dropped entirely, so every web page funnel silently matched nothing.
        const d = event.data as NavigationEventData;
        let path = "";
        try {
          path = d.to ? new URL(d.to).pathname || "/" : "";
        } catch {
          path = d.to ?? "";
        }
        currentRoute = path || currentRoute;
        rows.push({
          ...base,
          ...empty,
          kind: "screen",
          level: "",
          message: path,
          method: "",
          url: d.to ?? "",
          status_code: 0,
          duration_ms: 0,
          error: "",
          stack: "",
          raw: "",
          // document.title → the human screen NAME, stored in the (otherwise
          // empty-for-screens) ui_value column so the Screens list can read it
          // with a plain SELECT, no JSON parse. No migration — reuses a column.
          ui_value: d.title ?? "",
          route: path,
        });
      } else if (event.type === "tap") {
        // Native-platform tap (Android OnTouchListener / iOS
        // UIGestureRecognizer). The web SDK's click events also
        // come through here when we unify the path. Bounds + point
        // are pre-converted to screen-relative pixels by the SDK.
        const d = event.data as TapEventData;
        currentRoute = d.route ?? currentRoute;
        rows.push({
          ...base,
          ...empty,
          kind: "tap",
          level: "",
          message: "",
          method: "",
          url: "",
          status_code: 0,
          duration_ms: 0,
          error: "",
          stack: "",
          raw: JSON.stringify(d),
          ui_class: d.isSensitive ? "" : (d.uiClass ?? ""),
          ui_value: d.isSensitive ? "" : (d.uiValue ?? ""),
          ui_id: d.uiId ?? "",
          ui_type: d.uiType ?? "",
          bounds_x: d.bounds?.x ?? 0,
          bounds_y: d.bounds?.y ?? 0,
          bounds_w: d.bounds?.w ?? 0,
          bounds_h: d.bounds?.h ?? 0,
          point_x: d.point?.x ?? 0,
          point_y: d.point?.y ?? 0,
          is_sensitive: d.isSensitive ? 1 : 0,
          gesture: d.gesture ?? "tap",
          // Pinch gestures ship a fractional scale (1.0 = no change,
          // 1.4 = zoom in 40%). Store as int × 1000 so the column
          // stays integer-typed; dashboard divides at render.
          pinch_scale_x1000:
            typeof d.pinchScale === "number"
              ? Math.round(d.pinchScale * 1000)
              : 0,
          route: d.route ?? currentRoute,
        });
      } else if (event.type === "custom") {
        // Mobile SDKs' custom events. `kind` discriminates the
        // variant (track | bug_report | session_property |
        // session_tag | push_token | session_favorite); `name`
        // is the user-supplied event name (or reserved slot for
        // the variants). Properties → raw JSON for the dashboard
        // to render as a collapsible tree.
        const d = event.data as CustomEventData;
        const customKind = d.kind ?? "track";
        // Treat session_property kind="screen" / explicit screen
        // events as a separate `screen` row so the dashboard's
        // future "Screens" tab can query them directly without
        // sifting through every custom event.
        const isScreen =
          customKind === "screen" ||
          (customKind === "session_property" && d.name === "screen");
        if (isScreen) {
          const screenName =
            typeof d.properties?.name === "string"
              ? d.properties.name
              : d.name;
          currentRoute = screenName ?? currentRoute;
        }
        // Web semantic-click fields (kind:"click") — mapped onto the SAME typed
        // ui_* columns mobile taps use, so a click HEATMAP is a single
        // `GROUP BY ui_id` over ClickHouse's columnar store (indexed by the
        // session_id sort key) — never a JSON scan of `raw`, and it unifies
        // web + native element analytics on one aggregation.
        const c = d as {
          selector?: string;
          label?: string;
          nx?: number;
          ny?: number;
          uiId?: string;
        };
        const isClick = customKind === "click";
        rows.push({
          ...base,
          ...empty,
          kind: isScreen ? "screen" : "custom",
          // `level` repurposed as the custom-variant discriminator
          // so dashboard SQL filtering stays cheap (LowCardinality
          // index). Reserved values: "track", "bug_report",
          // "session_property", "session_tag", "push_token",
          // "session_favorite", "screen", "click", "rage_click",
          // "dead_click", "identify", "session_metadata".
          level: customKind,
          message: d.name ?? "",
          method: "",
          url: "",
          status_code: 0,
          duration_ms: 0,
          error: "",
          stack: "",
          raw: JSON.stringify(d),
          // ui_id (heatmap bucket) only for clicks; ui_class = selector.
          ui_id: isClick ? (c.uiId ?? "") : "",
          ui_class: isClick ? (c.selector ?? "") : "",
          // ui_value: the human label for a click, the selector for rage/dead —
          // so element-level unmet-demand aggregates on it like taps.
          ui_value: isClick
            ? (c.label ?? "")
            : customKind === "dead_click" || customKind === "rage_click"
              ? (c.selector ?? "")
              : "",
          // Content-normalized 0..1e4 coords for the click; non-negative ints.
          point_x: isClick ? ReplayPersistenceService.nonNeg(c.nx ?? 0) : 0,
          point_y: isClick ? ReplayPersistenceService.nonNeg(c.ny ?? 0) : 0,
          route: currentRoute,
        });
      } else if (event.type === "performance") {
        // Performance events — both web vitals (lcp/cls/fid/inp/
        // long_task/memory) and native mobile vitals (cold_start_ms,
        // frame_drop_pct, frozen_frame_count, anr_ms, memory_rss_mb,
        // thermal_state, battery_*). The session-row aggregates that
        // already exist drive NativePerfPanel's headline numbers;
        // these per-event rows let the dashboard render a time-series
        // (e.g. memory over time) and a "Recent ANRs" table per
        // session.
        const d = event.data as PerformanceEventData;
        rows.push({
          ...base,
          ...empty,
          kind: "perf",
          // rating bucket ("good" / "needs-improvement" / "poor")
          // surfaces as the row's level — drives chip colour.
          level: d.rating ?? "",
          message: d.unit ?? "",
          // `method` holds the metric name so dashboard SQL can
          // filter `WHERE method = 'anr_ms'`.
          method: d.metric ?? "",
          url: "",
          status_code: 0,
          // Value is stored × 1000 so fractional pct values keep
          // precision in the integer column.
          duration_ms: Math.round((d.value ?? 0) * 1000),
          error: "",
          // ANR stacks land here from the cross-repo schema bump
          // (PerformanceEventData.details).
          stack: d.details ?? "",
          raw: JSON.stringify(d),
          route: currentRoute,
        });
      } else if (event.type === "error") {
        const d = event.data as ErrorEventData;
        rows.push({
          ...base,
          ...empty,
          kind: "error",
          level: "",
          message: d.message ?? "",
          method: "",
          url: "",
          status_code: 0,
          duration_ms: 0,
          // `error` repurposed as the crash-kind discriminator
          // — "uncaught" (JVM/NSException) vs "signal" (NDK
          // SIGSEGV/etc) vs "promise" (web rejection). Dashboard's
          // Crashes tab keys per-stack-signature aggregation on this.
          // A developer-CAUGHT error (public captureException, `handled`)
          // classifies as "exception" — same as mobile's non-fatal path.
          error: d.handled ? "exception" : (d.kind ?? "error"),
          stack: d.stack ?? "",
          raw: JSON.stringify(d),
          route: currentRoute,
        });
      }
    }
    if (rows.length === 0) return;
    // offset_ms / duration_ms / connection_rtt are UInt32 in ClickHouse. A
    // single negative value — an event whose timestamp precedes the session
    // start (clock skew, a pre-start buffered event, a paused/resumed tab), or
    // a network row where responseEnd < requestStart — makes the ENTIRE batch
    // insert fail ("Unsigned type must not contain '-' symbol"), and because
    // the insert error is swallowed below, every event in that batch (including
    // web vitals) is silently dropped. Clamp to a non-negative int so one bad
    // row can't sink the batch — the same Math.max(0, …) the mobile path does.
    for (const r of rows) {
      r.offset_ms = ReplayPersistenceService.nonNeg(r.offset_ms);
      r.duration_ms = ReplayPersistenceService.nonNeg(r.duration_ms);
      r.connection_rtt = ReplayPersistenceService.nonNeg(r.connection_rtt);
    }
    try {
      await insertProjectionRows(rows);
    } catch (error) {
      process.stderr.write(
        `ClickHouse insert failed: ${(error as Error).message}\n`,
      );
    }
  }

  /** Clamp a value to a non-negative 32-bit integer for a ClickHouse UInt
   *  column. NaN/Infinity/negative → 0; floats are rounded. */
  private static nonNeg(n: number): number {
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  // -------------------------------------------------------------------------
  //  Pure helpers — moved into the class so module-scope is purely imports
  //  and types. All `static` because they don't touch instance state.
  // -------------------------------------------------------------------------

  private static countEvents(events: ReplayEvent[]) {
    let click = 0,
      error = 0,
      rage = 0,
      dead = 0;
    // Precomputed side-tab counts — surfaced on the Session row so the
    // player can render badges instantly without firing the panel
    // fetches. Console-error is a sub-count of console for the red
    // counter that shows on the Console tab.
    let console_ = 0;
    let consoleError = 0;
    let network = 0;
    // Distinct custom-event names fired in this batch via `replay.track()`.
    // We dedupe per-batch here; the session-level union happens in the
    // persistence loop so older eventNames stick across segments.
    const trackNames = new Set<string>();
    // setMetadata() traits from this batch → merged onto the session (rare).
    const sessionProps: Record<string, string> = {};
    // Native-only counters. Mobile SDKs ship `tap` and `native_snapshot`
    // event types — counted here so the Recordings list + Dashboard
    // tiles can render "23 taps · 5 snapshots" without a Mongo scan.
    let tap = 0;
    let nativeSnapshot = 0;
    // rrweb replay availability for THIS batch: `fullSnapshot` = a base (rrweb
    // type 2) is present; `frames` = rrweb DOM events (full + incremental). The
    // persistence loop ORs hasFullSnapshot + increments frameCount across batches.
    let fullSnapshot = false;
    let frames = 0;
    // Web-vitals + long-task aggregates extracted from the SDK's
    // `type: "performance"` events. We keep the worst values seen IN
    // THIS BATCH; the persistence loop unions across batches via
    // Math.max into the existing Session row.
    let lcpThisBatch = 0;
    let clsThisBatch = 0;
    let fidThisBatch = 0;
    let inpThisBatch = 0;
    let fcpThisBatch = 0;
    let ttfbThisBatch = 0;
    let longTaskCountThisBatch = 0;
    let longTaskTotalThisBatch = 0;
    let longTaskSlowestThisBatch = 0;
    let peakHeapThisBatch = 0;
    // Native vitals — same `kind: "perf"` shape, different metric
    // names. Mapping + thresholds documented in
    // replay-web-sdk/docs/mobile-vitals-matrix.md. Worst-of-session
    // for `worst*` metrics, first-non-null for once-per-session
    // metrics (coldStart, firstNetworkTtfb), increment for counters
    // (frozenFrame, anr). Frame-drop + battery values arrive as
    // fractions and are scaled ×100 to int for indexable storage.
    let coldStartThisBatch: number | null = null;
    let firstMeaningfulRenderThisBatch = 0;
    let tapResponseThisBatch = 0;
    let firstNetworkTtfbThisBatch: number | null = null;
    let frameDropPctX100ThisBatch = 0;
    let frozenFrameCountThisBatch = 0;
    let anrCountThisBatch = 0;
    let memoryRssThisBatch = 0;
    let thermalStateThisBatch = 0;
    let batteryDrainPctX100ThisBatch = 0;
    for (const ev of events) {
      if (ev.type === "error") error++;
      if (ev.type === "pointer") click++;
      // rrweb replay frames — the full snapshot is the base the player needs to
      // render; count both so the session can advertise replay availability.
      if (ev.type === "full_snapshot") {
        fullSnapshot = true;
        frames += 1;
      } else if (ev.type === "incremental_snapshot") {
        frames += 1;
      }
      if (ev.type === "console") {
        console_ += 1;
        const d = ev.data as { level?: string } | undefined;
        if (d?.level === "error") consoleError += 1;
      }
      if (ev.type === "network") network += 1;
      if (ev.type === "tap") tap += 1;
      if (ev.type === "native_snapshot") nativeSnapshot += 1;
      if (ev.type === "custom") {
        const data = ev.data as
          | { kind?: string; name?: string; key?: string; value?: string }
          | undefined;
        if (data?.kind === "rage_click") rage++;
        if (data?.kind === "dead_click") dead++;
        if (
          data?.kind === "track" &&
          typeof data.name === "string" &&
          data.name
        ) {
          trackNames.add(data.name);
        }
        // setMetadata() → attach to the session's properties (rare; collected in
        // this SAME single pass so there's no extra iteration on the hot path).
        if (
          data?.kind === "session_metadata" &&
          typeof data.key === "string" &&
          data.key
        ) {
          // Cut without splitting an emoji: half of one makes Postgres reject
          // the jsonb merge.
          sessionProps[truncateWellFormed(data.key, 80)] =
            typeof data.value === "string"
              ? truncateWellFormed(data.value, 500)
              : "";
        }
      }
      if (ev.type === "performance") {
        const d = ev.data as
          | { kind?: string; metric?: string; value?: number }
          | undefined;
        if (d?.kind !== "perf" || typeof d.value !== "number") continue;
        switch (d.metric) {
          case "lcp":
            if (d.value > lcpThisBatch) lcpThisBatch = d.value;
            break;
          case "cls":
            // CLS comes through as a fractional score; we scale ×1000 so
            // the DB column can be a plain int + indexable. 0.12 → 120.
            if (d.value > clsThisBatch) clsThisBatch = d.value;
            break;
          case "fid":
            // Deprecated upstream (March 2024). Still accepted so old
            // SDK versions keep landing data; new SDK emits inp instead.
            if (d.value > fidThisBatch) fidThisBatch = d.value;
            break;
          case "inp":
            if (d.value > inpThisBatch) inpThisBatch = d.value;
            break;
          case "fcp":
            if (d.value > fcpThisBatch) fcpThisBatch = d.value;
            break;
          case "ttfb":
            if (d.value > ttfbThisBatch) ttfbThisBatch = d.value;
            break;
          case "long_task":
            longTaskCountThisBatch += 1;
            longTaskTotalThisBatch += d.value;
            if (d.value > longTaskSlowestThisBatch)
              longTaskSlowestThisBatch = d.value;
            break;
          case "memory":
            if (d.value > peakHeapThisBatch) peakHeapThisBatch = d.value;
            break;
          // ---- Native vitals ----
          case "cold_start_ms":
            // First-only: keep the first value seen this batch. Update
            // branch will only write to the column if currently null.
            if (coldStartThisBatch === null) coldStartThisBatch = d.value;
            break;
          case "time_to_first_meaningful_render_ms":
            if (d.value > firstMeaningfulRenderThisBatch)
              firstMeaningfulRenderThisBatch = d.value;
            break;
          case "tap_response_ms":
            if (d.value > tapResponseThisBatch) tapResponseThisBatch = d.value;
            break;
          case "first_network_ttfb_ms":
            if (firstNetworkTtfbThisBatch === null)
              firstNetworkTtfbThisBatch = d.value;
            break;
          case "frame_drop_pct":
            // Fractional in (0..1] — scaled ×100 for indexable int.
            {
              const scaled = Math.round(d.value * 100);
              if (scaled > frameDropPctX100ThisBatch)
                frameDropPctX100ThisBatch = scaled;
            }
            break;
          case "frozen_frame_count":
            // Counter — d.value is the delta to add (SDK ships the
            // change since last emit, not the total).
            frozenFrameCountThisBatch += Math.round(d.value);
            break;
          case "anr_count":
            anrCountThisBatch += Math.round(d.value);
            break;
          case "memory_rss_mb":
            if (d.value > memoryRssThisBatch) memoryRssThisBatch = d.value;
            break;
          case "thermal_state":
            // Higher = hotter = worse, so MAX is the right aggregation.
            if (d.value > thermalStateThisBatch)
              thermalStateThisBatch = d.value;
            break;
          case "battery_drain_pct_per_min":
            {
              const scaled = Math.round(d.value * 100);
              if (scaled > batteryDrainPctX100ThisBatch)
                batteryDrainPctX100ThisBatch = scaled;
            }
            break;
        }
      }
    }
    return {
      click,
      error,
      rage,
      dead,
      console: console_,
      consoleError,
      network,
      tap,
      nativeSnapshot,
      fullSnapshot,
      frames,
      trackNames: Array.from(trackNames),
      sessionProps,
      // Every value below lands in an INT4 column and comes straight from the
      // SDK, so it goes through toInt4: one absurd metric (bad clock, buggy or
      // hostile client) must not make Postgres reject the whole session write.
      // peakHeapBytes is a BigInt column and needs no clamp.
      perf: {
        lcp: toInt4(lcpThisBatch) || null,
        clsX1000: clsThisBatch > 0 ? toInt4(clsThisBatch * 1000) : null,
        fid: toInt4(fidThisBatch) || null,
        inp: toInt4(inpThisBatch) || null,
        fcp: toInt4(fcpThisBatch) || null,
        ttfb: toInt4(ttfbThisBatch) || null,
        longTaskCount: longTaskCountThisBatch,
        longTaskTotalMs: toInt4(longTaskTotalThisBatch),
        longTaskSlowestMs: toInt4(longTaskSlowestThisBatch),
        peakHeapBytes: toSafeInt(peakHeapThisBatch),
      },
      nativePerf: {
        coldStartMs:
          coldStartThisBatch === null ? null : toInt4(coldStartThisBatch),
        firstMeaningfulRenderMs: toInt4(firstMeaningfulRenderThisBatch) || null,
        tapResponseMs: toInt4(tapResponseThisBatch) || null,
        firstNetworkTtfbMs:
          firstNetworkTtfbThisBatch === null
            ? null
            : toInt4(firstNetworkTtfbThisBatch),
        frameDropPctX100: toInt4(frameDropPctX100ThisBatch) || null,
        frozenFrameCount: toInt4(frozenFrameCountThisBatch),
        anrCount: toInt4(anrCountThisBatch),
        memoryRssMb: toInt4(memoryRssThisBatch) || null,
        thermalState: toInt4(thermalStateThisBatch) || null,
        batteryDrainPctX100: toInt4(batteryDrainPctX100ThisBatch) || null,
      },
    };
  }

  // We delegate UA parsing to `ua-parser-js` — it handles iOS Safari
  // masquerade, iPad-on-iPadOS reporting Mac, modern Edge ("Edg/"),
  // Chrome on Safari etc. The viewport-width fallback covers cases
  // where the UA is missing or stripped.
}
