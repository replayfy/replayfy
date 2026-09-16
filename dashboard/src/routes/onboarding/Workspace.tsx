import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { Workspaces } from "@/api/endpoints";
import { OnbShell } from "./OnbShell";
import { useOnboarding } from "./OnboardingContext";

/** The URL check runs while you type, so a taken slug is caught here rather
 *  than surfacing as a failed create two screens later. "error" deliberately
 *  does NOT block: the check is advisory, and the create answers a clean 409
 *  if it is ever raced or the check never landed. */
type SlugState = "idle" | "checking" | "free" | "taken" | "error";

export function Workspace() {
  const navigate = useNavigate();
  const { name, setName, slug } = useOnboarding();
  const [slugState, setSlugState] = useState<SlugState>("idle");

  useEffect(() => {
    if (!slug) {
      setSlugState("idle");
      return undefined;
    }
    // Re-running on every keystroke cancels the previous timer AND flags the
    // in-flight reply stale, so a slow answer for an old slug can never
    // overwrite the current one.
    let stale = false;
    setSlugState("checking");
    const t = setTimeout(() => {
      Workspaces.slugAvailable(slug)
        .then(({ data }) => {
          if (!stale) setSlugState(data.available ? "free" : "taken");
        })
        .catch(() => {
          if (!stale) setSlugState("error");
        });
    }, 350);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [slug]);

  const taken = slugState === "taken";

  return (
    <OnbShell
      active={0}
      title="Create a workspace"
      sub="Session replay, crashes and product analytics for your apps — in one place."
    >
      <label className="av-field">
        <span className="av-lab">Name</span>
        <input
          className="av-in"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="Acme Inc"
        />
      </label>
      <label className="av-field">
        <span className="av-lab">URL</span>
        <span className={`av-affix ${taken ? "bad" : ""}`}>
          <span className="pfx">replayfy.io/</span>
          <input value={slug} readOnly aria-label="Workspace URL" />
          {slug && slugState !== "idle" && slugState !== "error" && (
            <span className={`sfx ${taken ? "bad" : ""}`} aria-live="polite">
              {slugState === "checking" ? (
                "checking…"
              ) : taken ? (
                <>
                  <Icon name="warn" size={12} /> taken
                </>
              ) : (
                <>
                  <Icon name="check" size={12} /> available
                </>
              )}
            </span>
          )}
        </span>
      </label>
      <button
        className="av-btn"
        style={{ marginTop: "var(--sp-8)" }}
        disabled={!name.trim() || slugState === "checking" || taken}
        onClick={() => navigate("/onboarding/region")}
      >
        Continue
      </button>
    </OnbShell>
  );
}
