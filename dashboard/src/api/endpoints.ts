import { api, API_URL, qs } from "./client";

/* ------------------------------------------------------------------ types */
export type SessionUser = {
  id: number;
  name: string | null;
  email: string;
  initials?: string;
  avatarUrl?: string | null;
};
export type WorkspaceRef = {
  id: number;
  slug: string;
  name: string;
  domain?: string | null;
  env?: string;
  plan?: string;
  swatch?: string;
};
import type { WorkspaceRole } from "@/lib/roles";

/** /v1/me membership: role is top-level, workspace details are nested.
 *  Typed as the union, not `string`: a typo used to type-check, and a role
 *  comparison that silently never matches fails OPEN on a `!==` test. */
export type MembershipSummary = {
  workspaceId: number;
  role: WorkspaceRole;
  workspace: WorkspaceRef;
};
export type AuthSession = {
  token: string | null;
  user: SessionUser;
  workspaceId: number;
  pendingVerification?: boolean;
  firstWorkspace?: boolean;
};
export type MeResponse = { user: SessionUser; memberships: MembershipSummary[] };
export type WorkspaceSummary = {
  id: number;
  name: string;
  slug: string;
  domain?: string | null;
  env?: string;
  plan?: string;
  swatch?: string;
  role?: string;
  memberCount?: number;
  dataRegion?: DataRegion;
};
export type DataRegion = "US" | "EU";
export type OAuthProvider = "google" | "github" | "gitlab";

/* -------------------------------------------------------------------- auth */
export const Auth = {
  login: (body: { email: string; password: string }) => api.post<AuthSession>("/v1/auth/login", body),
  signup: (body: { email: string; password: string; name?: string; workspaceName?: string }) =>
    api.post<AuthSession>("/v1/auth/signup", body),
  logout: () => api.post<{ ok: true }>("/v1/auth/logout"),
  verify: (token: string) => api.post<AuthSession>("/v1/auth/verify", { token }),
  resendVerification: (email: string) => api.post<{ ok: true }>("/v1/auth/resend-verification", { email }),
  /** Passwordless "email me a sign-in link". Always {ok:true} (no enumeration). */
  magicRequest: (email: string) => api.post<{ ok: true }>("/v1/auth/magic/request", { email }),
  /** Consume the emailed token → a session (same shape as verify/login). */
  magicConsume: (token: string) => api.post<AuthSession>("/v1/auth/magic/consume", { token }),
  forgotPassword: (email: string) => api.post<{ ok: true }>("/v1/auth/password/forgot", { email }),
  resetPassword: (body: { token: string; password: string }) =>
    api.post<{ ok: true }>("/v1/auth/password/reset", body),
  changePassword: (body: { oldPassword: string; newPassword: string }) =>
    api.post<{ ok: true }>("/v1/me/password", body),
  me: () => api.get<MeResponse>("/v1/me"),
  updateMe: (body: { name?: string; avatarUrl?: string }) => api.patch<SessionUser>("/v1/me", body),
  inviteInspect: (token: string) =>
    api.post<{ email: string; role: string; workspaceName: string; workspaceSlug: string }>(
      "/v1/auth/invite/inspect",
      { token },
    ),
  inviteAccept: (body: { token: string; password: string; name?: string }) =>
    api.post<AuthSession>("/v1/auth/invite/accept", body),
  /** Full-page redirect target (not fetch). Backend redirects back with ?token=. */
  oauthStartUrl: (provider: OAuthProvider) => `${API_URL}/v1/auth/oauth/${provider}/start`,
  /** Social-login providers configured on THIS server (public). The login screen
   *  renders a button only for these, so a self-host with no OAuth set up shows
   *  no dead buttons. */
  oauthProviders: () => api.get<{ providers: OAuthProvider[] }>("/v1/auth/oauth/providers"),
};

/* -------------------------------------------------------------------- meta */
export type VersionInfo = { version: string; commit: string; builtAt: string | null };
export const Meta = {
  /** Build identity of the running API (public, unauthenticated). Shown in
   *  Settings so a self-hoster can report exactly which version they're on. */
  version: () => api.get<VersionInfo>("/version"),
};

