import { Injectable } from "@nestjs/common";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "stream";

/**
 * S3-compatible object storage wrapper (@aws-sdk/client-s3). Works with any
 * S3-compatible backend — Cloudflare R2 (cloud) or MinIO / SeaweedFS / plain
 * S3 (self-host) — by pointing the endpoint at it.
 *
 * Config resolves generic `S3_*` names FIRST, then falls back to the legacy
 * `R2_*` names, so the cloud build (which sets `R2_*`) is unchanged and a
 * self-hoster uses the neutral `S3_*` names:
 *   S3_ENDPOINT           — full endpoint URL. If unset, derived from
 *                           R2_ACCOUNT_ID as https://<id>.r2.cloudflarestorage.com
 *   S3_ACCESS_KEY_ID      — (fallback R2_ACCESS_KEY_ID)
 *   S3_SECRET_ACCESS_KEY  — (fallback R2_SECRET_ACCESS_KEY)
 *   S3_BUCKET             — (fallback R2_BUCKET)
 *   S3_PUBLIC_BASE_URL    — public URL prefix the BROWSER fetches assets from
 *                           (fallback R2_PUBLIC_BASE_URL). For MinIO path-style
 *                           this includes the bucket, e.g. http://localhost:9002/replayfy
 *   S3_REGION             — default "auto" (R2). MinIO/S3 usually "us-east-1".
 *   S3_FORCE_PATH_STYLE   — "true" for MinIO (bucket in the path, not a subdomain).
 *
 * Anything missing → service runs in "disabled" mode and `upload()` returns
 * null. The dashboard's fallback rebuild path keeps working in that case, so
 * local dev without storage set up still functions.
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client | null;
  private readonly bucket: string;
  private readonly publicBase: string;
  readonly enabled: boolean;

  constructor() {
    const accessKeyId =
      process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey =
      process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;
    // Endpoint: explicit S3_ENDPOINT (MinIO / S3) wins; otherwise derive the R2
    // endpoint from the account id (keeps the cloud build's zero-config R2 path).
    const accountId = process.env.R2_ACCOUNT_ID;
    const endpoint =
      process.env.S3_ENDPOINT ||
      (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
    const region = process.env.S3_REGION || "auto";
    const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";
    this.bucket = process.env.S3_BUCKET || process.env.R2_BUCKET || "";
    this.publicBase = (
      process.env.S3_PUBLIC_BASE_URL ||
      process.env.R2_PUBLIC_BASE_URL ||
      ""
    ).replace(/\/$/, "");

    this.enabled = !!(
      endpoint &&
      accessKeyId &&
      secretAccessKey &&
      this.bucket &&
      this.publicBase
    );

    if (this.enabled) {
      this.client = new S3Client({
        // "auto" for R2 (region is meaningless there but the SDK needs a value);
        // a real region for MinIO/S3 via S3_REGION.
        region,
        endpoint,
        // MinIO (and most self-hosted S3) need path-style addressing unless
        // bucket-subdomain DNS is set up; R2 uses virtual-hosted (default false).
        forcePathStyle,
        credentials: {
          accessKeyId: accessKeyId!,
          secretAccessKey: secretAccessKey!,
        },
      });
    } else {
      this.client = null;
      process.stderr.write(
        "[storage] object storage not configured (set S3_* or R2_* env) — asset uploads will be skipped.\n",
      );
    }
  }

  /**
   * Upload an object and return its public URL. `body` may be a Buffer,
   * Uint8Array, or string. Caller is responsible for content-type +
   * cache-control hints; we set sensible defaults.
   *
   * Returns null when storage is disabled (no R2 env), so the caller can
   * silently fall through to whatever the legacy path used to do.
   */
  async upload(opts: {
    key: string;
    body: Buffer | Uint8Array | string;
    contentType?: string;
    cacheControl?: string;
  }): Promise<string | null> {
    if (!this.enabled || !this.client) return null;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: opts.key,
        Body: opts.body,
        ContentType: opts.contentType ?? "application/octet-stream",
        // Thumbnails are content-addressed by sessionPublicId, so they're
        // immutable per session — cache aggressively. CDN + browser keep
        // them for a year. If we ever need to invalidate, rotate the key.
        CacheControl:
          opts.cacheControl ?? "public, max-age=31536000, immutable",
      }),
    );
    return `${this.publicBase}/${opts.key}`;
  }

  /**
   * Decode a data URL ("data:image/png;base64,…") into bytes + mime.
   * Returns null when the input isn't a valid data URL — guard against
   * SDK / dashboard sending raw text or a regular URL by accident.
   */
  decodeDataUrl(dataUrl: string): { body: Buffer; contentType: string } | null {
    const match = /^data:([^;,]+)(?:;[^,]+)?,(.+)$/.exec(dataUrl.trim());
    if (!match) return null;
    const contentType = match[1] || "application/octet-stream";
    const payload = match[2];
    // Data URLs are typically base64 but can also be URL-encoded text.
    // We only support base64 here — that's all the browser produces from
    // canvas.toDataURL().
    if (!dataUrl.includes(";base64,")) return null;
    try {
      return { body: Buffer.from(payload, "base64"), contentType };
    } catch {
      return null;
    }
  }

  /**
   * Download an object's bytes. Returns null when:
   *   - storage is disabled (no R2 env)
   *   - the object doesn't exist (404 / NoSuchKey)
   *   - any other R2 error (logged + swallowed)
   *
   * Used by the symbolication service to fetch uploaded mapping.txt
   * + .so debug binaries on demand. Caller is responsible for
   * caching — we don't memoize here because the symbolicator already
   * holds a per-version disk cache.
   */
  async download(key: string): Promise<Buffer | null> {
    if (!this.enabled || !this.client) return null;
    try {
      const resp = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      // resp.Body is a readable stream on Node 18+; SDK v3
      // provides .transformToByteArray() for the common buffer
      // case. Fall back to manual stream-read if the helper
      // isn't present (older SDK versions).
      const body = resp.Body as
        | { transformToByteArray?: () => Promise<Uint8Array> }
        | undefined;
      if (body?.transformToByteArray) {
        const bytes = await body.transformToByteArray();
        return Buffer.from(bytes);
      }
      // Fallback — accumulate the stream manually.
      const chunks: Buffer[] = [];
      // @ts-expect-error — older SDK doesn't type Body as AsyncIterable
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      const e = err as { name?: string; Code?: string };
      // 404s are the common case (mapping.txt not uploaded for this
      // version). Log at debug only — they're expected.
      if (e?.name !== "NoSuchKey" && e?.Code !== "NoSuchKey") {
        process.stderr.write(
          `[storage] download(${key}) failed: ${String(err)}\n`,
        );
      }
      return null;
    }
  }

  /** Best-effort delete. Used by the workspace-delete pipeline. */
  async remove(key: string): Promise<void> {
    if (!this.enabled || !this.client) return;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch {
      /* swallow — storage cleanup is best-effort */
    }
  }

  /**
   * Delete EVERY object under a key prefix — for workspace teardown, where the
   * object keys aren't individually known (unlike a session's single frames
   * archive). Paginates ListObjectsV2 and bulk-deletes each page with
   * DeleteObjects (up to 1000 keys/call), so a workspace with many symbol
   * uploads costs O(objects/1000) requests, not one-per-object.
   *
   * Best-effort like remove(): a teardown must not fail because storage cleanup
   * hiccuped. Returns the number of objects deleted (0 when disabled).
   *
   * Callers MUST pass a tenant-scoped prefix (e.g. `replay-symbols/<wsId>/`); a
   * too-broad prefix would delete another tenant's objects.
   */
  async removePrefix(prefix: string): Promise<number> {
    if (!this.enabled || !this.client || !prefix) return 0;
    let deleted = 0;
    let token: string | undefined;
    try {
      do {
        const listed = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        const keys =
          listed.Contents?.map((o) => o.Key).filter(
            (k): k is string => !!k,
          ) ?? [];
        if (keys.length) {
          const resp = await this.client.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          // DeleteObjects returns HTTP 200 even on PARTIAL failure — failed keys
          // come back in `Errors` (with Quiet:true, ONLY errors are returned), not
          // as a thrown exception. Count what ACTUALLY deleted so the caller's log
          // can't claim success over objects still orphaned in R2.
          deleted += keys.length - (resp.Errors?.length ?? 0);
        }
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (token);
    } catch {
      /* swallow — storage cleanup is best-effort */
    }
    return deleted;
  }

  /**
   * Map a public object URL back to its R2 key. Returns null when the
   * URL doesn't sit under our configured public base (e.g. an asset
   * served from a different host). Lets callers prefer the
   * credentialed `download()` path over a public HTTP egress.
   */
  keyFromPublicUrl(url: string): string | null {
    if (!this.publicBase) return null;
    const prefix = `${this.publicBase}/`;
    if (!url.startsWith(prefix)) return null;
    const key = url.slice(prefix.length);
    return key.length > 0 ? key : null;
  }

  /**
   * HEAD an object by key; returns its public URL if it exists, else
   * null. Used as a cheap cache-existence check (no body transfer)
   * before rebuilding a derived artifact like the frames archive.
   */
  async headPublicUrl(key: string): Promise<string | null> {
    if (!this.enabled || !this.client) return null;
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return `${this.publicBase}/${key}`;
    } catch {
      return null;
    }
  }

  /** Public URL for a key (no existence check). */
  publicUrl(key: string): string {
    return `${this.publicBase}/${key}`;
  }

  /**
   * Stream an object to R2 with constant memory (multipart under the hood
   * via @aws-sdk/lib-storage) — the frames archive is gzip-streamed straight
   * from disk to R2 at session end without buffering the whole file. Returns
   * the public URL, or null when storage is disabled.
   */
  async uploadStream(opts: {
    key: string;
    body: Readable;
    contentType?: string;
    cacheControl?: string;
  }): Promise<string | null> {
    if (!this.enabled || !this.client) return null;
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: opts.key,
        Body: opts.body,
        ContentType: opts.contentType ?? "application/octet-stream",
        CacheControl:
          opts.cacheControl ?? "public, max-age=31536000, immutable",
      },
    });
    await upload.done();
    return `${this.publicBase}/${opts.key}`;
  }

  // ── Multipart upload primitives ──────────────────────────────────────
  /**
   * Low-level multipart upload, used by the frames stream worker to push a
   * session's gzip stream to R2 part-by-part as frames arrive (no disk, no
   * wait-for-end). These wrap the raw S3 commands; the worker owns the
   * orchestration (part numbering, ETag tracking, completion) so the upload
   * can be resumed/rebuilt from the durable Redis stream after a reconnect.
   *
   * R2 (like S3) requires every part EXCEPT the last to be ≥5 MiB. The worker
   * enforces that by buffering gzip output to the threshold before flushing a
   * part; the final part at finalize() has no minimum.
   *
   * All four no-op (return null/skip) when storage is disabled, so local dev
   * without R2 still runs — the worker simply produces no archive.
   */
  async createMultipartUpload(
    key: string,
    contentType = "application/octet-stream",
  ): Promise<string | null> {
    if (!this.enabled || !this.client) return null;
    const resp = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    return resp.UploadId ?? null;
  }

  /** Upload one part; returns the ETag the worker must keep for completion. */
  async uploadPart(opts: {
    key: string;
    uploadId: string;
    partNumber: number;
    body: Buffer;
  }): Promise<string | null> {
    if (!this.enabled || !this.client) return null;
    const resp = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: opts.key,
        UploadId: opts.uploadId,
        PartNumber: opts.partNumber,
        Body: opts.body,
      }),
    );
    return resp.ETag ?? null;
  }

  /**
   * Assemble the uploaded parts into the final object and return its public
   * URL. Only after this call does the object exist / become readable at
   * `key` — parts are staged until completion. `parts` must be in ascending
   * PartNumber order with the ETags returned by uploadPart().
   */
  async completeMultipartUpload(opts: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<string | null> {
    if (!this.enabled || !this.client) return null;
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: opts.key,
        UploadId: opts.uploadId,
        MultipartUpload: {
          Parts: opts.parts.map((p) => ({
            PartNumber: p.partNumber,
            ETag: p.etag,
          })),
        },
      }),
    );
    return `${this.publicBase}/${opts.key}`;
  }

  /** Best-effort abort — frees staged parts when a session's upload is
   *  discarded (worker takeover rebuilds from scratch, graceful shutdown). */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    if (!this.enabled || !this.client) return;
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch {
      /* swallow — abort is best-effort cleanup */
    }
  }
}
