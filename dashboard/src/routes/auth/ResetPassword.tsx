import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { AuthMark, AuthShell } from "./AuthShell";
import { Auth } from "@/api/endpoints";
import { ApiError } from "@/api/client";
import { useToast } from "@/components/feedback/toast";

/** /reset-password?token=… — the target of the reset link emailed by Forgot. */
export function ResetPassword() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const toast = useToast();
  const [pw, setPw] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const strength = Math.min(4, Math.floor(pw.length / 3));

  const submit = async () => {
    if (busy || !pw) return;
    setBusy(true);
    try {
      await Auth.resetPassword({ token, password: pw });
      setDone(true);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not reset password", {
        kind: "err",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      {!done ? (
        <>
          <AuthMark />
          <h1 className="av-h">Choose a new password</h1>
          <p className="av-sub">Enter a new password for your account.</p>
          <div className="av-form">
            <label className="av-field">
              <span className="av-lab">New password</span>
              <input
                className="av-in"
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="At least 8 characters"
                autoFocus
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
              {busy ? "Updating…" : "Reset password"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="av-glyph">
            <Icon name="check" size={20} />
          </div>
          <h1 className="av-h">Password updated</h1>
          <p className="av-sub">You can now sign in with your new password.</p>
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
