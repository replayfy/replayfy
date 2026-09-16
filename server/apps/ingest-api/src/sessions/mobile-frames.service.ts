import { Injectable } from "@nestjs/common";
import { getPostgresClient } from "@replay/db-postgres";
import { FramesArchiveService } from "../frames/frames-archive.service";

/**
 * Serves the per-session frames archive for mobile (iOS / Android).
 *
 * The SDK's `/v1/mobile/images` batches land in a Redis stream; the frames
 * worker gzip-streams them to R2 as a single `frames/{id}.frames.gz`, completed
 * at session end. This endpoint just resolves that pre-built object's URL — the
 * browser fetches + gunzips it DIRECTLY from R2 (edge-served, cached); the API
 * is never in the data path and nothing is rebuilt on read.
 *
 * Returns null until the session has been finalized (still recording, or the
 * finalize tick hasn't reached a just-ended session yet).
 */
@Injectable()
export class MobileFramesService {
  private readonly db = getPostgresClient();

  constructor(private readonly frames: FramesArchiveService) {}

  async getFrames(
    workspaceId: number,
    publicId: string,
  ): Promise<{
    url: string;
    count: number;
    startedAt: number;
    fileFormat: string;
  } | null> {
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
      select: { startedAt: true, nativeSnapshotCount: true },
    });
    if (!session) return null;

    // Readiness gate: the finalizer writes nativeSnapshotCount in the same step
    // it completes the R2 upload, so count > 0 ⟺ frames/{id}.frames.gz exists.
    // Gating on the row we already loaded avoids an R2 HEAD on every request;
    // null here is the player's "not ready" state (still recording, or the
    // finalize tick hasn't reached a just-ended session yet).
    const count = session.nativeSnapshotCount ?? 0;
    if (count <= 0) return null;

    const url = this.frames.archiveUrl(publicId);
    if (!url) return null; // storage disabled (local dev) — no archive to serve

    // Cache-bust on frame count. The archive lives at a CONSTANT object key
    // (frames/{id}.frames.gz). It's normally written once at finalize, but a
    // crash-recovery re-finalize can overwrite the same key; R2's edge caches
    // by full URL incl. query string, so keying ?v= on the snapshot count makes
    // any rewrite a fresh cache entry instead of serving a stale archive.
    const bustedUrl = `${url}${url.includes("?") ? "&" : "?"}v=${count}`;

    return {
      url: bustedUrl,
      count,
      startedAt: session.startedAt.getTime(),
      // SDK frames are JPEG (the reference format); the player decodes by
      // magic bytes anyway.
      fileFormat: "jpeg",
    };
  }
}
