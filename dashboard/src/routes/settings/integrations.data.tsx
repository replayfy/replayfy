/* ============================================================================
   integrations.data.tsx — the integrations catalog: brand marks, categories,
   card taglines and the per-integration detail content (blurb, capabilities,
   permissions, config field). Visual identity + copy live here; the live
   connection state comes from GET /v1/settings/integrations, matched by id.

   `wireable` marks the three integrations backed by real per-workspace OAuth
   (Connect fetches a signed authorize URL; Disconnect drops the token). The
   rest render a complete detail with a "Join the waitlist" affordance rather
   than faking a connection.
   ========================================================================== */
import type { ReactNode } from "react";

export type IntegrationCan = { icon: string; text: string };
export type IntegrationDef = {
  id: string;
  name: string;
  color: string;
  category: string;
  tagline: string; // card + hero one-liner
  blurb: string; // detail long description
  can: IntegrationCan[];
  scopes: string[];
  wireable: boolean;
  /** Can file/post about a specific recording (the "Create issue" picker) — the
   *  issue/message targets, not alert-only ones like PagerDuty/Webhook/Sentry. */
  canFileIssue?: boolean;
  featured?: boolean;
  logo: ReactNode;
};

/* ---- brand marks (functional identifiers, drawn compact for a 22px tile) ---- */
const SlackMark = (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#36C5F0"
      d="M5.04 15.17a2.53 2.53 0 1 1-2.52-2.53h2.52v2.53Zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.31a2.53 2.53 0 0 1-5.05 0v-6.31Z"
    />
    <path
      fill="#2EB67D"
      d="M8.83 5.04A2.53 2.53 0 1 1 11.36 2.5v2.52H8.83Zm0 1.28a2.53 2.53 0 0 1 0 5.05H2.52a2.53 2.53 0 0 1 0-5.05h6.31Z"
    />
    <path
      fill="#ECB22E"
      d="M18.96 8.83a2.53 2.53 0 1 1 2.52 2.53h-2.52V8.83Zm-1.27 0a2.53 2.53 0 0 1-5.05 0V2.52a2.53 2.53 0 0 1 5.05 0v6.31Z"
    />
    <path
      fill="#E01E5A"
      d="M15.17 18.96a2.53 2.53 0 1 1-2.53 2.52v-2.52h2.53Zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.31a2.53 2.53 0 0 1 0 5.05h-6.31Z"
    />
  </svg>
);
/* Linear's official brand icon, served verbatim from public/logos/linear.svg. */
const LinearMark = <img src="/logos/linear.svg" alt="" aria-hidden="true" />;
const JiraMark = (
  <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#2684FF"
      d="M22.5 11.4 12.9 1.8 12 .9l-7.2 7.2-3.3 3.3a.85.85 0 0 0 0 1.2l6.6 6.6L12 23.1l7.2-7.2.11-.11 3.19-3.19a.85.85 0 0 0 0-1.2ZM12 14.4 8.7 11.1 12 7.8l3.3 3.3L12 14.4Z"
    />
    <path
      fill="#2684FF"
      d="M12 7.8a5.55 5.55 0 0 1-.02-7.8L4.79 7.19 8.68 11.08 12 7.8Z"
      opacity=".75"
    />
    <path
      fill="#2684FF"
      d="M15.31 11.09 12 14.4a5.55 5.55 0 0 1 0 7.85l7.2-7.2-3.89-3.96Z"
      opacity=".55"
    />
  </svg>
);
const LarkMark = (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#00D6B9"
      d="M12.6 3.3c-2.9 2-5 4.9-6.2 8.2 2.6 2.4 6 3.8 9.6 3.8 1.2 0 2.4-.15 3.5-.44A11.9 11.9 0 0 0 12.6 3.3Z"
    />
    <path
      fill="#3370FF"
      d="M2.4 13.5c-.5 1.2-.8 2.4-1 3.7 3.2 2.4 8.6 3.6 13.8 1.9 3-1 5.4-2.8 6.8-4.9-1.1.3-2.3.44-3.5.44-5.2 0-9.8-2.9-12.2-7.2-1.5 1.7-2.9 3.8-3.9 6.1Z"
    />
    <path
      fill="#133C9A"
      d="M6.4 11.5A18.6 18.6 0 0 0 2.4 13.5c1 .9 2.2 1.7 3.5 2.3 1-1.5 1.5-2.9.5-4.3Z"
      opacity=".6"
    />
  </svg>
);
const GithubMark = (
  <svg
    width="19"
    height="19"
    viewBox="0 0 16 16"
    fill="#1f2023"
    aria-hidden="true"
  >
    <path d="M8 0C3.6 0 0 3.6 0 8c0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.5 1.1.2 1.9.1 2.1.5.5.8 1.2.8 2.1 0 3.1-1.8 3.8-3.6 4 .3.3.6.8.6 1.6v2.4c0 .2.1.5.5.4A8 8 0 0 0 16 8c0-4.4-3.6-8-8-8z" />
  </svg>
);
const SentryMark = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#584674"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 17.5C6.2 8.4 11 4.5 12 4.5s5.8 3.9 8 13" />
    <path d="M9.2 17.5c1.1-4 2.3-5.6 2.8-5.6s1.7 1.6 2.8 5.6" />
  </svg>
);
const WebhookMark = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#5b5ceb"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 9a3 3 0 1 1 4 2.8l-2.4 4.1" />
    <circle cx="6.5" cy="17.5" r="2.5" />
    <circle cx="17.5" cy="17.5" r="2.5" />
    <path d="M9 17.5h6" />
    <path d="M14.5 8.5 17 13a3 3 0 1 1-2.9 1.8" />
  </svg>
);
/* PagerDuty — its black "P" mark with the separate dash below the stem, drawn
   as a crisp vector (stem + bowl-with-counter + dash) so it stays sharp in the
   22px tile. Matches the brand: black, not filled/green. */
