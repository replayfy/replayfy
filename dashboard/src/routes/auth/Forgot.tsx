import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { AuthMark, AuthShell } from "./AuthShell";
import { Auth } from "@/api/endpoints";
import { ApiError } from "@/api/client";
import { useToast } from "@/components/feedback/toast";

export function Forgot() {
  const navigate = useNavigate();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !email) return;
    setBusy(true);
    try {
      await Auth.forgotPassword(email);
      setSent(true);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not send reset link", {
        kind: "err",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      {!sent ? (
        <>
          <AuthMark />
          <h1 className="av-h">Reset your password</h1>
          <p className="av-sub">
            Enter your work email and we'll send a secure reset link.
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
            <button className="av-btn" onClick={submit} disabled={busy}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="av-glyph">
            <Icon name="check" size={20} />
          </div>
          <h1 className="av-h">Check your email</h1>
          <p className="av-sub">
            We sent a reset link to your inbox. It expires in 30 minutes.
          </p>
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
