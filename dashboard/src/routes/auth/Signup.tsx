import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthMark, AuthShell } from "./AuthShell";
import { OAuthRow } from "./OAuthRow";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/feedback/toast";
import { Auth } from "@/api/endpoints";
import { ApiError } from "@/api/client";

export function Signup() {
  const navigate = useNavigate();
  const { signup } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const strength = Math.min(4, Math.floor(pw.length / 3));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const session = await signup({ email, password: pw });
      if (session.token) navigate("/onboarding/workspace");
      else {
        toast("Check your email to verify your account.", { kind: "ok" });
        setEmail("");
        setPw("");
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not create account", {
        kind: "err",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <AuthMark />
      <h1 className="av-h">Welcome to Replayfy</h1>
      <p className="av-sub">
        Already have an account?{" "}
        <button className="av-link" onClick={() => navigate("/login")}>
          Sign in
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
          <span className="av-lab">Password</span>
          <input
            className="av-in"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <span className="av-pw" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <i key={i} className={i < strength ? "on" : ""} />
            ))}
          </span>
        </label>
        <button className="av-btn" onClick={submit} disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
        <OAuthRow
          verb="Continue"
          onProvider={(p) => window.location.assign(Auth.oauthStartUrl(p))}
        />
        <div className="av-legal">
          By continuing, you agree to our{" "}
          <button className="av-link">Terms of Service</button> and{" "}
          <button className="av-link">Privacy Policy</button>.
        </div>
      </div>
    </AuthShell>
  );
}
