import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { InstallSnippet } from "@/components/install";
import { OnbShell } from "./OnbShell";
import { REGIONS } from "./Region.data";
import { useOnboarding } from "./OnboardingContext";
import { ApiKeys, Dashboard } from "@/api/endpoints";
import { SNIP, fillSnippet } from "@/routes/settings/settings.data";

type ApiKeyRow = { prefix?: string; rawKey?: string };
type Counts = { sessions?: number; total?: number };

export function Install() {
  const navigate = useNavigate();
  const { region, apiKey, setApiKey } = useOnboarding();
  const [plat, setPlat] = useState("web");
  const [key, setKey] = useState<string | null>(apiKey);
  const [live, setLive] = useState(false);
  const regionEp = (
    REGIONS.find((r) => r.id === region)?.ep || "us-east-1"
  ).split(" · ")[0];

  // Fetch (or create) a public SDK key so the snippet shows the real project id.
  //
  // ONE idempotent call, deliberately. This was list-then-create, and the two
  // halves were a read-then-write race with nothing holding it closed: React
  // StrictMode runs the effect twice, both passes read an empty list, and both
  // POSTed — so every fresh workspace was provisioned with two "Production"
  // keys. /bootstrap serialises the check and the mint behind a per-workspace
  // advisory lock server-side, so calling it any number of times yields exactly
  // one key. The `cancelled` flag now only guards setState after unmount, which
  // is all it was ever able to do.
  useEffect(() => {
    if (key) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await ApiKeys.bootstrap<ApiKeyRow>();
        // rawKey only comes back on the call that actually minted it; every
        // later call can only offer the prefix — which is what a PUBLIC key
        // embeds in the snippet anyway.
        const found = data.rawKey ?? data.prefix;
        if (!cancelled && found) {
          setKey(found);
          setApiKey(found);
        }
      } catch {
        // keep the placeholder if the key can't be read/created
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, setApiKey]);

  // Poll ingest for the first session so the "waiting" pill can flip live.
  useEffect(() => {
    if (live) return;
    const t = setInterval(async () => {
      try {
        const { data } = await Dashboard.counts();
        const n = (data as Counts).sessions ?? (data as Counts).total ?? 0;
        if (n > 0) {
          setLive(true);
          clearInterval(t);
        }
      } catch {
        // ignore poll errors
      }
    }, 4000);
    return () => clearInterval(t);
  }, [live]);

  const code = key ? fillSnippet(SNIP[plat].code, key) : SNIP[plat].code;

  return (
    <OnbShell
      active={2}
      wide
      title="Install the SDK"
      sub="Drop this into your app and we'll start capturing sessions automatically."
    >
      {/* Picker + Copy only: the region, language chip and filename are file
          context that belongs on Settings, not on the one step whose whole job
          is "take this and paste it". */}
      <InstallSnippet
        platform={plat}
        onPlatform={setPlat}
        code={code}
        showMeta={false}
      />
      <div className="af-wait">
        <span className="af-pulse" />{" "}
        {live ? "First event received!" : "Waiting for your first event…"}
      </div>
      <button
        className="av-btn"
        onClick={() => navigate("/onboarding/success")}
      >
        I've installed it
      </button>
      <div className="af-onbc-dual">
        <button
          className="af-link"
          onClick={() => navigate("/onboarding/region")}
        >
          ← Back
        </button>
        <button
          className="af-link"
          onClick={() => navigate("/onboarding/success")}
        >
          Skip for now
        </button>
      </div>
    </OnbShell>
  );
}
