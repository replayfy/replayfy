import { Suspense, type ComponentType } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Sk } from "@/components/feedback";
import { useAuth } from "@/lib/auth";
import { Meta } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { PANEL_DESC } from "./settings.data";
import { PanelGeneral } from "./panels/PanelGeneral";
import { PanelRecording } from "./panels/PanelRecording";
import { PanelMasking } from "./panels/PanelMasking";
import { PanelRetention } from "./panels/PanelRetention";
import { PanelSampling } from "./panels/PanelSampling";
import { PanelAI } from "./panels/PanelAI";
import { PanelTeam } from "./panels/PanelTeam";
import { PanelIntegrations } from "./panels/PanelIntegrations";
import { PanelInstall } from "./panels/PanelInstall";
import { ee } from "@ee";

type PanelDef = {
  id: string;
  label: string;
  Comp: ComponentType<{ openId?: string }>;
};

const PANELS: PanelDef[] = [
  { id: "general", label: "General", Comp: PanelGeneral },
  { id: "recording", label: "Recording", Comp: PanelRecording },
  { id: "masking", label: "Privacy & masking", Comp: PanelMasking },
  { id: "retention", label: "Retention", Comp: PanelRetention },
  { id: "sampling", label: "Sampling", Comp: PanelSampling },
  { id: "ai", label: "AI", Comp: PanelAI },
  { id: "team", label: "Team", Comp: PanelTeam },
  { id: "integrations", label: "Integrations", Comp: PanelIntegrations },
  { id: "install", label: "Install", Comp: PanelInstall },
  // Billing is Enterprise Edition — the tab exists only in the cloud build
  // (ee.BillingPanel present). The open-source build has no billing backend,
  // so the tab is simply absent and /settings/billing falls back to General.
  ...(ee.BillingPanel
    ? [{ id: "billing", label: "Billing", Comp: ee.BillingPanel }]
    : []),
];

export function Settings() {
  const navigate = useNavigate();
  const { tab: tabParam, integration } = useParams();
  const { workspaceId, memberships, can } = useAuth();
  const wsName =
    memberships.find((m) => m.workspaceId === workspaceId)?.workspace.name ??
    "";
  // /settings/integrations/:integration also routes here — force the tab so the
  // left nav highlights Integrations and the panel opens the deep-linked one.
  /* A viewer was invited to "watch recordings only", and the API now refuses
     them every settings read — so this page would render its chrome around a
     row of failed requests. Bounce instead. Not a security control (the server
     is); this is the UI declining to offer a door that is locked. Covers the
     deep link too: PANELS.find() below never checked anything, so typing
     /settings/team was always enough. */
  if (!can.seeSettings) return <Navigate to="/overview" replace />;
  const activeTab = integration != null ? "integrations" : tabParam;
  const P = PANELS.find((p) => p.id === activeTab) ?? PANELS[0];
  const tab = P.id;
  const Comp = P.Comp;
  return (
    <div className="wrap rd-page">
      {/* Nudged right by the nav button's 10px text padding so the title and
          subtitle share a left edge with the nav items (General, Recording…). */}
      <div className="head" style={{ marginBottom: 0, paddingLeft: "var(--sp-10)" }}>
        <div className="head-l">
          <h1>Settings</h1>
          <div className="sub">Workspace · {wsName}</div>
        </div>
      </div>
      <div className="set-layout">
        <nav className="set-nav">
          {PANELS.map((p) => (
            <button
              key={p.id}
              className={p.id === tab ? "on" : ""}
              onClick={() => navigate("/settings/" + p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <div className="set-content">
          <div
            className="set-page-h"
            style={{ display: "flex", alignItems: "center", gap: "var(--sp-16)" }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2>{P.label}</h2>
              <p>{PANEL_DESC[tab]}</p>
            </div>
            {/* Per-panel header action slot (e.g. Team's Invite member button, portaled here). */}
            <div id="set-page-action" />
          </div>
          {/* Panel-level Suspense: the Enterprise Billing panel is a lazy chunk
              (ee.BillingPanel), so its first open would otherwise bubble to the
              route boundary and flash the whole-page skeleton. Scope the
              fallback to the content area — the nav + header stay put. Eager
              panels never suspend, so this is a no-op for them. */}
          <Suspense
            fallback={
              <div style={{ display: "grid", gap: "var(--sp-12)", paddingTop: "var(--sp-8)" }}>
                <Sk w={340} h={18} r={6} />
                <Sk w={520} h={18} r={6} />
                <Sk w={280} h={18} r={6} />
              </div>
            }
          >
            <Comp openId={tab === "integrations" ? integration : undefined} />
          </Suspense>
          <SettingsVersion />
        </div>
      </div>
    </div>
  );
}

/* A quiet build-identity footer under every settings tab, so a self-hoster can
   read (and screenshot) exactly which version they're running when reporting an
   issue. Reads the API's public /version. Silent until it resolves. */
function SettingsVersion() {
  const { data } = useApi(() => Meta.version(), [], { key: "app-version" });
  if (!data?.version) return null;
  const sha =
    data.commit && data.commit !== "unknown" ? data.commit.slice(0, 7) : "";
  return (
    <div
      style={{
        marginTop: "var(--sp-24)",
        fontSize: "var(--text-xs)",
        color: "var(--t4)",
      }}
    >
      Replayfy v{data.version}
      {sha ? ` · ${sha}` : ""}
    </div>
  );
}