/* -------------------------------------------------------------- workspaces */
export const Workspaces = {
  list: () => api.get<WorkspaceSummary[]>("/v1/workspaces"),
  get: (id: number) => api.get<WorkspaceSummary>(`/v1/workspaces/${id}`),
  /** Is this workspace URL free? Advisory — the server slugifies the name the
   *  same way we do and answers for the result, but it can always be raced, so
   *  create still answers 409. Reachable without a workspace (onboarding). */
  slugAvailable: (slug: string) =>
    api.get<{ slug: string; available: boolean }>(
      `/v1/workspaces/slug-available?slug=${encodeURIComponent(slug)}`,
    ),
  create: (body: {
    name: string;
    slug?: string;
    domain?: string;
    swatch?: string;
    env?: string;
    plan?: string;
    dataRegion?: DataRegion;
  }) => api.post<WorkspaceSummary>("/v1/workspaces", body),
  update: (id: number, body: Partial<{ name: string; domain: string; swatch: string; env: string; plan: string }>) =>
    api.patch<WorkspaceSummary>(`/v1/workspaces/${id}`, body),
  remove: (id: number) => api.delete<{ ok: true }>(`/v1/workspaces/${id}`),
  members: <T = unknown>(id: number, q: { cursor?: string; limit?: number } = {}) => api.get<T>(`/v1/workspaces/${id}/members${qs(q)}`),
  invites: <T = unknown>(id: number) => api.get<T>(`/v1/workspaces/${id}/invites`),
  createInvite: (id: number, body: { email: string; role: string }) =>
    api.post(`/v1/workspaces/${id}/invites`, body),
  resendInvite: (id: number, inviteId: number) => api.post(`/v1/workspaces/${id}/invites/${inviteId}/resend`),
  cancelInvite: (id: number, inviteId: number) => api.delete(`/v1/workspaces/${id}/invites/${inviteId}`),
  // Member management (role change + removal) — role-gated on the backend.
  updateMember: (id: number, memberId: number, body: { role: string }) => api.patch(`/v1/workspaces/${id}/members/${memberId}`, body),
  removeMember: (id: number, memberId: number) => api.delete(`/v1/workspaces/${id}/members/${memberId}`),
  // Leave a workspace yourself (removes the caller's own membership). The API
  // blocks the last owner from leaving — the UI mirrors that below.
  leave: (id: number) => api.post<{ left: true }>(`/v1/workspaces/${id}/leave`),
};

/* ---------------------------------------------------------------- settings */
const settingsSlice = (slice: string) => ({
  get: <T = unknown>() => api.get<T>(`/v1/settings/${slice}`),
  set: <T = unknown>(body: unknown) => api.patch<T>(`/v1/settings/${slice}`, body),
});
/* billing → Enterprise Edition: the Billing namespace lives in
   src/ee/billing/billing.api.ts (proprietary). The open-source build has no
   billing routes, so there is no core caller here. */

export const Settings = {
  region: settingsSlice("region"), // NEW backend endpoint (added in this phase)
  recording: settingsSlice("recording"),
  masking: settingsSlice("masking"),
  retention: settingsSlice("retention"),
  sampling: settingsSlice("sampling"),
  business: settingsSlice("business"),
  aiMode: settingsSlice("ai-mode"),
  intelInterval: settingsSlice("intel-interval"),
  llm: settingsSlice("llm"),
  integrations: <T = unknown>() => api.get<T>("/v1/settings/integrations"),
  aiUsage: <T = unknown>(days?: number) => api.get<T>(`/v1/settings/ai/usage${qs({ days })}`),
};

/* ------------------------------------------------------------ integrations */
/** Per-workspace OAuth integrations (Linear, GitHub, Slack — same shape).
 *  `connect` returns a signed authorize URL to redirect the browser to; the
 *  OAuth callback (backend, public) redirects back to /settings/integrations. */
