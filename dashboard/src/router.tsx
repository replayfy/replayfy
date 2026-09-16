import { Suspense, lazy, type ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { ee } from "@ee";
// Eager (main bundle) — the real full-page skeletons for the two distinctive
// layouts, used as their <Suspense> fallback so the chunk loads behind the
// actual page shape. Both pull in only skeleton bars (see routeFallbacks).
import { RecordingsFallback, FnDetailSkeleton } from "@/routes/routeFallbacks";
import { AppLayout } from "@/components/layout/AppLayout";
import { RequireAuth } from "@/components/layout/RequireAuth";
import { RequireAnon } from "@/components/layout/RequireAnon";
import { OnboardingLayout } from "@/routes/onboarding/OnboardingLayout";
import { SkPage } from "@/components/feedback";

/* ============================================================================
   Code-splitting.

   Every route below is loaded on demand. Previously all ~20 route components
   were static imports here, so Rollup emitted ONE entry chunk — measured at
   1,495 kB (463 kB gzip), with only a 4.5 kB worker beside it. That meant the
   login screen downloaded and parsed the entire product, including rrweb (~110
   kB gzip), which is reachable only through Recordings → RvStage → RvPlayer →
   RvWebPlayer and is useless until someone opens a session.

   The layouts/guards stay EAGER on purpose: they render on literally every
   navigation, they are small, and lazy-loading a shell only adds a waterfall in
   front of the page you actually want.

   Components used by more than one path (Recordings, Settings, Users,
   SharePage) are declared ONCE and referenced from each route, so the two paths
   share a single chunk and React reconciles the same component type across them
   rather than remounting — which matters for Recordings, whose player state must
   survive /recordings → /recordings/:id.
   ========================================================================== */

/* React.lazy wants a module whose `default` is the component; these routes all
   use named exports, hence the .then() remap on each. */
const Overview = lazy(() =>
  import("@/routes/overview/Overview").then((m) => ({ default: m.Overview })),
);
const Recordings = lazy(() =>
  import("@/routes/recordings/Recordings").then((m) => ({
    default: m.Recordings,
  })),
);
const Funnels = lazy(() =>
  import("@/routes/funnels/Funnels").then((m) => ({ default: m.Funnels })),
);
const Crashlytics = lazy(() =>
  import("@/routes/crashlytics/Crashlytics").then((m) => ({
    default: m.Crashlytics,
  })),
);
const Analytics = lazy(() =>
  import("@/routes/analytics/Analytics").then((m) => ({ default: m.Analytics })),
);
const FunnelDetail = lazy(() =>
  import("@/routes/funnels/FunnelDetail").then((m) => ({
    default: m.FunnelDetail,
  })),
);
const Users = lazy(() =>
  import("@/routes/users/Users").then((m) => ({ default: m.Users })),
);
const Cohorts = lazy(() =>
  import("@/routes/cohorts/Cohorts").then((m) => ({ default: m.Cohorts })),
);
const Alerts = lazy(() =>
  import("@/routes/alerts/Alerts").then((m) => ({ default: m.Alerts })),
);
const Comments = lazy(() =>
  import("@/routes/comments/Comments").then((m) => ({ default: m.Comments })),
);
const Settings = lazy(() =>
  import("@/routes/settings/Settings").then((m) => ({ default: m.Settings })),
);
const SharePage = lazy(() =>
  import("@/routes/share/SharePage").then((m) => ({ default: m.SharePage })),
);
const Login = lazy(() =>
  import("@/routes/auth/Login").then((m) => ({ default: m.Login })),
);
const Signup = lazy(() =>
  import("@/routes/auth/Signup").then((m) => ({ default: m.Signup })),
);
const Forgot = lazy(() =>
  import("@/routes/auth/Forgot").then((m) => ({ default: m.Forgot })),
);
const ResetPassword = lazy(() =>
  import("@/routes/auth/ResetPassword").then((m) => ({
    default: m.ResetPassword,
  })),
);
const Verify = lazy(() =>
  import("@/routes/auth/Verify").then((m) => ({ default: m.Verify })),
);
const OnbWorkspace = lazy(() =>
  import("@/routes/onboarding/Workspace").then((m) => ({
    default: m.Workspace,
  })),
);
const OnbRegion = lazy(() =>
  import("@/routes/onboarding/Region").then((m) => ({ default: m.Region })),
);
const OnbInstall = lazy(() =>
  import("@/routes/onboarding/Install").then((m) => ({ default: m.Install })),
);
const OnbSuccess = lazy(() =>
  import("@/routes/onboarding/Success").then((m) => ({ default: m.Success })),
);

/** App-shell route: the sidebar is already on screen, so the chunk loads behind
 *  the page skeleton the rest of the app uses for loading states. */
const app = (el: ReactNode, kind?: string, fallback?: ReactNode) => (
  // `fallback` lets a route show its OWN full-page skeleton while the chunk
  // downloads (recordings / funnel detail — distinctive layouts the generic
  // SkPage can't fake); everything else uses the shared SkPage by `kind`.
  <Suspense fallback={fallback ?? <SkPage kind={kind} />}>{el}</Suspense>
);
/** Full-viewport shell (auth / onboarding / public share): there is no dashboard
 *  chrome to skeleton against, and these chunks are small, so a dashboard
 *  skeleton would be worse than a brief blank. */
const bare = (el: ReactNode) => <Suspense fallback={null}>{el}</Suspense>;

// Enterprise Edition /billing/plans element (lazy). null in the open-source
// build → the route below is omitted. Capitalized local so it reads as a JSX
// component and narrows to non-null inside the guard.
const ChangePlanRoute = ee.ChangePlanRoute;

/**
 * Route table. The app shell (Sidebar + <Outlet>) lives under "/"; auth and
 * onboarding are full-viewport shells and sit as top-level siblings.
 */
export const router = createBrowserRouter([
  {
    element: <RequireAuth />,
    children: [
      {
        path: "/",
        element: <AppLayout />,
        children: [
          { index: true, element: <Navigate to="/overview" replace /> },
          { path: "overview", element: app(<Overview />, "dashboard") },
          {
            path: "recordings",
            element: app(<Recordings />, "list", <RecordingsFallback />),
          },
          {
            path: "recordings/:recordingId",
            element: app(<Recordings />, "list", <RecordingsFallback />),
          },
          { path: "funnels", element: app(<Funnels />, "list") },
          { path: "analytics", element: app(<Analytics />, "dashboard") },
          { path: "crashlytics", element: app(<Crashlytics />, "list") },
          {
            path: "funnels/:funnelId",
            element: app(<FunnelDetail />, "funnels", <FnDetailSkeleton />),
          },
          { path: "users", element: app(<Users />) },
          { path: "users/:userId", element: app(<Users />) },
          { path: "cohorts", element: app(<Cohorts />) },
          { path: "alerts", element: app(<Alerts />, "list") },
          { path: "comments", element: app(<Comments />, "list") },
          {
            path: "settings",
            element: <Navigate to="/settings/general" replace />,
          },
          { path: "settings/:tab", element: app(<Settings />) },
          {
            path: "settings/integrations/:integration",
            element: app(<Settings />),
          },
          { path: "*", element: <Navigate to="/overview" replace /> },
        ],
      },
      // Dedicated full-screen billing flow — a SIBLING of the app shell (not
      // inside AppLayout), so it renders with no sidebar / Settings nav, still
      // behind RequireAuth. "Back to Billing" returns to /settings/billing.
      // Enterprise Edition: the route exists only in the cloud build; the
      // open-source build (ee absent) omits it entirely and any /billing/plans
      // link falls through to the "*" redirect → /overview.
      ...(ChangePlanRoute
        ? [{ path: "/billing/plans", element: bare(<ChangePlanRoute />) }]
        : []),
    ],
  },
  // Public shared-recording viewer — a top-level sibling OUTSIDE <RequireAuth>
  // so an unauthenticated recipient is never bounced to /login. The page itself
  // resolves the token via the unauthenticated Share.* client.
  //
  // `/share/:token` is the canonical path because it is the one the BACKEND
  // mints: sessions.service.ts returns `url: /share/${token}`, which the share
  // modal turns into `${origin}${url}`. This route only existed as `/s/:token`,
  // so every link the product has ever generated 404'd here. `/s/:token` stays
  // as an alias — the modal falls back to it when a response carries a bare
  // token and no url, and any link already copied from that path keeps working.
  { path: "/share/:token", element: bare(<SharePage />) },
  { path: "/s/:token", element: bare(<SharePage />) },
  // Auth shells are anon-only: signing in again over a live session is never
  // meaningful, and /signup would mint a second account under the first's
  // still-cached workspace. `/verify` stays OUTSIDE the gate — it consumes a
  // one-time email token and issues the session itself, so it must run in any
  // auth state (see RequireAnon).
  {
    element: <RequireAnon />,
    children: [
      { path: "/login", element: bare(<Login />) },
      { path: "/signup", element: bare(<Signup />) },
      { path: "/forgot", element: bare(<Forgot />) },
      { path: "/reset-password", element: bare(<ResetPassword />) },
    ],
  },
  { path: "/verify", element: bare(<Verify />) },
  {
    path: "/onboarding",
    element: <OnboardingLayout />,
    children: [
      { path: "workspace", element: bare(<OnbWorkspace />) },
      { path: "region", element: bare(<OnbRegion />) },
      { path: "install", element: bare(<OnbInstall />) },
      { path: "success", element: bare(<OnbSuccess />) },
    ],
  },
]);
