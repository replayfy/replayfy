import { Injectable } from "@nestjs/common";
import { getPostgresClient } from "@replay/db-postgres";
import { FramesArchiveService } from "../frames/frames-archive.service";
import { FramesStreamService } from "../frames/frames-stream.service";

/** GET /frames: the session's frames archive, or why there is none yet. */
export interface FramesManifest {
  /** The archive, or null: no frames (yet), or storage disabled. */
  url: string | null;
  count: number;
  startedAt: number;
  fileFormat: string;
  /**
   * More frames may still come: the session is LIVE, or a frames finalize is
   * pending for it (see FramesStreamService.pendingFinalize) — or overdue,
   * while the session is less than 2.5 days old: the LIVE sweep has listed it
   * without its archive, but a retried finalize can still store one. With url
   * null, the player can show "processing" and ask again, rather than "no
   * snapshots"; with a url, the archive plays and a newer one is on its way
   * (a session that resumed after it was finalized).
   */
  pending: boolean;
}

/**
 * Serves the per-session frames archive for mobile (iOS / Android).
 *
 * The SDK's `/v1/mobile/images` batches land in a Redis stream; the frames
 * worker gzip-streams them to R2 as a single `frames/{id}.frames.gz`, completed
 * at session end. This endpoint just resolves that pre-built object's URL — the
 * browser fetches + gunzips it DIRECTLY from R2 (edge-served, cached); the API
 * is never in the data path and nothing is rebuilt on read.
 *
 * The url is null until the session has been finalized (still recording, or
 * the finalize tick hasn't reached a just-ended session yet), and for a session
 * with no frames at all; `pending` tells those apart.
 */
@Injectable()
export class MobileFramesService {
  private readonly db = getPostgresClient();

  constructor(
    private readonly frames: FramesArchiveService,
    private readonly stream: FramesStreamService,
  ) {}

  /** Not found (no such session in this workspace): nothing to wait for. */
  private static readonly NONE: FramesManifest = {
    url: null,
    count: 0,
    startedAt: 0,
    fileFormat: "jpeg",
    pending: false,
  };

  /** How long past its start an overdue frames finalize still reads as "being
   *  processed": the reference tracker's player keeps that copy until a session
   *  is more than 2 days old rounded to the nearest day, i.e. 2.5 days. */
  private static readonly PROCESSING_MAX_AGE_MS = 60 * 60 * 60_000; // 2.5 days

  async getFrames(
    workspaceId: number,
    publicId: string,
  ): Promise<FramesManifest> {
    // The expiry score is read BEFORE the row. A finalize records the archive
    // on the row (nativeSnapshotCount) and only then removes the score
    // (FramesFinalizerService.finalize, then cleanup), so when this read finds
    // no score, any finalize that removed it has already written the row read
    // below. Read the other way round, a retried finalize landing between the
    // two reads looked like a session with no frames (url null, not pending).
    //
    // Access pattern: one ZSCORE on the session:expiry ZSET for this one id
    // (O(log N), see FramesStreamService.pendingFinalize) — the read this
    // endpoint already made, now also for a LIVE session; no new query, no
    // index change.
    const now = Date.now();
    const states = await this.stream.pendingFinalize([publicId], now);

    // Access pattern: one row by the unique publicId (plus the tenant check),
    // the read this endpoint always made; `status` rides along in it.
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
      select: {
        status: true,
        startedAt: true,
        clockSkewMs: true,
        nativeSnapshotCount: true,
      },
    });
    if (!session) return { ...MobileFramesService.NONE };

    // A LIVE session is pending by its status alone; otherwise its expiry
    // score says whether a finalize is still to come — a session that resumed
    // after it was finalized, one the finalizer completed a moment before it
    // removed the score, or one the LIVE sweep completed because its finalize
    // is overdue. An OVERDUE score still counts as pending here:
    // FINALIZE_OVERDUE_MAX_MS only bounds how long the LIVE sweep keeps the
    // row unlisted, and a retried finalize can still store the archive.
    // Bounded by session age so a finalize that never succeeds (or a
    // deployment with no finalizer running) stops reading as "being
    // processed".
    const pending =
      session.status === "LIVE" ||
      states.pending.has(publicId) ||
      (states.overdue.has(publicId) &&
        now - session.startedAt.getTime() <
          MobileFramesService.PROCESSING_MAX_AGE_MS);

    // Readiness gate: the finalizer writes nativeSnapshotCount in the same step
    // it completes the R2 upload, so count > 0 ⟺ frames/{id}.frames.gz exists.
    // Gating on the row we already loaded avoids an R2 HEAD on every request.
    const count = session.nativeSnapshotCount ?? 0;
    if (count <= 0) return { ...MobileFramesService.NONE, pending };

    const url = this.frames.archiveUrl(publicId);
    // Storage disabled (local dev): no archive to serve.
    if (!url) return { ...MobileFramesService.NONE, pending };

    // Cache-bust on frame count. The archive lives at a CONSTANT object key
    // (frames/{id}.frames.gz). It's normally written once at finalize, but a
    // crash-recovery re-finalize can overwrite the same key; R2's edge caches
    // by full URL incl. query string, so keying ?v= on the snapshot count makes
    // any rewrite a fresh cache entry instead of serving a stale archive.
    const bustedUrl = `${url}${url.includes("?") ? "&" : "?"}v=${count}`;

    return {
      url: bustedUrl,
      count,
      // Frame timestamps are on the device clock, so the player's base is the
      // device's own start (startedAt is server time when the clock was off).
      startedAt: session.startedAt.getTime() + Number(session.clockSkewMs ?? 0n),
      // SDK frames are JPEG (the reference format); the player decodes by
      // magic bytes anyway.
      fileFormat: "jpeg",
      pending,
    };
  }
}