export const Integrations = {
  list: <T = unknown>() => api.get<T>("/v1/integrations"),
  connect: (provider: string) => api.get<{ authorizeUrl: string }>(`/v1/integrations/${provider}/connect`),
  /** Credential-free connect (no OAuth redirect): store a key/URL for a provider
   *  configured by form — PagerDuty (integrationKey) / Webhook (url). The Webhook
   *  signing secret is minted server-side and returned once as `signingSecret`. */
  configure: (provider: string, body: Record<string, string>) =>
    api.post<{ connected: true; signingSecret?: string }>(
      `/v1/integrations/${provider}/configure`,
      body,
    ),
  /** The connected webhook's URL + signing secret, so the modal can re-reveal
   *  the auto-generated secret when reopened. */
  webhookConfig: () =>
    api.get<{
      connected: boolean;
      url?: string;
      host?: string;
      signingSecret?: string;
    }>("/v1/integrations/webhook/config"),
  disconnect: (provider: string) => api.delete<{ disconnected: true }>(`/v1/integrations/${provider}`),
  /** File a Linear/GitHub issue (or post to Slack) about a specific recording.
   *  `url` is absent for Slack (it returns just the channel `ref`), so both are
   *  optional. */
  createSessionIssue: (provider: string, body: { sessionPublicId: string; title?: string }) =>
    api.post<{ url?: string; ref?: string }>(`/v1/integrations/${provider}/session-issue`, body),
};

/* ---------------------------------------------------------------- api keys */
export const ApiKeys = {
  list: <T = unknown>(q: { scope?: string; limit?: number } = {}) => api.get<T>(`/v1/api-keys${qs(q)}`),
  /** The workspace's publishable key for the Install snippet — the full, working
   *  key (not the truncated prefix). `publicKey` is null when none exists yet or a
   *  legacy key needs a rotate to reveal. MEMBER-visible; secret keys never returned. */
  getPublic: <T = unknown>() => api.get<T>("/v1/api-keys/public"),
  create: <T = unknown>(body: { name: string; scope: string; envs?: string[] }) => api.post<T>("/v1/api-keys", body),
  /** Idempotent: returns the workspace's default PUBLIC key, minting it only if
   *  there isn't one. Safe to call twice — onboarding used to list-then-create
   *  and raced itself into two keys on every fresh workspace. */
  bootstrap: <T = unknown>() => api.post<T>("/v1/api-keys/bootstrap", {}),
  remove: (id: number) => api.delete(`/v1/api-keys/${id}`),
  rotate: <T = unknown>(id: number) => api.post<T>(`/v1/api-keys/${id}/rotate`),
};

/* --------------------------------------------------------------- dashboard */
export const Dashboard = {
  overview: <T = unknown>(range?: string, from?: number, to?: number) => api.get<T>(`/v1/dashboard/overview${qs({ range, from, to })}`),
  metrics: <T = unknown>(range?: string, from?: number, to?: number) => api.get<T>(`/v1/dashboard/metrics${qs({ range, from, to })}`),
  /** Activity chart — REAL per-dimension/per-bucket series. `rule` is a repeated
   *  param ("dim:value"), so the query string is built here rather than via qs(). */
  activitySeries: <T = unknown>(p: {
    metric?: string;
    dimension?: string;
    range?: string;
    gran?: string;
    segment?: string;
    compare?: boolean;
    topN?: number;
    rules?: string[];
    from?: number;
    to?: number;
  }) => {
    const sp = new URLSearchParams();
    if (p.metric) sp.set("metric", p.metric);
    if (p.dimension && p.dimension !== "none") sp.set("dimension", p.dimension);
    if (p.range) sp.set("range", p.range);
    if (p.gran) sp.set("gran", p.gran);
    if (p.segment && p.segment !== "all") sp.set("segment", p.segment);
    if (p.compare) sp.set("compare", "1");
    if (p.topN) sp.set("topN", String(p.topN));
    if (p.from) sp.set("from", String(p.from));
    if (p.to) sp.set("to", String(p.to));
    for (const r of p.rules ?? []) sp.append("rule", r);
    const q = sp.toString();
    return api.get<T>(`/v1/dashboard/activity-series${q ? `?${q}` : ""}`);
  },
  intelligence: <T = unknown>(range?: string, from?: number, to?: number) => api.get<T>(`/v1/dashboard/intelligence${qs({ range, from, to })}`),
  live: <T = unknown>() => api.get<T>("/v1/dashboard/live"),
  counts: <T = unknown>() => api.get<T>("/v1/dashboard/counts"),
  recomputeIntel: <T = unknown>() => api.post<T>("/v1/dashboard/intel/recompute"),
  // Incident actions: Investigate (LLM cause) + acknowledge/resolve.
  incidentCause: <T = unknown>(id: string) => api.post<T>(`/v1/dashboard/incidents/${id}/cause`),
  /** The AI INVESTIGATION REPORT — diagnosis + remediation, sections omitted
   *  when the server could not ground them. Spends AI credits (MEMBER+). */
  incidentReport: <T = unknown>(id: string) =>
    api.post<T>(`/v1/dashboard/incidents/${id}/report`),
  // The DETERMINISTIC investigation — measured facts only, no model, read-only.
  incidentInvestigation: <T = unknown>(id: string) =>
    api.get<T>(`/v1/dashboard/incidents/${id}/investigation`),
  // The ISSUE twin — deterministic only; issues get no AI report by design.
  issueInvestigation: <T = unknown>(id: string) =>
    api.get<T>(`/v1/dashboard/incidents/issue/${id}/investigation`),
  // Propose + create a funnel from an incident (the "Create funnel" action).
  incidentCreateFunnel: <T = unknown>(id: string) =>
    api.post<T>(`/v1/dashboard/incidents/${id}/funnel`),
  /** The incident HEADER only — title, status, and how many sessions are still
   *  attributed to it. For the Recordings ?incident= scope banner, which needs a
   *  label and an honest count rather than the whole investigation payload. */
  incidentDetail: <T = unknown>(id: string) => api.get<T>(`/v1/dashboard/incidents/${id}`),
  incidentUpdate: <T = unknown>(id: string, body: { status?: string; ack?: boolean }) =>
    api.patch<T>(`/v1/dashboard/incidents/${id}`, body),
};

