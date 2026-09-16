import { Fragment, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { Logo } from "@/routes/auth/Logo";
import { useAuth } from "@/lib/auth";

const ONB_STEPS = ["workspace", "region", "install"];

/* minimal ●──●──○ progress row */
function OnbDots({ active, total }: { active: number; total: number }) {
  return (
    <div
      className="af-dots"
      role="progressbar"
      aria-valuenow={active + 1}
      aria-valuemax={total}
      style={{ justifyContent: "center" }}
    >
      {Array.from({ length: total }).map((_, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className={`af-dots-bar ${i <= active ? "done" : ""}`} />
          )}
          <span
            className={`af-dots-dot ${i === active ? "on" : i < active ? "done" : ""}`}
          >
            {i < active && <Icon name="check" size={9} />}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

type OnbShellProps = {
  active: number;
  title: string;
  sub: string;
  children: ReactNode;
  wide?: boolean;
};

/* One decision per screen: product mark top-left, the signed-in identity
   top-right, a centered column with the step's single question. A user who
   already belongs to a workspace gets a way back into the product instead
   of the plain mark. */
export function OnbShell({
  active,
  title,
  sub,
  children,
  wide,
}: OnbShellProps) {
  const navigate = useNavigate();
  const { user, logout, memberships } = useAuth();
  const hasWorkspace = memberships.length > 0;
  return (
    <div className="av-root">
      <div className="av-top">
        {active > 0 ? (
          <button
            className="av-back"
            onClick={() => navigate("/onboarding/" + ONB_STEPS[active - 1])}
          >
            <Icon
              name="chev"
              size={12}
              style={{ transform: "rotate(90deg)" }}
            />{" "}
            Back
          </button>
        ) : hasWorkspace ? (
          <button className="av-back" onClick={() => navigate("/overview")}>
            <Icon
              name="chev"
              size={12}
              style={{ transform: "rotate(90deg)" }}
            />{" "}
            Back to Replayfy
          </button>
        ) : (
          <Logo size={22} />
        )}
        <div className="av-id">
          <span className="k">Logged in as</span>
          <span className="e">{user?.email ?? "…"}</span>
        </div>
      </div>
      <div className="av-main" style={{ paddingTop: "9vh" }}>
        <div className={`av-card ${wide ? "wide" : ""}`} key={active}>
          <OnbDots active={active} total={ONB_STEPS.length} />
          <h1 className="av-h" style={{ marginTop: "var(--sp-20)" }}>
            {title}
          </h1>
          <p className="av-sub">{sub}</p>
          <div className="av-form" style={{ marginTop: "var(--sp-24)" }}>
            {children}
          </div>
        </div>
      </div>
      <div className="av-footbar">
        <button
          className="av-quiet"
          onClick={async () => {
            await logout();
            navigate("/login");
          }}
        >
          Use a different account
        </button>
      </div>
    </div>
  );
}
