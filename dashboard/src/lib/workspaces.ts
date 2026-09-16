import type { MembershipSummary } from "@/api/endpoints";
import type { WorkspaceRole } from "@/lib/roles";

/** Shape the Sidebar / WorkspaceMenu consume. */
export type Workspace = {
  id: number;
  name: string;
  plan: string;
  members: number;
  /** avatar/accent color (hex) */
  c: string;
  /** The signed-in person's role in THIS workspace. Was dropped on the floor
   *  here, which is why the role was structurally absent from the shape the nav
   *  consumes — you cannot gate on a field the adapter deletes. */
  role: WorkspaceRole;
};

/** Plan enums arrive uppercase ("PRO"/"FREE"/"ENTERPRISE"/"TEAM"); the design
 *  renders them Title Case ("Pro", "Free", …). */
export function titleCasePlan(plan?: string | null): string {
  if (!plan) return "Free";
  return plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase();
}

/** Adapt an API membership (role + nested workspace) to the Sidebar's shape.
 *  Member count isn't in /v1/me, so it's passed in from the /v1/workspaces
 *  list (which carries `_count.members`); defaults to 0 until that resolves. */
export function wsFromMembership(m: MembershipSummary, memberCount = 0): Workspace {
  return {
    id: m.workspaceId,
    name: m.workspace.name,
    plan: titleCasePlan(m.workspace.plan),
    members: memberCount,
    c: m.workspace.swatch ?? "#5b5ceb",
    role: m.role,
  };
}