/* ----------------------------------------------------------- AI agent (SSE) */
/** Conversational agent. `stream` opens a POST SSE via api.stream — frames are
 *  AgentStreamEvent objects (plan | step:start | investigating | step:done |
 *  citation | narration | needs_confirmation | needs_clarification | done |
 *  error). conversationId is server-minted (conv_…) and echoed back each turn. */

/* --------------------------------------------------- sessions / recordings */
export const Sessions = {
  list: <T = unknown>(q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/sessions${qs(q)}`),
  /** Typed value autocomplete for the Recordings search. `groups` repeats
   *  (?groups=user&groups=page) rather than going through `qs`, which is
   *  URLSearchParams.set — one value per key — and would send only the last
   *  group. Each row comes back tagged with the `type` that produced it. */
  suggest: <T = unknown>(q: { q?: string; groups: string[] }) => {
    const sp = new URLSearchParams();
    if (q.q) sp.set("q", q.q);
    for (const g of q.groups) sp.append("groups", g);
    return api.get<T>(`/v1/sessions/suggest?${sp.toString()}`);
  },
  /** The BOUNDED search dimensions for this workspace, complete and cached
   *  server-side — the whole value set, not a ranked head, so the dropdown can
   *  filter them client-side with zero requests per keystroke. Takes no `q` for
   *  exactly that reason: a query param would make it per-keystroke again and
   *  uncacheable. Which types it covers is the SERVER's answer (`types` in the
   *  response), never a hardcoded list here — see suggest.ts. */
  facets: <T = unknown>() => api.get<T>("/v1/sessions/facets"),
  get: <T = unknown>(publicId: string) => api.get<T>(`/v1/sessions/${publicId}`),
  // rrweb replay batches — backend default page is 50, max 200; the web player
  // The COMPLETE rrweb replay stream — NOT paginated. The Replayer needs the
  // FullSnapshot + every event to seek anywhere in the recording, so a batch cap
  // would truncate long sessions. (The event TAB uses /timeline, not this.)
  events: <T = unknown>(publicId: string) => api.get<T>(`/v1/sessions/${publicId}/events`),
  console: <T = unknown>(publicId: string, q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/sessions/${publicId}/console${qs(q)}`),
  network: <T = unknown>(publicId: string, q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/sessions/${publicId}/network${qs(q)}`),
  errors: <T = unknown>(publicId: string, q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/sessions/${publicId}/errors${qs(q)}`),
  timeline: <T = unknown>(publicId: string) => api.get<T>(`/v1/sessions/${publicId}/timeline`),
  performance: <T = unknown>(publicId: string) => api.get<T>(`/v1/sessions/${publicId}/performance`),
  comments: <T = unknown>(publicId: string) => api.get<T>(`/v1/sessions/${publicId}/comments`),
  addComment: (publicId: string, body: unknown) => api.post(`/v1/sessions/${publicId}/comments`, body),
  share: (publicId: string, body: unknown) => api.post(`/v1/sessions/${publicId}/share`, body),
  // Mobile playback (screenshot/frames archive) + native interaction overlays.
  frames: <T = unknown>(publicId: string) => api.get<T>(`/v1/sessions/${publicId}/frames`),
  taps: <T = unknown>(publicId: string) => api.get<T>(`/v1/sessions/${publicId}/taps`),
  customs: <T = unknown>(publicId: string) => api.get<T>(`/v1/sessions/${publicId}/customs`),
  screens: <T = unknown>(publicId: string) => api.get<T>(`/v1/sessions/${publicId}/screens`),
};

