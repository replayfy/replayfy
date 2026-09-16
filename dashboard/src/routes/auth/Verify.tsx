import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { AuthMark, AuthShell } from "./AuthShell";
import { Auth } from "@/api/endpoints";
import { ApiError, setToken, setWorkspaceId } from "@/api/client";
import { useToast } from "@/components/feedback/toast";

/** /verify?token=… — the target of the confirmation link emailed at signup. */
export function Verify() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const toast = useToast();
  const [status, setStatus] = useState<"checking" | "ok" | "error">("checking");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  // Guard against React 18 StrictMode double-invoking the effect (which would
  // consume the single-use token twice); verify exactly once per mount.
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      try {
        const { data } = await Auth.verify(token);
        // Persist the returned session the same way login/signup do, then let
        // the app boot authenticated.
        if (data.token) {
          setToken(data.token);
          if (data.workspaceId) setWorkspaceId(data.workspaceId);
          setStatus("ok");
          navigate(data.firstWorkspace ? "/onboarding/workspace" : "/overview");
          return;
        }
        // Verified but no session issued — send them to sign in.
        setStatus("ok");
        navigate("/login");
      } catch (e) {
        if (e instanceof ApiError && e.message)
          toast(e.message, { kind: "err" });
        setStatus("error");
      }
    })();
  }, [token, navigate, toast]);

  const resend = async () => {
    if (busy || !email) return;
    setBusy(true);
    try {
      await Auth.resendVerification(email);
      toast("Verification email sent. Check your inbox.", { kind: "ok" });
      setEmail("");
    } catch (e) {
      toast(
        e instanceof ApiError ? e.message : "Could not resend verification",
        { kind: "err" },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      {status === "checking" ? (
        <>
          <AuthMark />
          <h1 className="av-h">Verifying your email…</h1>
          <p className="av-sub">One moment while we confirm your account.</p>
        </>
      ) : status === "ok" ? (
        <>
          <div className="av-glyph">
            <Icon name="check" size={20} />
          </div>
          <h1 className="av-h">Email verified</h1>
          <p className="av-sub">Your account is confirmed. Taking you in…</p>
        </>
      ) : (
        <>
          <AuthMark />
          <h1 className="av-h">This link didn’t work</h1>
          <p className="av-sub">
            The verification link is invalid or has expired. Enter your email to
            get a new one.
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
                  if (e.key === "Enter") resend();
                }}
              />
            </label>
            <button className="av-btn" onClick={resend} disabled={busy}>
              {busy ? "Sending…" : "Resend verification"}
            </button>
          </div>
        </>
      )}
      <div className="av-foot">
        <button className="av-quiet" onClick={() => navigate("/login")}>
          ← Back to sign in
        </button>
      </div>
    </AuthShell>
  );
}
