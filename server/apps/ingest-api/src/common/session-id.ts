import { createHash } from "crypto";

/** Prefix of a session id the SERVER derives (workspaceScopedSessionId). The
 *  ingest refuses client session ids starting with it, so no client can claim
 *  or aim at one. SDK-generated ids ("ses_" + base36, which has no "_") can't
 *  start with it either. */
export const WORKSPACE_SCOPED_SESSION_PREFIX = "ses_ws_";

/**
 * The Session.publicId a workspace's session is stored under when its
 * client-chosen id is already taken by ANOTHER workspace: host-supplied ids
 * that collide, or a session id copied from someone else's share link.
 * Deterministic (every later batch of that session lands on the same row),
 * fixed length, and reveals neither the workspace nor the raw id.
 */
export function workspaceScopedSessionId(
  workspaceId: number,
  rawSessionId: string,
): string {
  const digest = createHash("sha256")
    .update(`${workspaceId}\0${rawSessionId}`)
    .digest("hex");
  return WORKSPACE_SCOPED_SESSION_PREFIX + digest.slice(0, 40);
}