/* ----------------------------------------------------------------- funnels */
export const Funnels = {
  /** `{ pinned: true }` narrows to the pinned funnel(s) server-side (indexed) —
   *  the Overview needs only that one and shouldn't pull the whole list. */
  list: <T = unknown>(params?: {
    pinned?: boolean;
    limit?: number;
    cursor?: string;
    /** Name/description substring — filtered server-side across ALL funnels. */
    search?: string;
  }) =>
    api.get<T>(
      `/v1/funnels${
        params
          ? `?${new URLSearchParams(
              Object.entries(params).reduce<Record<string, string>>(
                (a, [k, v]) => (v === undefined ? a : { ...a, [k]: String(v) }),
                {},
              ),
            ).toString()}`
          : ""
      }`,
    ),
  get: <T = unknown>(id: string) => api.get<T>(`/v1/funnels/${id}`),
  create: <T = unknown>(body: unknown) => api.post<T>("/v1/funnels", body),
  update: <T = unknown>(id: string, body: unknown) => api.patch<T>(`/v1/funnels/${id}`, body),
  remove: (id: string) => api.delete(`/v1/funnels/${id}`),
  compute: <T = unknown>(id: string) => api.get<T>(`/v1/funnels/${id}/compute`),
  preview: <T = unknown>(body: unknown) => api.post<T>("/v1/funnels/preview", body),
  // Daily-bucketed conversion timeline → the "Conversion over time" chart.
  timeline: <T = unknown>(body: unknown) => api.post<T>("/v1/funnels/timeline", body),
  // Conversion split by a dimension (device/country/…) → the Breakdown tab.
  breakdown: <T = unknown>(body: unknown) => api.post<T>("/v1/funnels/breakdown", body),
  // Value autocomplete for a filter field (workspace-scoped) → the filter palette.
  suggest: <T = unknown>(params: { field: string; q?: string }) => api.get<T>(`/v1/funnels/suggest${qs(params)}`),
  // Step-value autocomplete for the builder (custom event name, page URL, screen,
  // click text) — reads the same session_events column the step matches on, so
  // the picker and the windowFunnel computation agree.
  stepSuggest: <T = unknown>(params: { kind: string; q?: string; windowDays?: number }) => api.get<T>(`/v1/funnels/step-suggest${qs(params)}`),
  // Drop-off cohort: preview the count of identified users who dropped out at a
  // step, then materialise them as a MANUAL cohort (a point-in-time snapshot).
  dropoffCount: <T = unknown>(id: number, params: { stepIndex: number; fromTs?: number; toTs?: number }) => api.get<T>(`/v1/funnels/${id}/dropoff-count${qs(params)}`),
  dropoffCohort: <T = unknown>(id: number, body: { stepIndex: number; name?: string; description?: string; fromTs?: number; toTs?: number }) => api.post<T>(`/v1/funnels/${id}/dropoff-cohort`, body),
  // "What's influencing conversion" — event/property drivers & blockers for this
  // funnel (the FE keeps folding issue blockers from `compute().insights`).
  influence: <T = unknown>(id: string, from?: number, to?: number) => api.get<T>(`/v1/funnels/${id}/influence${qs({ from, to })}`),
};

