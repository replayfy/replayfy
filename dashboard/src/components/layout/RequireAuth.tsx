import { Fragment } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/lib/auth";

/**
 * Gate for the app shell. Anonymous users go to /login; authenticated users with
 * no workspace yet go to onboarding. Auth/onboarding routes live outside this gate.
 */
export function RequireAuth() {
  const { status, memberships, workspaceId } = useAuth();
  if (status === "checking") return null; // brief boot flash while /v1/me resolves
  if (status === "anon") return <Navigate to="/login" replace />;
  if (memberships.length === 0) return <Navigate to="/onboarding/workspace" replace />;
  /* Keyed by workspace, so switching REMOUNTS the app rather than reloading the
     document (see setWorkspace). The key is load-bearing, not tidiness: useApi
     sets `placeholderData: keepPreviousData`, so changing the workspace in place
     would hand every page the PREVIOUS workspace's data with loading=false — the
     new workspace's name sitting over the old one's numbers, and no skeleton to
     admit it. A remounted observer has no previous data, so each page falls to
     its own loading state instead. It also re-runs the mount-time initializers
     that read workspace-scoped state. */
  return (
    <Fragment key={workspaceId ?? "none"}>
      <Outlet />
    </Fragment>
  );
}
