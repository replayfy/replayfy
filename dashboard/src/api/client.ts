/**
 * HTTP client — mirrors the reference dashboard's contract exactly so every call
 * site stays thin: base URL from VITE_API_URL, a bearer JWT + x-workspace-id
 * header on every request, and a `{ ok, data|error, page? }` response envelope
 * that unwraps to `{ data, page, meta }` (or throws ApiError).
 */
import { reportReachable, reportUnreachable } from "./health";

// VITE_ vars are frozen into the bundle at BUILD time. A production build that
// forgets VITE_API_URL would otherwise silently bake in the localhost fallback,
// so every request hits the VISITOR's own machine and the app looks dead. Fail
// loud in that case (prod build only) rather than shipping a broken bundle; dev
// (import.meta.env.PROD === false) keeps the convenient localhost default.
const configuredApiUrl = import.meta.env.VITE_API_URL;
if (import.meta.env.PROD && !configuredApiUrl) {
  throw new Error(
    "VITE_API_URL is not set. A production build must be built with " +
      "VITE_API_URL=<prod ingest-api origin> in the build environment.",
  );
}
export const API_URL = configuredApiUrl || "http://127.0.0.1:4000";

const TOKEN_KEY = "replay:token";
const WORKSPACE_KEY = "replay:workspaceId";

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setWorkspaceId(id: number | null): void {
  if (id != null) localStorage.setItem(WORKSPACE_KEY, String(id));
  else localStorage.removeItem(WORKSPACE_KEY);
}
export function getWorkspaceId(): number | null {
  const raw = localStorage.getItem(WORKSPACE_KEY);
  return raw ? Number(raw) : null;
}

/* Where a user was when they last signed out. WORKSPACE_KEY above is the ACTIVE
   pointer and is dropped on logout; this outlives the session so signing back in
   returns you where you were rather than to whichever workspace happens to sort
   first.

   Keyed by user id, and that is the point: a shared browser must not hand the
   next person the previous one's workspace. The id is also the only safe key —
   the email would identify the account to whoever sits down next, which is the
   same disclosure logout already clears recents to avoid. A bare number tells an
   onlooker nothing.

   Never trusted on read: applyMe re-validates it against the user's memberships,
   so a workspace they've since been removed from just falls back. */
const LAST_WORKSPACE_PREFIX = "replay:lastWorkspace";
const lastWorkspaceKey = (userId: number) => `${LAST_WORKSPACE_PREFIX}:${userId}`;

export function setLastWorkspace(userId: number, id: number | null): void {
  if (id == null) localStorage.removeItem(lastWorkspaceKey(userId));
  else localStorage.setItem(lastWorkspaceKey(userId), String(id));
}
export function getLastWorkspace(userId: number): number | null {
  const raw = localStorage.getItem(lastWorkspaceKey(userId));
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(o: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
  }) {
    super(o.message);
    this.name = "ApiError";
    this.code = o.code;
    this.status = o.status;
    this.details = o.details;
  }
}

export type Page = {
  next_cursor?: string | null;
  has_more?: boolean;
  /** Rows on THIS page (page size) — not the workspace total. */
  count?: number;
  /** Workspace-wide total for the list, when the endpoint counts it (present
   *  on the first page only). Use this, not `count`, for header stats. */
  total?: number;
  total_capped?: boolean;
} | null;
export type ApiResult<T> = { data: T; page: Page; meta: unknown };
type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  page?: Page;
  meta?: unknown;
};

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type") && init.body)
    headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const wsId = getWorkspaceId();
  if (wsId) headers.set("x-workspace-id", String(wsId));
  // When VITE_API_URL points at an ngrok tunnel, skip ngrok's browser
  // interstitial so fetch() gets JSON, not the warning HTML. No-op locally.
  if (API_URL.includes("ngrok")) headers.set("ngrok-skip-browser-warning", "true");

  /* fetch only REJECTS when the request never landed — offline, DNS, connection
     refused, a failed CORS preflight. A 4xx/5xx RESOLVES and falls through to
     the envelope check below: a server answering with an error is a reachable
     server, and must not be reported as a network failure. AbortError is
     excluded — a cancelled request says nothing about reachability. */
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError")) {
      reportUnreachable();
    }
    throw e;
  }
  reportReachable();
  let body: ApiEnvelope<T> | null = null;
  if (response.status !== 204)
    body = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;

  if (!response.ok || !body || body.ok === false) {
    throw new ApiError({
      code: body?.error?.code ?? "NETWORK_ERROR",
      message: body?.error?.message ?? response.statusText,
      status: response.status,
      details: body?.error?.details,
    });
  }
  return {
    data: body.data as T,
    page: body.page ?? null,
    meta: body.meta ?? null,
  };
}