/* ----------------------------------------------------------------- analytics
   Trends / Retention / Web Vitals / Breakdowns / Events explorer. Mirrors the
   Dashboard namespace's (range, from, to) convention — `range` is a token
   (rangeToken() converts the preset label). Every read is a tenant-bounded,
   partition-pruned ClickHouse scan server-side. */
export const Analytics = {
  breakdown: <T = unknown>(dimension: string, measure: string, range?: string, from?: number, to?: number) =>
    api.get<T>(`/v1/analytics/breakdown${qs({ dimension, measure, range, from, to })}`),
  series: <T = unknown>(body: unknown) => api.post<T>("/v1/analytics/series", body),
  retention: <T = unknown>(action: string, granularity: string, range?: string, from?: number, to?: number) =>
    api.get<T>(`/v1/analytics/retention${qs({ action, granularity, range, from, to })}`),
  webVitals: <T = unknown>(device: string, range?: string, from?: number, to?: number) =>
    api.get<T>(`/v1/analytics/web-vitals${qs({ device, range, from, to })}`),
  events: <T = unknown>(range?: string, from?: number, to?: number) =>
    api.get<T>(`/v1/analytics/events${qs({ range, from, to })}`),
  properties: <T = unknown>(range?: string, from?: number, to?: number) =>
    api.get<T>(`/v1/analytics/properties${qs({ range, from, to })}`),
  schema: <T = unknown>(range?: string, from?: number, to?: number) =>
    api.get<T>(`/v1/analytics/schema${qs({ range, from, to })}`),
};

/* --------------------------------------------------------------- end users */
export const EndUsers = {
  list: <T = unknown>(q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/end-users${qs(q)}`),
  // Streams the FULL filtered set as CSV (server pages it 1000 rows at a time),
  // so the download isn't capped at the 25 rows the table shows. Pass the same
  // filter query as `list` — the server shares one WHERE builder so the file
  // equals the on-screen set. `filename` names the saved file.
  exportCsv: (q: Record<string, string | number | undefined>, filename: string) =>
    api.download(`/v1/end-users/export.csv${qs(q)}`, filename),
  get: <T = unknown>(id: string) => api.get<T>(`/v1/end-users/${id}`),
  sessions: <T = unknown>(id: string, limit?: number) => api.get<T>(`/v1/end-users/${id}/sessions${qs({ limit })}`),
  activity: <T = unknown>(id: string, limit?: number) => api.get<T>(`/v1/end-users/${id}/activity${qs({ limit })}`),
  activityChart: <T = unknown>(id: string, days?: number, from?: number, to?: number) => api.get<T>(`/v1/end-users/${id}/activity-chart${qs({ days, from, to })}`),
};

/* ----------------------------------------------------------------- cohorts */
export type CohortPreview = { count: number; sample: { id: number; name: string | null; email: string | null; initials: string | null; distinctId: string | null; plan: string | null }[] };
export const Cohorts = {
  list: <T = unknown>(q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/cohorts${qs(q)}`),
  get: <T = unknown>(id: string) => api.get<T>(`/v1/cohorts/${id}`),
  create: (body: unknown) => api.post("/v1/cohorts", body),
  update: (id: string, body: unknown) => api.patch(`/v1/cohorts/${id}`, body),
  remove: (id: string) => api.delete(`/v1/cohorts/${id}`),
  refresh: (id: string) => api.post(`/v1/cohorts/${id}/refresh`),
  members: <T = unknown>(id: string, q: { cursor?: string; limit?: number } = {}) => api.get<T>(`/v1/cohorts/${id}/members${qs(q)}`),
  /** MANUAL cohorts only — an AUTO cohort recomputes from its filter and drops hand-added members. */
  addMembers: (id: number | string, body: { userIds: number[] }) => api.post(`/v1/cohorts/${id}/members`, body),
  /** DELETE /v1/cohorts/:id/members/:userId — `userId` is the numeric EndUser id. */
  removeMember: (id: number | string, userId: number) => api.delete(`/v1/cohorts/${id}/members/${userId}`),
  preview: (body: { filter: unknown }) => api.post<CohortPreview>("/v1/cohorts/preview", body),
};

/* ------------------------------------------------------------------ alerts */
/** Alerts are notification policies, created by the AI (alert.watchIssue for an
 *  issue subscription, alert.create for a metric threshold) — there is no REST
 *  route to subscribe, so the dashboard only lists, re-routes and deletes them.
 *  `update` takes only `destinations` here: PATCH also accepts name/metric/
 *  threshold/active, but the alerts page edits the channel and nothing else. */
