import { Injectable } from "@nestjs/common";
import { StorageService } from "../storage/storage.service";
import { framesGzKey } from "./frames.constants";

/**
 * Replay READ path — PURE: resolve the single pre-built `frames/{sid}.frames.gz`
 * URL. The browser fetches + gunzips it DIRECTLY from R2; the API is never in
 * the data path and nothing is rebuilt on read.
 *
 * Readiness ("does the archive exist yet?") is NOT checked here with an R2 HEAD
 * — the caller gates on the session's nativeSnapshotCount, which the finalizer
 * writes in the same step it completes the upload (count > 0 ⟺ object exists),
 * so we skip a network round-trip on every replay request. This is just URL
 * construction; it returns null only when storage is disabled (local dev with
 * no R2), preserving the legacy "no archive" behaviour there.
 */
@Injectable()
export class FramesArchiveService {
  constructor(private readonly storage: StorageService) {}

  archiveUrl(sid: string): string | null {
    if (!this.storage.enabled) return null;
    return this.storage.publicUrl(framesGzKey(sid));
  }
}
