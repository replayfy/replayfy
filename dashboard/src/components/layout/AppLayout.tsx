import { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Sidebar } from "@/components/nav/Sidebar";
import { useIsMobile } from "@/hooks";
import { Workspaces, type WorkspaceSummary } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { useBackendReachable } from "@/api/health";
import { queryClient } from "@/api/queryClient";
import { NetworkError } from "@/components/feedback/network/NetworkError";
import { useAuth } from "@/lib/auth";
import { wsFromMembership, type Workspace } from "@/lib/workspaces";
import { AskProvider } from "@/routes/overview/AskProvider";

/**
 * Routed app shell. Mirrors the prototype's app.jsx frame exactly — the `.app`
 * container (data-type="rf") and `.main` region — with react-router's <Outlet>.
 * Workspaces + the selected workspace now come from the auth session; switching
 * re-scopes every query (see useAuth().setWorkspace).
 */
export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { memberships, workspaceId, setWorkspace } = useAuth();

  // Real per-workspace member counts (and plan) live on /v1/workspaces, which
  // carries `_count.members`; /v1/me does not. Merge the counts in by id.
  const { data: summaries } = useApi<WorkspaceSummary[]>(() => Workspaces.list());
  const memberCounts = useMemo(() => {
    const m = new Map<number, number>();
    (summaries ?? []).forEach((w) => m.set(w.id, w.memberCount ?? 0));
    return m;
  }, [summaries]);

  const workspaces: Workspace[] = useMemo(
    () => memberships.map((m) => wsFromMembership(m, memberCounts.get(m.workspaceId) ?? 0)),
    [memberships, memberCounts],
  );
  const currentWs = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];

  // Mobile shell: the sidebar becomes an off-canvas drawer opened from a top-bar
  // hamburger. `navOpen` drives it; it auto-closes on navigation (route change).
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Recordings is a full-screen analysis workspace → collapse the sidebar to the
  // icon rail. On mobile the sidebar is off-canvas (full, not a rail), so the
  // collapse only applies on desktop.
  const collapsed = !isMobile && location.pathname.startsWith("/recordings");

  /* The page below is UNMOUNTED while unreachable, so when the backend returns
     it remounts and its queries fire fresh. They'd hit cached ERROR entries
     under their own keys though, so invalidate on the offline→online edge and
     let the remount pull real data. This is what makes the state self-heal:
     the user gets their page back without clicking anything. */
  const reachable = useBackendReachable();
  const wasReachable = useRef(reachable);
  useEffect(() => {
    if (!wasReachable.current && reachable) void queryClient.invalidateQueries();
    wasReachable.current = reachable;
  }, [reachable]);

  // RequireAuth guarantees a workspace, but stay defensive during the boot flash.
  if (!currentWs) return null;

  return (
    <div className="app" data-type="rf">
      <Sidebar
        collapsed={collapsed}
        mobileOpen={isMobile && navOpen}
        workspaces={workspaces}
        currentWs={currentWs}
        /* Switching no longer reloads the document, so the navigate that used to
           ride inside setWorkspace lives here — routing is the shell's business,
           not the auth provider's. Both land in one commit: the sidebar repaints
           with the new name from `memberships` (already in memory) on the very
           next frame, and RequireAuth's key remounts the body into its
           skeletons. */
        onSwitchWs={(w) => {
          setWorkspace(w.id);
          navigate("/overview");
        }}
        onNewWs={() => navigate("/onboarding/workspace")}
      />
      {/* Mobile-only: tap-away scrim behind the off-canvas sidebar. */}
      {isMobile && navOpen && (
        <div className="side-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />
      )}
      <main className="main">
        {/* Mobile-only top bar: hamburger opens the sidebar, plus the current
            workspace name. Rendered only on mobile, so the desktop shell DOM is
            byte-for-byte unchanged. */}
        {isMobile && (
          <div className="m-topbar">
            <button className="m-burger" aria-label="Open menu" onClick={() => setNavOpen(true)}>
              <span />
              <span />
              <span />
            </button>
            <span className="m-topbar-title">{currentWs.name.replace(/,.*$/, "")}</span>
          </div>
        )}
        {/* The shell survives an outage — only the content region swaps, so the
            user keeps their bearings and can still navigate. AskProvider is
            inside the gate on purpose: its FAB would be dead while the backend
            is unreachable. */}
        {reachable ? (
          /* Ask AI (FAB + floating panel) mounts once here so it's available on
             every page and stays fixed as the page scrolls. */
          <AskProvider>
            <Outlet />
          </AskProvider>
        ) : (
          <NetworkError />
        )}
      </main>
    </div>
  );
}