/**
 * Server-sent event stream over `fetch` (the backend's agent stream is a POST,
 * so EventSource can't be used). Frames arrive as `data: <JSON>\n\n` and
 * DELIBERATELY bypass the `{ok,data}` envelope — we split on the blank line,
 * strip the `data:` prefix, and hand each parsed frame to `onEvent`. Resolves
 * when the stream closes; pass an AbortSignal to cancel mid-flight.
 */
async function stream<E = unknown>(
  path: string,
  body: unknown,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  });
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const wsId = getWorkspaceId();
  if (wsId) headers.set("x-workspace-id", String(wsId));
  // When VITE_API_URL points at an ngrok tunnel, skip ngrok's browser
  // interstitial so fetch() gets JSON, not the warning HTML. No-op locally.
  if (API_URL.includes("ngrok")) headers.set("ngrok-skip-browser-warning", "true");

  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    signal,
  });

  // The error path still returns a JSON envelope; surface it as an ApiError.
  if (!response.ok || !response.body) {
    let err: ApiEnvelope<unknown> | null = null;
    try {
      err = (await response.json()) as ApiEnvelope<unknown>;
    } catch {
      /* body wasn't JSON */
    }
    throw new ApiError({
      code: err?.error?.code ?? "NETWORK_ERROR",
      message: err?.error?.message ?? response.statusText,
      status: response.status,
      details: err?.error?.details,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const payload = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!payload || payload === "[DONE]") continue;
        try {
          onEvent(JSON.parse(payload) as E);
        } catch {
          /* skip a malformed frame rather than killing the stream */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Authenticated file download. The CSV export is NOT the `{ok,data}` JSON
 * envelope — it's a streamed `text/csv` body — and its Bearer + x-workspace-id
 * auth lives in headers, so a plain `<a href download>` navigation can't carry
 * it. Fetch with the same auth `request` uses, then hand the Blob to a throwaway
 * anchor to trigger the browser's native "Save as". `filename` names the saved
 * file (a blob: URL can't read the server's Content-Disposition).
 *
 * The server streams in pages so ITS memory stays flat regardless of size; the
 * browser still buffers the whole Blob (the price of header auth). Fine for the
 * realistic tens-of-thousands-of-rows case (a few MB). If exports ever need to
 * scale past that, switch to a short-lived signed download token in the query
 * so a bare navigation can stream straight to disk.
 */
async function download(path: string, filename: string): Promise<void> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const wsId = getWorkspaceId();
  if (wsId) headers.set("x-workspace-id", String(wsId));
  if (API_URL.includes("ngrok"))
    headers.set("ngrok-skip-browser-warning", "true");

  const response = await fetch(`${API_URL}${path}`, { headers });
  if (!response.ok) {
    // The error path is still the JSON envelope; surface its message.
    let err: ApiEnvelope<unknown> | null = null;
    try {
      err = (await response.json()) as ApiEnvelope<unknown>;
    } catch {
      /* body wasn't JSON */
    }
    throw new ApiError({
      code: err?.error?.code ?? "DOWNLOAD_ERROR",
      message: err?.error?.message ?? response.statusText,
      status: response.status,
      details: err?.error?.details,
    });
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click's navigation has grabbed the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  stream,
  download,
};

/** Build a query string, skipping undefined/null/empty. Returns "?a=b" or "". */
export function qs(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
