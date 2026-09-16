/* ============================================================================
   What the signed-in person may do in the CURRENT workspace.

   This mirrors the server's WorkspaceRoleGuard (common/role.guard.ts) — same
   four roles, same ranks, same ">= required" test. It is a mirror and nothing
   more: every rule here is enforced again on the API, because a gate that only
   exists in the browser is a suggestion. What this buys is that the UI stops
   offering people buttons that will 403, and stops rendering panels whose data
   the API now refuses to send.

   Two things this file exists to prevent, both of which were live:

   · `role` arrived typed as plain `string`, so `role === "ADMN"` type-checked
     and would have silently granted nothing to nobody — or, worse, a
     `!== "VIEWER"` test would have granted everything to everyone.
   · The casing is not consistent across the app. /v1/me yields UPPERCASE
     ("OWNER"); the Team panel renders and compares Title Case ("Owner") and
     re-uppercases on PATCH. A gate written against the wrong casing does not
     fail loudly — `"Admin" === "ADMIN"` is false, so the check simply denies,
     and `"Admin" !== "VIEWER"` is true, so the check simply allows. Normalise
     once, here, and never compare a role string anywhere else.
   ========================================================================== */

export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

/** Same ranks as the server guard. Keep them in step. */
const RANK: Record<WorkspaceRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

/** Whatever the wire says → a role we can reason about, or null. Accepts any
 *  casing because the app produces three of them; returns null rather than
 *  guessing, so an unknown value is powerless instead of powerful. */
export function asRole(raw: string | null | undefined): WorkspaceRole | null {
  const v = (raw ?? "").trim().toUpperCase();
  return v in RANK ? (v as WorkspaceRole) : null;
}

/** `role` is at least `need`. Null (unknown role, no membership, still loading)
 *  is NOT at least anything — the same fail-closed rule the server applies. */
export function atLeast(
  role: WorkspaceRole | null,
  need: WorkspaceRole,
): boolean {
  if (!role) return false;
  return RANK[role] >= RANK[need];
}

/**
 * The permissions the UI actually asks about, named for what the product
 * promises rather than for a role — so a call site reads like the invite modal:
 *
 *   Viewer  "Can watch recordings only"
 *   Member  "Can watch, comment, build playlists"
 *   Admin   "Can also change settings"
 *
 * Deriving these in one place is what stops the next gate from being written as
 * `role !== "VIEWER"` in a component, which is how these things rot.
 */
export function can(role: WorkspaceRole | null) {
  return {
    /** Comment, build playlists, manage cohorts/funnels/alerts, ask the AI —
     *  everything a member was invited to do. Asking costs real money, which is
     *  why it is not a viewer's to spend. */
    contribute: atLeast(role, "MEMBER"),
    /** See Settings at all. A viewer watches recordings; settings are not
     *  recordings, and the API now refuses them the data. */
    seeSettings: atLeast(role, "MEMBER"),
    /** Change any workspace setting, mint or revoke API keys, rename the
     *  workspace — "Admin: can ALSO change settings". */
    changeSettings: atLeast(role, "ADMIN"),
    /** Invite, change a role, remove a member. */
    manageTeam: atLeast(role, "ADMIN"),
    /** Delete the workspace. OWNER, not ADMIN: workspaces.service.remove()
     *  demands ["OWNER"]. The route decorator said ADMIN, and mirroring the
     *  decorator instead of the service is how this predicate first shipped
     *  showing an admin a button the server would refuse — the exact failure
     *  a UI mirror is supposed to prevent. Mirror the enforcer, not its label. */
    deleteWorkspace: atLeast(role, "OWNER"),
  };
}

export type Can = ReturnType<typeof can>;
