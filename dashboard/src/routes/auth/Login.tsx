import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthMark, AuthShell } from "./AuthShell";
import { OAuthRow } from "./OAuthRow";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/feedback/toast";
import { isBackendReachable } from "@/api/health";
import { Auth } from "@/api/endpoints";
import { ApiError } from "@/api/client";

export function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await login(email, password);
      navigate("/overview");
    } catch (e) {
      // Three different failures, three different things to say. An ApiError
      // carries a message written for the user. A raw throw with the backend
      // unreachable is a connection problem, not a credentials one — and the
      // login screen sits OUTSIDE AppLayout, so the NetworkError banner that
      // would normally say so never renders here. Anything else falls back.
      const message =
        e instanceof ApiError
          ? e.message
          : // A TypeError out of fetch is the platform's signal that the request
            // never completed — DNS, connection refused, CORS. isBackendReachable
            // alone is not enough here: it is debounced by 1.2s to stop the app
            // shell flapping, so at the instant this toast is built it still
            // reads "online". Checking both gives the immediate truth AND stays
            // correct once the debounce has settled.
            e instanceof TypeError || !isBackendReachable()
            ? "Can't reach the server. Check your connection and try again."
            : e instanceof Error && e.message
              ? e.message
              : "Sign in failed";
      toast(message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  // "Email me a sign-in link instead" — actually sends the passwordless link now
  // (it used to just fire a toast). The response is always {ok:true} regardless
  // of whether the address has an account, so the confirmation never reveals it.
  const sendMagicLink = async () => {
    if (!email.trim()) {
      toast("Enter your email first, then request a link.", { kind: "err" });
      return;
    }
    try {
      await Auth.magicRequest(email.trim());
      toast(
        "Check your inbox — if that email has an account, a sign-in link is on its way.",
        { kind: "ok" },
      );
    } catch {
      toast("Couldn't send the link. Check your connection and try again.", {
        kind: "err",
      });
    }
  };

  return (
    <AuthShell>
      <AuthMark />
      <h1 className="av-h">Sign in to Replayfy</h1>
      <p className="av-sub">
        New to Replayfy?{" "}
        <button className="av-link" onClick={() => navigate("/signup")}>
          Create an account
        </button>
      </p>
      <div className="av-form">
        <label className="av-field">
          <span className="av-lab">Email</span>
          <input
            className="av-in"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoFocus
            autoComplete="email"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>
        <label className="av-field">
          <span className="av-lab">
            Password{" "}
            <button
              className="av-quiet"
              tabIndex={-1}
              onClick={(e) => {
                e.preventDefault();
                navigate("/forgot");
              }}
            >
              Forgot?
            </button>
          </span>
          <input
            className="av-in"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>
        <button className="av-btn" onClick={submit} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <div className="av-or">Or</div>
        <OAuthRow
          verb="Continue"
          onProvider={(p) => window.location.assign(Auth.oauthStartUrl(p))}
        />
      </div>
      <div className="av-foot">
        <button className="av-quiet" onClick={sendMagicLink} disabled={busy}>
          Email me a sign-in link instead
        </button>
      </div>
    </AuthShell>
  );
}