export const Alerts = {
  list: <T = unknown>(q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/alerts${qs(q)}`),
  create: (body: unknown) => api.post("/v1/alerts", body),
  update: (id: string, body: unknown) => api.patch(`/v1/alerts/${id}`, body),
  remove: (id: string) => api.delete(`/v1/alerts/${id}`),
  /** "Create alert" from a dashboard signal — binds a recurrence alert to the
   *  signal's backing incident or issue. Pass whichever id the signal carries. */
  fromSignal: <T = unknown>(body: {
    incidentId?: number;
    issueId?: number;
    name?: string;
    emailEnabled?: boolean;
  }) => api.post<T>("/v1/alerts/from-signal", body),
  /** "Alert on this funnel" from the funnel builder — watches the saved funnel's
   *  overall conversion (DROP_PCT vs the prior window, or ABOVE/BELOW a fixed %).
   *  Email-only: `recipients` are the addresses the alert emails (server validates
   *  + caps; empty falls back to the creator's account email). */
  fromFunnel: <T = unknown>(body: {
    funnelId: number;
    comparator?: string;
    threshold: number;
    windowDays?: number;
    name?: string;
    recipients?: string[];
  }) => api.post<T>("/v1/alerts/from-funnel", body),
};

/* ---------------------------------------------------------------- comments */
export const Comments = {
  list: <T = unknown>(q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/comments${qs(q)}`),
  update: (id: string, body: unknown) => api.patch(`/v1/comments/${id}`, body),
  remove: (id: string) => api.delete(`/v1/comments/${id}`),
};

/* --------------------------------------------------------------- playlists */
export const Playlists = {
  list: <T = unknown>(q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/playlists${qs(q)}`),
  create: <T = unknown>(body: unknown) => api.post<T>("/v1/playlists", body),
  get: <T = unknown>(id: number | string) => api.get<T>(`/v1/playlists/${id}`),
  update: <T = unknown>(id: number | string, body: unknown) => api.patch<T>(`/v1/playlists/${id}`, body),
  remove: (id: number | string) => api.delete(`/v1/playlists/${id}`),
  sessions: <T = unknown>(id: number | string, q: Record<string, string | number | undefined> = {}) =>
    api.get<T>(`/v1/playlists/${id}/sessions${qs(q)}`),
  addSession: (id: number | string, sessionId: string) => api.post(`/v1/playlists/${id}/sessions`, { sessionId }),
  removeSession: (id: number | string, sessionId: string) => api.delete(`/v1/playlists/${id}/sessions/${sessionId}`),
};

/* ---------------------------------------------------- public share viewer ---
   Unauthenticated: anyone holding a share token can play the recording + see
   the panels the sharer enabled. Mirrors the authed Sessions endpoints, gated
   by the token (backend `v1/share` ShareController). The api client only
   attaches auth headers when a token/workspace are set, so these work with
   none. */
export const Share = {
  resolve: <T = unknown>(token: string) => api.get<T>(`/v1/share/${token}`),
  events: <T = unknown>(token: string, q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/share/${token}/events${qs(q)}`),
  console: <T = unknown>(token: string, q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/share/${token}/console${qs(q)}`),
  network: <T = unknown>(token: string, q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/share/${token}/network${qs(q)}`),
  errors: <T = unknown>(token: string, q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/share/${token}/errors${qs(q)}`),
  timeline: <T = unknown>(token: string) => api.get<T>(`/v1/share/${token}/timeline`),
  performance: <T = unknown>(token: string) => api.get<T>(`/v1/share/${token}/performance`),
  // Mobile share routes — mirror the authed native-session endpoints.
  frames: <T = unknown>(token: string) => api.get<T>(`/v1/share/${token}/frames`),
  taps: <T = unknown>(token: string, q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/share/${token}/taps${qs(q)}`),
  customs: <T = unknown>(token: string, q: Record<string, string | number | undefined> = {}) => api.get<T>(`/v1/share/${token}/customs${qs(q)}`),
  screens: <T = unknown>(token: string) => api.get<T>(`/v1/share/${token}/screens`),
};