const PagerDutyMark = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="#191919" aria-hidden="true">
    {/* stem */}
    <rect x="6.6" y="3" width="3.3" height="10" rx="0.4" />
    {/* bowl (outer D minus the counter, via even-odd) */}
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M9.9 3H12.5A4 4 0 0 1 12.5 11H9.9V3ZM9.9 5.6H12.5A1.4 1.4 0 0 1 12.5 8.4H9.9V5.6Z"
    />
    {/* dash */}
    <rect x="6.6" y="15.5" width="3.3" height="4" rx="0.4" />
  </svg>
);

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "slack",
    name: "Slack",
    color: "#4A154B",
    category: "Alerts & messaging",
    featured: true,
    wireable: true,
    canFileIssue: true,
    logo: SlackMark,
    tagline: "Send alerts and share sessions in your channels.",
    blurb:
      "Route Replayfy alerts, new signals and shared replays straight into Slack. Choose a channel for each alert and let your team jump from a message to the exact session in one click.",
    can: [
      { icon: "bell", text: "Post alerts and anomaly signals to any channel" },
      {
        icon: "play",
        text: "Share replay links that unfurl with session context",
      },
      { icon: "comment", text: "Turn a Slack thread into a tracked comment" },
    ],
    scopes: [
      "Post messages to channels you choose",
      "Read messages in channels you add Replayfy to",
      "Unfurl Replayfy links in messages",
      "Read your channel list",
    ],
  },
  {
    id: "pagerduty",
    name: "PagerDuty",
    color: "#06AC38",
    category: "Alerts & messaging",
    wireable: true,
    logo: PagerDutyMark,
    tagline: "Trigger incidents from signals.",
    blurb:
      "Turn Replayfy signals into PagerDuty incidents. Connect a service's Events API integration key and route anomaly signals — crash spikes, funnel drops, conversion dips — straight to the right on-call rotation, with a link back to the evidence.",
    can: [
      { icon: "bell", text: "Open PagerDuty incidents from signal alerts" },
      { icon: "spark", text: "Route by urgency to the right on-call service" },
      { icon: "warn", text: "Resolve automatically when the signal clears" },
    ],
    scopes: [
      "Trigger and resolve events on the service integration key you provide",
    ],
  },
  {
    id: "lark",
    name: "Lark",
    color: "#3370FF",
    category: "Alerts & messaging",
    wireable: true,
    canFileIssue: true,
    logo: LarkMark,
    tagline: "Deliver alerts to Lark groups and chats.",
    blurb:
      "Bring Replayfy alerts and shared sessions into Lark. Notify the right group the moment a crash spike or funnel drop is detected, with a link back to the session.",
    can: [
      { icon: "bell", text: "Send alerts to Lark group chats" },
      { icon: "play", text: "Share replay links with session context" },
      { icon: "users", text: "Notify on-call groups automatically" },
    ],
    scopes: ["Send messages to groups you select", "Read your group list"],
  },
  {
    id: "linear",
    name: "Linear",
    color: "#5E6AD2",
    category: "Issue tracking",
    wireable: true,
    canFileIssue: true,
    logo: LinearMark,
    tagline: "File issues from a session in one click.",
    blurb:
      "Create issues from any recording, crash group or signal — the session link, stack trace and device context attach automatically so engineers land on the exact moment it happened.",
    can: [
      { icon: "doc", text: "Create issues from sessions, crashes and signals" },
      {
        icon: "pin",
        text: "Auto-attach the replay link, trace and device context",
      },
      { icon: "refresh", text: "Sync issue status back into Replayfy" },
    ],
    scopes: [
      "Create issues in a team you choose",
      "Read your teams and projects",
      "Read and write issue status",
    ],
  },
  {
    id: "jira",
    name: "Jira",
    color: "#0052CC",
    category: "Issue tracking",
    wireable: true,
    canFileIssue: true,
    logo: JiraMark,
    tagline: "Sync sessions to Jira tickets.",
    blurb:
      "Push Replayfy sessions and crashes into Jira. Every ticket carries the replay link and reproduction context, and status changes flow back so nothing drifts out of sync.",
    can: [
      { icon: "doc", text: "Create Jira tickets from sessions and crashes" },
      { icon: "pin", text: "Attach the replay link and reproduction steps" },
      { icon: "refresh", text: "Two-way status sync" },
    ],
    scopes: [
      "Create issues in a project you choose",
      "Read projects and issue types",
      "Read and write status",
    ],
  },
  {
    id: "github",
    name: "GitHub",
    color: "#1f2023",
    category: "Issue tracking",
    wireable: true,
    canFileIssue: true,
    logo: GithubMark,
    tagline: "Open issues for errors captured in sessions.",
    blurb:
      "Open GitHub issues for the errors and crashes Replayfy captures. Each issue includes the replay link, the stack trace and the release it first appeared in.",
    can: [
      { icon: "doc", text: "Open issues from crashes and errors" },
      { icon: "pin", text: "Attach the replay link, stack trace and release" },
      { icon: "refresh", text: "Close the loop when the issue is resolved" },
    ],
    scopes: [
      "Create issues in a repository you choose",
      "Read your repositories",
      "Read and write issue state",
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    color: "#584674",
    category: "Monitoring & developer",
    wireable: true,
    logo: SentryMark,
    tagline: "Link Sentry errors to the exact replay.",
    blurb:
      "Match Sentry issues to Replayfy sessions so every error links to the replay where it happened. Jump from a Sentry event to the user's session and see exactly what led to the crash.",
    can: [
      { icon: "warn", text: "Match Sentry issues to sessions" },
      { icon: "play", text: "Open the replay from a Sentry event" },
      { icon: "spark", text: "Enrich errors with device and release context" },
    ],
    scopes: ["Read issues and events", "Write replay links onto issues"],
  },
  {
    id: "webhook",
    name: "Webhook",
    color: "#5b5ceb",
    category: "Monitoring & developer",
    wireable: true,
    logo: WebhookMark,
    tagline: "POST Replayfy events anywhere.",
    blurb:
      "Send Replayfy events — new sessions, crashes, alerts and signals — to any endpoint as JSON. Build custom automations, pipe to your warehouse or trigger downstream workflows.",
    can: [
      { icon: "bolt", text: "POST events to your endpoint as JSON" },
      { icon: "lock", text: "Signed payloads with a shared secret" },
      { icon: "refresh", text: "Automatic retries with backoff on failure" },
    ],
    scopes: ["No account access — you provide the destination URL"],
  },
];

/** Category display order for the grouped grid. */
export const INTEGRATION_CATEGORIES = [
  "Alerts & messaging",
  "Issue tracking",
  "Monitoring & developer",
] as const;
