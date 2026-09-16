import {
  Body,
  Controller,
  Headers,
  Ip,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import type {
  ReplayBatchEnvelope,
  ReplayIngestResponse,
} from "@replay/replay-schema";
import { ReplayIngestService } from "./replay-ingest.service";
import { SkipThrottle } from "@nestjs/throttler";
import { StorageService } from "../storage/storage.service";

interface ReplayBatchBody {
  envelope: ReplayBatchEnvelope;
  fingerprint?: string;
  identify?: {
    distinctId?: string;
    email?: string;
    name?: string;
    plan?: string;
    /** Avatar URL — `picture` (our key) or `avatar` (reference alias); may also
     *  arrive under customProps. Persistence URL-validates it into EndUser.picture. */
    picture?: string;
    avatar?: string;
    customProps?: Record<string, unknown>;
  };
}

// High-volume ingest: exempt from the global HTTP throttle (protected by the
// queue/backpressure layer, not per-IP request limits).
@SkipThrottle()
@Controller("v1/replay")
export class ReplayIngestController {
  constructor(
    private readonly replayIngestService: ReplayIngestService,
    private readonly storage: StorageService,
  ) {}

  @Post("batch")
  async ingestBatch(
    @Headers("x-replay-api-key") headerKey: string | undefined,
    // navigator.sendBeacon (the unload/pagehide path) CANNOT set request headers,
    // so the SDK passes the key as `?k=` there. Accept it as a fallback to the
    // header — without this, EVERY final unload batch 401s and the session's
    // closing frames never persist (a blank/frozen replay tail). Header wins when
    // both are present (the normal fetch path).
    @Query("k") queryKey: string | undefined,
    @Headers("x-forwarded-for") forwardedFor: string | undefined,
    // Cloudflare's authoritative country for the client IP (the API sits behind
    // CF). More reliable than geoip-lite, whose free DB can pair a city with a
    // different country on VPN/datacenter IPs. Absent when not behind CF.
    @Headers("cf-ipcountry") cfCountry: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("referer") referer: string | undefined,
    @Ip() ip: string,
    @Req() req: Request,
    @Body() body: ReplayBatchBody | ReplayBatchEnvelope,
  ): Promise<ReplayIngestResponse> {
    const apiKey = headerKey || queryKey;
    // Accept either a raw envelope (legacy) or { envelope, identify, fingerprint } (current SDK).
    const isRawEnvelope = "events" in body && "sessionId" in body;
    const envelope: ReplayBatchEnvelope = isRawEnvelope
      ? (body as ReplayBatchEnvelope)
      : (body as ReplayBatchBody).envelope;
    const identify = isRawEnvelope
      ? undefined
      : (body as ReplayBatchBody).identify;
    const fingerprint = isRawEnvelope
      ? undefined
      : (body as ReplayBatchBody).fingerprint;
    const clientIp =
      forwardedFor?.split(",")[0]?.trim() ||
      ip ||
      (req.socket?.remoteAddress ?? undefined);
    return this.replayIngestService.ingestBatch(apiKey, envelope, {
      ip: clientIp,
      geoCountry: cfCountry,
      identify,
      fingerprint,
      origin: origin ?? referer,
    });
  }

  /**
   * Symbol upload — accepts R8 `mapping.txt` (Android JVM) or
   * unstripped `.so` debug binaries (Android NDK per ABI) for a
   * specific app version. Used by the customer's build pipeline
   * (Gradle plugin `com.replayfy.symbols` or manual CI step) so
   * the backend can deobfuscate crash + ANR stacks on the
   * dashboard.
   *
   * Key shape: `replay-symbols/<workspaceId>/<platform>/<version>/<build>/<filename>`
   *   - platform ∈ {"android", "ios"} (iOS dSYMs reserved for v2)
   *   - filename ∈ {"mapping.txt", "lib<name>.<abi>.so"}
   *   - per-ABI suffix lets the symbolicator pick the right binary
   *     for an arm64-v8a vs x86_64 crash
   *
   * Idempotent — re-uploads of the SAME (version, build, filename)
   * overwrite. Per-version retention is permanent (crashes from
   * old releases keep arriving for a long tail).
   *
   * Auth via x-replay-api-key. Body is a base64 data URL so we can
   * stay JSON-only (no multipart machinery) — same shape as the
   * existing asset / thumbnail endpoints. Caps the payload at 50 MB
   * decoded (mapping.txt can run a few MB, .so debug binaries can run
   * 20-50 MB for large apps). base64 inflates ~4/3, so this route is
   * mounted with a dedicated 80 MB json() body-parser limit in
   * bootstrap.ts — the global 25 MB limit would 413 a large .so before
   * this ceiling could bind, so the two are coordinated there.
   */
  @Post("symbols/:platform/:version/:build/:filename")
  async uploadSymbols(
    @Headers("x-replay-api-key") apiKey: string,
    @Param("platform") platform: string,
    @Param("version") version: string,
    @Param("build") build: string,
    @Param("filename") filename: string,
    @Body() body: { dataUrl?: string },
  ): Promise<{ ok: boolean; url: string | null }> {
    if (!body?.dataUrl) return { ok: false, url: null };
    // Whitelist platform — keeps the bucket layout predictable.
    if (platform !== "android" && platform !== "ios") {
      return { ok: false, url: null };
    }
    // version + build come from app metadata; we accept anything
    // a customer might use (semver, calver, build-number strings)
    // but block path-traversal characters + cap length.
    const segmentOk = (s: string) =>
      /^[A-Za-z0-9._+-]{1,80}$/.test(s);
    if (!segmentOk(version) || !segmentOk(build)) {
      return { ok: false, url: null };
    }
    // Filename whitelist — accept mapping.txt (R8) or
    // libNAME[.ARCH].so (NDK debug binaries). Reject anything else
    // so the bucket doesn't collect arbitrary garbage.
    const filenameOk =
      filename === "mapping.txt" ||
      /^lib[A-Za-z0-9_]+\.(arm64-v8a|armeabi-v7a|x86|x86_64)\.so$/.test(
        filename,
      );
    if (!filenameOk) return { ok: false, url: null };
    if (!this.storage.enabled) return { ok: false, url: null };

    const workspaceId =
      await this.replayIngestService.resolveWorkspaceId(apiKey);
    if (!workspaceId) return { ok: false, url: null };

    const decoded = this.storage.decodeDataUrl(body.dataUrl);
    if (!decoded) return { ok: false, url: null };
    // 50 MB decoded ceiling — generous for production-size mapping.txt +
    // mid-sized NDK debug binaries. Anything larger probably means the build
    // pipeline forgot to strip third-party symbols and would be more cost than
    // value. This is the intended, reachable gate: the route's dedicated 80 MB
    // json() limit (bootstrap.ts) lets a ~67 MB base64 body for a 50 MB symbol
    // through so this check — not a generic parser 413 — is what binds. Throw a
    // clear 413 so an oversized upload is distinguishable from a parser
    // rejection and the build pipeline gets an actionable message.
    if (decoded.body.byteLength > 50_000_000) {
      throw new PayloadTooLargeException(
        `Symbol exceeds the 50 MB limit (got ${(
          decoded.body.byteLength / 1_000_000
        ).toFixed(1)} MB). Strip third-party / unneeded debug symbols before upload.`,
      );
    }

    const key = `replay-symbols/${workspaceId}/${platform}/${version}/${build}/${filename}`;
    const url = await this.storage.upload({
      key,
      body: decoded.body,
      contentType: decoded.contentType || "application/octet-stream",
    });
    if (!url) return { ok: false, url: null };
    return { ok: true, url };
  }
}
