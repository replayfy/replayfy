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

const LIVE_THRESHOLD_MS = 30_000;

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

  async persist(job: ReplayBatchJob): Promise<void> {
    const { workspaceId, envelope, identify, ip, fingerprint, geoCountry } = job;

    if (!this.schemaReady) {
      this.schemaReady = ensureClickHouseSchema().catch((e) => {
        process.stderr.write(
          `ClickHouse schema init failed: ${(e as Error).message}\n`,
        );
      });
    }

    const sessionPublicId = envelope.sessionId;
    const startedAt = envelope.events[0]?.ts ?? envelope.sentAt;
    const endedAt =
      envelope.events[envelope.events.length - 1]?.ts ?? envelope.sentAt;

    // The rrweb blob (Mongo) is independent of the Postgres FK chain, so start
    // it concurrently with endUser→session instead of blocking on it first.
    const mongoP = this.writeMongoBatch(
      envelope,
      startedAt,
      endedAt,
      workspaceId,
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
      sessionPublicId,
      endUserId,
      envelope,
      startedAt,
      endedAt,
      fingerprint,
      ip,
      geoCountry,
      hasRealIdentity,
    });
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
    const chProjection = this.projectToClickhouse(
      workspaceId,
      sessionRow.id,
      sessionPublicId,
      envelope,
    );
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
          sessionRow.id,
          identify.customProps as Record<string, unknown>,
        );
      }
      await this.upsertPaths(sessionRow.id, envelope);
      const mongoBatchId = await mongoP;
      await this.upsertSegment(
        sessionRow.id,
        envelope,
        startedAt,
        endedAt,
        mongoBatchId,
      );
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
    //    tail so the job doesn't complete until the insert has run.
    if ((process.env.CLICKHOUSE_BATCH_INSERT ?? "1") === "1") {
      void chProjection.catch((e) => {
        process.stderr.write(
          `ch projection failed for session ${sessionRow.id}: ${(e as Error).message}\n`,
        );
      });
      await pgTail;
    } else {
      await Promise.all([chProjection, pgTail]);
    }

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
  }

  private async writeMongoBatch(
    envelope: ReplayBatchEnvelope,
    startedAt: number,
    endedAt: number,
    workspaceId: number,
  ) {
    // Scope the existing-check by projectId (= this workspace) so a colliding
    // sessionId+sequence from ANOTHER workspace can never be found and
    // overwritten here — each workspace keeps its own batch. (Matches the
    // [projectId, sessionId, sequence] unique key.)
    const existing = await this.mongo.replayBatch.findFirst({
      where: {
        projectId: String(workspaceId),
        sessionId: envelope.sessionId,
        sequence: envelope.sequence,
      },
    });
    if (existing) {
      const updated = await this.mongo.replayBatch.update({
        where: { id: existing.id },
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
      });
      return updated.id;
    }
    const created = await this.mongo.replayBatch.create({
      data: {
        projectId: String(workspaceId),
        sessionId: envelope.sessionId,
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
          .map((p) => p[0])
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
        utmSource: q.get("utm_source"),
        utmMedium: q.get("utm_medium"),
        utmCampaign: q.get("utm_campaign"),
      };
    } catch {
      return empty;
    }
  }

  private async upsertSession(args: {
    workspaceId: number;
    sessionPublicId: string;
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
  }, retriedOnConflict = false): Promise<Session & { claimAnonymous: boolean }> {
    const counts = ReplayPersistenceService.countEvents(args.envelope.events);
    const status: SessionStatus =
      Date.now() - args.endedAt < LIVE_THRESHOLD_MS ? "LIVE" : "COMPLETED";
    // Measure the raw JSON payload size for storage accounting. Cheap —
    // we're already serialising the events when we write to Mongo.
    const dataSize = BigInt(
      Buffer.byteLength(JSON.stringify(args.envelope.events), "utf8"),
    );
    const existing = await this.db.session.findUnique({
      where: { publicId: args.sessionPublicId },
    });
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
        perfUpdate.longTaskCount = { increment: counts.perf.longTaskCount };
        perfUpdate.longTaskTotalMs = { increment: counts.perf.longTaskTotalMs };
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
      if (np.frozenFrameCount > 0) {
        perfUpdate.frozenFrameCount = { increment: np.frozenFrameCount };
      }
      if (np.anrCount > 0) {
        perfUpdate.anrCount = { increment: np.anrCount };
      }
      // Bump workspace storage + (if the session is transitioning from
      // LIVE to COMPLETED, decrement live counter). Counters update
      // out-of-band so a failure here can't undo the session update.
      const liveDelta =
        existing.status === "LIVE" && status === "COMPLETED" ? -1 : 0;
      this.stats
        .bump(args.workspaceId, {
          storageBytes: dataSize,
          liveSessions: liveDelta,
        })
        .catch(() => {});
      // setMetadata() traits → session properties (only when present, so no
      // extra write on ordinary batches).
      if (Object.keys(counts.sessionProps).length > 0) {
        await mergeSessionCustomProps(this.db, existing.id, counts.sessionProps);
      }
      const updatedRow = await this.db.session.update({
        where: { id: existing.id },
        data: {
          endedAt: new Date(args.endedAt),
          durationMs: Math.max(0, args.endedAt - existing.startedAt.getTime()),
          clickCount: { increment: counts.click },
          rageCount: { increment: counts.rage },
          errorCount: { increment: counts.error },
          deadCount: { increment: counts.dead },
          consoleCount: { increment: counts.console },
          consoleErrorCount: { increment: counts.consoleError },
          networkCount: { increment: counts.network },
          tapCount: { increment: counts.tap },
          nativeSnapshotCount: { increment: counts.nativeSnapshot },
          frameCount: { increment: counts.frames },
          // A session becomes playable once ANY batch carried a full snapshot;
          // once true it stays true (never flip back on a later frame-less batch).
          ...(counts.fullSnapshot && !existing.hasFullSnapshot
            ? { hasFullSnapshot: true }
            : {}),
          dataSizeBytes: { increment: dataSize },
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
      return { ...updatedRow, claimAnonymous };
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
          durationMs: Math.max(0, args.endedAt - args.startedAt),
          pageCount: 1,
          clickCount: counts.click,
          rageCount: counts.rage,
          errorCount: counts.error,
          deadCount: counts.dead,
          consoleCount: counts.console,
          consoleErrorCount: counts.consoleError,
          networkCount: counts.network,
          tapCount: counts.tap,
          nativeSnapshotCount: counts.nativeSnapshot,
          hasFullSnapshot: counts.fullSnapshot,
          frameCount: counts.frames,
          dataSizeBytes: dataSize,
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
          longTaskCount: counts.perf.longTaskCount,
          longTaskTotalMs: counts.perf.longTaskTotalMs,
          longTaskSlowestMs: counts.perf.longTaskSlowestMs,
          peakHeapBytes: BigInt(counts.perf.peakHeapBytes),
          // Native vitals — null/0 for web sessions, populated for
          // iOS / Android / Flutter / RN sessions.
          coldStartMs: counts.nativePerf.coldStartMs,
          firstMeaningfulRenderMs: counts.nativePerf.firstMeaningfulRenderMs,
          worstTapResponseMs: counts.nativePerf.tapResponseMs,
          firstNetworkTtfbMs: counts.nativePerf.firstNetworkTtfbMs,
          worstFrameDropPct: counts.nativePerf.frameDropPctX100,
          frozenFrameCount: counts.nativePerf.frozenFrameCount,
          anrCount: counts.nativePerf.anrCount,
          worstMemoryRssMb: counts.nativePerf.memoryRssMb,
          worstThermalState: counts.nativePerf.thermalState,
          batteryDrainPctPerMin: counts.nativePerf.batteryDrainPctX100,
        },
      });
    } catch (e) {
      // Concurrency race lost: another batch created this publicId between our
      // findUnique and this create. Re-run ONCE — the retry finds the row and
      // takes the update path. The guard stops a genuine repeated failure (or a
      // different unique violation) from looping.
      if (
        !retriedOnConflict &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        return this.upsertSession(args, true);
      }
      throw e;
    }
    // Create WON the race → bump the workspace counters now, so a lost create
    // race never over-counts sessionsTotal (the winner bumps its own; update-path
    // batches bump storage separately, above).
    this.stats
      .bump(args.workspaceId, {
        sessionsTotal: 1,
        liveSessions: status === "LIVE" ? 1 : 0,
        storageBytes: dataSize,
      })
      .catch(() => {});
    // setMetadata() traits present on the FIRST batch (create) — merge them too.
    if (Object.keys(counts.sessionProps).length > 0) {
      await mergeSessionCustomProps(
        this.db,
        createdRow.id,
        counts.sessionProps,
      );
    }
    return { ...createdRow, claimAnonymous };
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

  private async upsertSegment(
    sessionId: number,
    envelope: ReplayBatchEnvelope,
    startedAt: number,
    endedAt: number,
    mongoBatchId: string,
  ) {
    await this.db.sessionSegment.upsert({
      where: { sessionId_sequence: { sessionId, sequence: envelope.sequence } },
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
  }

  private async upsertPaths(sessionId: number, envelope: ReplayBatchEnvelope) {
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
    await this.db.session.update({
      where: { id: sessionId },
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
          sessionProps[data.key.slice(0, 80)] =
            typeof data.value === "string" ? data.value.slice(0, 500) : "";
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
      perf: {
        lcp: lcpThisBatch || null,
        clsX1000: clsThisBatch > 0 ? Math.round(clsThisBatch * 1000) : null,
        fid: fidThisBatch || null,
        inp: inpThisBatch || null,
        fcp: fcpThisBatch || null,
        ttfb: ttfbThisBatch || null,
        longTaskCount: longTaskCountThisBatch,
        longTaskTotalMs: Math.round(longTaskTotalThisBatch),
        longTaskSlowestMs: Math.round(longTaskSlowestThisBatch),
        peakHeapBytes: Math.round(peakHeapThisBatch),
      },
      nativePerf: {
        coldStartMs: coldStartThisBatch,
        firstMeaningfulRenderMs: firstMeaningfulRenderThisBatch || null,
        tapResponseMs: tapResponseThisBatch || null,
        firstNetworkTtfbMs: firstNetworkTtfbThisBatch,
        frameDropPctX100: frameDropPctX100ThisBatch || null,
        frozenFrameCount: frozenFrameCountThisBatch,
        anrCount: anrCountThisBatch,
        memoryRssMb: memoryRssThisBatch || null,
        thermalState: thermalStateThisBatch || null,
        batteryDrainPctX100: batteryDrainPctX100ThisBatch || null,
      },
    };
  }

  // We delegate UA parsing to `ua-parser-js` — it handles iOS Safari
  // masquerade, iPad-on-iPadOS reporting Mac, modern Edge ("Edg/"),
  // Chrome on Safari etc. The viewport-width fallback covers cases
  // where the UA is missing or stripped.
}
