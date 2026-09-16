import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { Logo } from "@/routes/auth/Logo";
import { SIGNALS } from "./Success.data";
import { useOnboarding } from "./OnboardingContext";

export function Success() {
  const navigate = useNavigate();
  const { name } = useOnboarding();
  return (
    <div className="af-root af-onbc">
      <div className="af-onbc-top">
        <Logo size={24} />
      </div>
      <div className="af-onbc-main">
        <div className="af-onbc-inner af-onbc-done">
          <div className="af-live-pill">
            <span className="af-live-dot" /> First session received
          </div>
          <h1 className="af-onbc-h" style={{ marginTop: "var(--sp-16)" }}>
            You're live.
          </h1>
          <p className="af-onbc-sub">
            Replayfy is now capturing <b>{name || "your workspace"}</b>. Your
            dashboard updates in real time as sessions arrive.
          </p>
          <div className="af-warm">
            <div className="af-warm-h">
              <span className="ai-badge">
                <Icon name="spark" size={9} fill /> Replayfy AI
              </span>{" "}
              is warming up
            </div>
            <div className="af-signal-list">
              {SIGNALS.map((s) => (
                <div className="af-signal" key={s[1]}>
                  <span className="af-signal-ic">
                    <Icon name={s[0]} size={13} />
                  </span>
                  {s[1]}
                  <span className="af-signal-check">
                    <Icon name="check" size={12} />
                  </span>
                </div>
              ))}
            </div>
          </div>
          <button className="av-btn" onClick={() => navigate("/overview")}>
            Go to dashboard →
          </button>
        </div>
      </div>
    </div>
  );
}
