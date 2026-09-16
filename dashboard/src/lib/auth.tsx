import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Auth, type AuthSession, type MeResponse, type MembershipSummary, type SessionUser } from "@/api/endpoints";
import {
  ApiError,
  getToken,
  setToken,
  getWorkspaceId,
  setWorkspaceId,
  getLastWorkspace,
  setLastWorkspace,
} from "@/api/client";
import { queryClient } from "@/api/queryClient";
import { clearRecents } from "@/routes/recordings/search/search.data";
import { asRole, can, type Can, type WorkspaceRole } from "@/lib/roles";

type AuthStatus = "checking" | "authed" | "anon";

type AuthContextValue = {
  status: AuthStatus;
  user: SessionUser | null;
  memberships: MembershipSummary[];
  workspaceId: number | null;
  /** The signed-in person's role in the ACTIVE workspace, normalised.
   *  Derived here because the alternative — every consumer re-running the
   *  memberships.find() itself — is why exactly one place in the whole app
   *  ever read the role, and only to print it next to a name. */
  role: WorkspaceRole | null;
  /** What that role may do. Mirrors the server guard; the API enforces it
   *  again regardless. */
  can: Can;
  login: (email: string, password: string) => Promise<void>;
  signup: (body: { email: string; password: string; name?: string }) => Promise<AuthSession>;
  logout: () => Promise<void>;
  setWorkspace: (id: number) => void;
  /** Re-read the session. Resolves TRUE when it loaded; callers that only want
   *  a refresh can ignore it. */
  refresh: () => Promise<boolean>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/** The OAuth callback may deliver the JWT via ?token= or #token=. */
function readOAuthToken(): string | null {
  const url = new URL(window.location.href);
  const q = url.searchParams.get("token");
  if (q) return q;
  const hash = window.location.hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("token");
}
function scrubToken(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("token");
  window.history.replaceState({}, "", url.pathname + url.search);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [memberships, setMemberships] = useState<MembershipSummary[]>([]);
  const [workspaceId, setWsId] = useState<number | null>(getWorkspaceId());

  /* Identity behind the current query cache. The cache is keyed by WORKSPACE,
     never by user (useApi.ts:41), so two members of the same workspace produce
     byte-identical keys — a cache that outlives a sign-in would serve the next
     user their predecessor's data, including role-gated reads (members,
     invites, API keys, the BYOK provider key). Tracked here rather than cleared
     on every login so that the SAME user signing back in keeps their cache. */
  const cacheUserIdRef = useRef<number | null>(null);

  const applyMe = useCallback((me: MeResponse) => {
    if (cacheUserIdRef.current !== null && cacheUserIdRef.current !== me.user.id) {
      queryClient.clear();
    }
    cacheUserIdRef.current = me.user.id;
    setUser(me.user);
    setMemberships(me.memberships);
    /* Which workspace to open, in order of how much it's worth:
       1. the ACTIVE pointer — set while signed in, so a refresh or a mid-session
          switch keeps you exactly where you are;
       2. failing that (a fresh sign-in — logout drops the pointer), where THIS
          user last was;
       3. failing that, their first membership.
       The remembered value is checked second, never first: it must not overrule
       a workspace you switched to five seconds ago and then refreshed. */
    let ws = getWorkspaceId() ?? getLastWorkspace(me.user.id);
    if (!ws || !me.memberships.some((m) => m.workspaceId === ws)) {
      // Covers a remembered workspace they've since been removed from, so the
      // stored id is a hint and never an authority.
      ws = me.memberships[0]?.workspaceId ?? null;
    }
    setWorkspaceId(ws);
    setWsId(ws);
    setStatus("authed");
  }, []);

  /* Dismiss the boot splash (index.html) once the session question is answered
     — `authed` OR `anon`, so the login screen is covered too, not just the app.
     Faded via a class rather than removed outright so the transition can play,
     then dropped from the DOM.

     The timeout is a safety net, not the mechanism: `Auth.me()` resolves either
     way, but a request that never settles (no response, no error) would leave
     the splash up forever and trap the user behind it. Revealing whatever is
     underneath beats a permanent curtain. */
  useEffect(() => {
    if (status === "checking") return;
    const el = document.getElementById("boot");
    if (!el) return;
    el.classList.add("boot-done");
    const t = setTimeout(() => el.remove(), 400);
    return () => clearTimeout(t);
  }, [status]);
  useEffect(() => {
    const bail = setTimeout(() => {
      document.getElementById("boot")?.classList.add("boot-done");
    }, 8000);
    return () => clearTimeout(bail);
  }, []);

  /** Resolves TRUE when the session actually loaded. Callers that must know —
   *  sign-in — check it; the background refresh keeps ignoring it. */
  const loadMe = useCallback(async (): Promise<boolean> => {
    let data: MeResponse;
    try {
      data = (await Auth.me()).data;
    } catch (e) {
      // Clear the token ONLY on a real auth failure (401/403). Transient errors
      // (network blips, dev-time HMR) must NOT delete the session — keep the
      // token so the next load recovers; just fall back to anon so nothing hangs.
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setToken(null);
        setWorkspaceId(null);
        // The session is definitively over, so its cache must not outlive it:
        // an expiry drops to /login WITHOUT a reload, so whoever signs in next
        // would otherwise inherit these entries in memory.
        queryClient.clear();
        cacheUserIdRef.current = null;
      }
      setUser(null);
      setMemberships([]);
      setWsId(null);
      setStatus("anon");
      return false;
    }
    applyMe(data);
    return true;
  }, [applyMe]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const magicToken = url.searchParams.get("magic");
    const oauthToken = readOAuthToken();
    void (async () => {
      if (magicToken) {
        // Passwordless sign-in link: exchange the one-time token for a session,
        // then scrub it from the URL so a refresh can't replay a spent link.
        try {
          const { data } = await Auth.magicConsume(magicToken);
          if (data.token) setToken(data.token);
        } catch {
          /* invalid/expired/used — fall through to the normal anon flow */
        }
        const u = new URL(window.location.href);
        u.searchParams.delete("magic");
        window.history.replaceState({}, "", u.pathname + u.search);
      } else if (oauthToken) {
        setToken(oauthToken);
        scrubToken();
      }
      if (getToken()) void loadMe();
      else setStatus("anon");
    })();
  }, [loadMe]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { data } = await Auth.login({ email, password });
      if (data.token) setToken(data.token);
      // If the session cannot actually be loaded, roll the token back before
      // rethrowing. Without this a failing /v1/me left the token in storage —
      // so the app was half-signed-in: the tree re-rendered as authenticated
      // (which is why the login fields cleared), the error surfaced into a
      // component that was already being torn down (which is why no toast
      // appeared), and a reload would land on a "signed in" shell with nothing
      // in it. Failing all the way back to the login screen is the honest
      // outcome, and it is what lets the caller show the error.
      /* Deliberately NOT seeding the workspace from the session response. That
         seed is the server's default, and setting it here made getWorkspaceId()
         non-null before applyMe ran — so the "open where I left off" branch could
         never be reached on the one path that exists for it. applyMe resolves it
         instead (remembered → first membership), which is strictly better: the
         server's default IS the first membership. Safe to drop because /v1/me is
         guarded by JwtUserGuard and reads only the user id — it never looks at
         the x-workspace-id header, so nothing in this window needs one. */
      // loadMe deliberately SWALLOWS a non-401 failure so a network blip cannot
      // delete a live session — right for the background refresh, wrong here.
      // During sign-in a failed /v1/me means the sign-in did not work: without
      // this the token stayed in storage, the tree re-rendered as authenticated
      // (which is why the fields cleared), login() returned normally so the
      // caller's catch never ran (which is why no toast appeared), and a reload
      // landed on a signed-in shell with nothing in it. Fail all the way back to
      // the login screen instead, which is what lets the caller show the error.
      if (!(await loadMe())) {
        setToken(null);
        throw new Error(
          "Signed in, but your account couldn't be loaded. Please try again.",
        );
      }
    },
    [loadMe],
  );

  const signup = useCallback(
    async (body: { email: string; password: string; name?: string }) => {
      const { data } = await Auth.signup(body);
      if (data.token) {
        setToken(data.token);
        if (data.workspaceId) setWorkspaceId(data.workspaceId);
        await loadMe();
      }
      return data;
    },
    [loadMe],
  );

  /* Normalised once, from the membership that matches the active workspace.
     asRole() tolerates the three casings the app produces (/v1/me sends
     UPPERCASE, the Team panel renders Title Case) and yields null for
     anything it does not recognise — so an unknown role is powerless
     rather than accidentally powerful. */
  const role = useMemo(
    () => asRole(memberships.find((m) => m.workspaceId === workspaceId)?.role),
    [memberships, workspaceId],
  );
  const permissions = useMemo(() => can(role), [role]);

  const logout = useCallback(async () => {
    try {
      await Auth.logout();
    } catch {
      // best-effort — the token is dropped regardless
    }
    /* Remember where they were BEFORE dropping the pointer — this is the whole
       point of the key, and it has to read the active id while it still exists.
       Keyed to the user who is leaving (cacheUserIdRef, set by applyMe), so the
       next person to sign in on this browser gets their own answer, not this
       one's. */
    const leavingUserId = cacheUserIdRef.current;
    const leavingWs = getWorkspaceId();
    if (leavingUserId !== null && leavingWs !== null) {
      setLastWorkspace(leavingUserId, leavingWs);
    }
    setToken(null);
    setWorkspaceId(null);
    queryClient.clear();
    /* queryClient.clear() drops the fetched data, but recent searches live in
       localStorage and would otherwise outlive the session — they can name this
       account's customers, and the next person to sign in on a shared machine
       reads them out of the search box. */
    clearRecents();
    cacheUserIdRef.current = null;
    setUser(null);
    setMemberships([]);
    setWsId(null);
    setStatus("anon");
  }, []);

  /** Switching workspace re-scopes every query on its own: the workspace id is
   *  the second element of EVERY query key (useApi.ts — `["api",
   *  getWorkspaceId(), …]`, and nothing calls useQuery directly), so flipping it
   *  changes every key and the cache refetches under the new scope. That is what
   *  the key is FOR.
   *
   *  This used to `window.location.assign("/overview")`, justified as "a reload
   *  is the clean re-scope, since workspace id is baked into each query key" —
   *  but the id being in the key is the reason a reload is UNNECESSARY, not the
   *  reason it's needed. The teardown threw away the bundle, 21 stylesheets, two
   *  font round trips, the React tree and the whole cache, then spent a /v1/me
   *  round trip re-learning an identity that was in memory 5ms earlier. The
   *  blank that showed while it did (RequireAuth's `return null`) was the "flash
   *  when switching workspace".
   *
   *  The two writes must stay ADJACENT: useApi reads the id from localStorage at
   *  RENDER, while the remount that re-scopes the tree is keyed off this React
   *  state (see RequireAuth). Landing both in one tick is what stops a remounted
   *  subtree from querying under the previous id. Don't move either into an
   *  effect.
   *
   *  Routing is the caller's business — this provider sits outside RouterProvider
   *  (main.tsx) and cannot useNavigate(). */
  const setWorkspace = useCallback((id: number) => {
    setWorkspaceId(id);
    setWsId(id);
  }, []);

  return (
    <AuthContext.Provider
      value={{ status, user, memberships, workspaceId, role, can: permissions, login, signup, logout, setWorkspace, refresh: loadMe }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
