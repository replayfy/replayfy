import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { OnbShell } from "./OnbShell";
import { REGIONS } from "./Region.data";
import { useOnboarding } from "./OnboardingContext";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/feedback/toast";
import { Workspaces, Settings, type DataRegion } from "@/api/endpoints";
import { ApiError, setWorkspaceId } from "@/api/client";

export function Region() {
  const navigate = useNavigate();
  const toast = useToast();
  const { refresh } = useAuth();
  const { name, slug, region, setRegion, workspaceId, setCreated } = useOnboarding();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const dataRegion = region.toUpperCase() as DataRegion;
    try {
      let wsId = workspaceId;
      if (!wsId) {
        // Create the workspace (name + slug). The region is saved separately so a
        // pre-migration backend still creates the workspace.
        const { data } = await Workspaces.create({ name: name.trim() || slug, slug });
        wsId = data.id;
        setWorkspaceId(wsId); // scope subsequent calls to the new workspace
        setCreated(wsId);
        await refresh(); // pull the new workspace into the auth session
      }
      // Persist the deployment region — best-effort (the column requires the
      // deployment-region migration; this won't block onboarding until then).
      try {
        await Settings.region.set({ dataRegion });
      } catch {
        // region column pending migration — proceed
      }
      navigate('/onboarding/install');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not create workspace', { kind: 'err' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <OnbShell active={1} title="Where should your data live?" sub="Your region is permanent — it can't be changed after setup.">
      <div className="af-radiolist">
        {REGIONS.map((r) => (
          <button key={r.id} className={`af-radio-row ${region === r.id ? 'on' : ''}`} onClick={() => setRegion(r.id)}>
            <span className="af-radio-flag">{r.flag}</span>
            <span className="af-radio-txt"><span className="af-radio-name">{r.name}</span><span className="af-radio-ep">{r.ep}</span></span>
            <span className="af-radio">{region === r.id && <Icon name="check" size={12} />}</span>
          </button>
        ))}
      </div>
      <button className="av-btn" disabled={busy} onClick={submit}>Continue</button>
      <button className="af-onbc-back af-link" onClick={() => navigate('/onboarding/workspace')}>← Back</button>
    </OnbShell>
  );
}
