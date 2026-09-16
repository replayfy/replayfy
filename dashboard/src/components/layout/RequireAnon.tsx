import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/lib/auth";

/**
 * The inverse of RequireAuth: the sign-in / sign-up / password-reset shells are
 * meaningless for a signed-in user, so send them into the app rather than
 * render a second auth form over a live session.
 *
 * /verify is deliberately NOT behind this gate — it consumes a single-use token
 * from an email and mints the session itself (Verify.tsx calls setToken), so it
 * has to run whatever the current auth state is. Gating it would turn a valid
 * confirmation link into a silent redirect.
 */
export function RequireAnon() {
  const { status } = useAuth();
  if (status === "checking") return null; // same brief boot hold as RequireAuth
  if (status === "authed") return <Navigate to="/overview" replace />;
  return <Outlet />;
}
