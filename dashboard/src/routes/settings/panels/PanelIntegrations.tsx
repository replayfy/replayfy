import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon, ConfirmDialog } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Settings, Integrations } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import type { ApiIntegration } from "../settings.data";
import {
  INTEGRATIONS,
  INTEGRATION_CATEGORIES,
  type IntegrationDef,
} from "../integrations.data";
import { IntegrationConfigModal } from "./IntegrationConfigModal";

/* ============================================================================
   Panel: Integrations — a catalog of connectable services with a per-service
   detail view. Live connection state comes from GET /v1/settings/integrations
   (matched by id); the three OAuth-backed services (Slack, Linear, GitHub)
   Connect via a signed authorize URL and Disconnect by dropping the token.
   The rest render a complete detail with a waitlist affordance rather than a
   fabricated connection.
   ========================================================================== */

/** Live connection state, matched to a catalog id by the API's integration id.
 *  Reads the endpoint directly (no coupling to the legacy tuple catalog); an
 *  id the backend doesn't report is simply not connected. */

function useConnectedMap() {
  const { data, refetch } = useApi<{ integrations: ApiIntegration[] }>(() =>
    Settings.integrations<{ integrations: ApiIntegration[] }>(),
  );
  const map = new Map<string, boolean>(
    (data?.integrations ?? []).map((i) => [i.id.toLowerCase(), i.connected]),
  );
  return { isConnected: (id: string) => map.get(id) ?? false, refetch };
}

/* ---- catalog card ---- */
function IntgCard({
  intg,
  connected,
  onOpen,
}: {
  intg: IntegrationDef;
  connected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      className="intg-card"
      onClick={onOpen}
      aria-label={`${intg.name}${connected ? ", connected" : ""} — ${intg.tagline}`}
    >
      <span className="intg-logo">{intg.logo}</span>
      <span className="intg-card-b">
        <span className="intg-card-t">
          {intg.name}
          {connected && <span className="intg-dot" title="Connected" />}
        </span>
        <span className="intg-card-d">{intg.tagline}</span>
      </span>
      <Icon name="arrowR" size={13} className="intg-card-go" />
    </button>
  );
}

/* ---- featured hero (the most-used integration) ---- */
function IntgHero({
  intg,
  connected,
  onOpen,
}: {
  intg: IntegrationDef;
  connected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      className="intg-hero"
      onClick={onOpen}
      style={{ ["--brand" as string]: intg.color }}
    >
      <span className="intg-hero-l">
        <span className="intg-hero-top">
          <span className="intg-logo lg">{intg.logo}</span>
          <span className="tag info" style={{ fontSize: "var(--text-2xs)" }}>
            Most used
          </span>
        </span>
        <span className="intg-hero-t">{intg.name}</span>
        <span className="intg-hero-d">{intg.tagline}</span>
        <span
          className={"btn sm intg-hero-cta" + (connected ? " q" : " primary")}
        >
          {connected ? (
            <>
              Manage <Icon name="arrowR" size={12} />
            </>
          ) : (
            <>
              <Icon name="plug" size={13} /> Connect
            </>
          )}
        </span>
      </span>
      <span className="intg-hero-art" aria-hidden="true">
        <span className="intg-msg">
          <span className="intg-msg-h">
            <span className="intg-logo sm">{intg.logo}</span> Replayfy{" "}
            <span className="intg-msg-time">now</span>
          </span>
          <span className="intg-msg-b">
            <b>Crash spike</b> on <span className="mono">CartView</span> — 98
            sessions in the last hour.
          </span>
          <span className="intg-msg-link">
            <Icon name="play" size={11} fill /> Watch the session →
          </span>
        </span>
      </span>
    </button>
  );
}

/* ---- detail view ---- */
function IntgDetail({
  intg,
  connected,
  busy,
  onBack,
  onConnect,
  onDisconnect,
}: {
  intg: IntegrationDef;
  connected: boolean;
  busy: boolean;
  onBack: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="intg-detail">
      <button className="intg-back" onClick={onBack}>
        <Icon name="chev" size={12} style={{ transform: "rotate(90deg)" }} />{" "}
        Integrations
      </button>

      <div className="intg-detail-h">
        <span className="intg-logo xl">{intg.logo}</span>
        <div className="intg-detail-hb">
          <div className="intg-detail-t">
            {intg.name} {connected && <span className="tag ok">Connected</span>}
          </div>
          <div className="intg-detail-cat">{intg.category}</div>
        </div>
        <div className="intg-detail-act">
          {intg.wireable ? (
            connected ? (
              <button className="btn" disabled={busy} onClick={onDisconnect}>
                {busy ? "…" : "Disconnect"}
              </button>
            ) : (
              <button
                className="btn primary"
                disabled={busy}
                onClick={onConnect}
              >
                {busy ? (
                  "Connecting…"
                ) : (
                  <>
                    <Icon name="plug" size={13} /> Connect {intg.name}
                  </>
                )}
              </button>
            )
          ) : connected ? (
            <button className="btn" disabled title="Managed outside Replayfy">
              Linked
            </button>
          ) : (
            <button className="btn primary" onClick={onConnect}>
              <Icon name="plug" size={13} /> Join the waitlist
            </button>
          )}
        </div>
      </div>

      <p className="intg-blurb">{intg.blurb}</p>

      <div className="intg-sec-l">What you can do</div>
      <div className="intg-can">
        {intg.can.map((c) => (
          <div className="intg-can-row" key={c.text}>
            <span className="intg-can-ic">
              <Icon name={c.icon} size={14} />
            </span>
            <span>{c.text}</span>
          </div>
        ))}
      </div>

      <div className="intg-sec-l">Permissions</div>
      <div className="intg-scopes">
        {intg.scopes.map((s) => (
          <div className="intg-scope" key={s}>
            <Icon name="check" size={13} /> {s}
          </div>
        ))}
      </div>

      <div className="intg-note">
        <Icon name="lock" size={13} />
        <span>
          Replayfy only accesses what's listed above. You can disconnect at any
          time and we drop the stored token immediately.
        </span>
      </div>
    </div>
  );
}

/* Credential-free providers connect via a form (paste a key/URL) → POST
   /v1/integrations/:p/configure, instead of an OAuth redirect. */
type CfgField = {
  key: string;
  label: string;
  placeholder: string;
  optional?: boolean;
};
const CONFIG_PROVIDERS: Record<string, { fields: CfgField[]; note: string }> = {
  pagerduty: {
    fields: [
      {
        key: "integrationKey",
        label: "Events API v2 integration key",
        placeholder: "e.g. R0ABCD1234EFGH5678IJKL",
      },
    ],
    note: "In PagerDuty: Service → Integrations → add an Events API v2 integration, then copy its Integration Key.",
  },
  webhook: {
    fields: [
      {
        key: "url",
        label: "Webhook URL",
        placeholder: "https://example.com/hooks/replayfy",
      },
    ],
    note: "Each event is POSTed as JSON and signed with the secret below. Verify the X-Replayfy-Signature (sha256 HMAC) header on your endpoint to confirm it came from us.",
  },
};

export function PanelIntegrations({ openId: openParam }: { openId?: string }) {
  const { isConnected, refetch } = useConnectedMap();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // The open integration is driven by the URL (/settings/integrations/:integration).
  const openId = openParam ?? null;
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Config-form connect (PagerDuty key / Webhook URL) — non-OAuth. The modal
  // (IntegrationConfigModal) owns its own field + signing-secret state.
  const [configTarget, setConfigTarget] = useState<IntegrationDef | null>(null);

  // After an OAuth round-trip the backend redirects to
  // /settings/integrations?<provider>=connected|error — surface a toast, refresh
  // the connection state, and strip the param so a reload doesn't re-fire it.
  useEffect(() => {
    // Every OAuth-redirect provider (wired, but not a config-form one like
    // PagerDuty/Webhook) comes back on ?<id>=connected|error — handle them all.
    const oauthProviders = INTEGRATIONS.filter(
      (i) => i.wireable && !CONFIG_PROVIDERS[i.id],
    ).map((i) => i.id);
    for (const p of oauthProviders) {
      const status = searchParams.get(p);
      if (!status) continue;
      const name = INTEGRATIONS.find((i) => i.id === p)?.name ?? p;
      if (status === "connected") {
        toast && toast(`${name} connected`, { kind: "ok" });
        refetch();
        // Resume a "Create issue" that a recording started but had to connect
        // first (see CreateIssueModal → PENDING_ISSUE_KEY): file it now + toast.
        try {
          const raw = sessionStorage.getItem("replayfy:pending-issue");
          if (raw) {
            const intent = JSON.parse(raw) as {
              provider?: string;
              sessionPublicId?: string;
            };
            if (intent.provider === p && intent.sessionPublicId) {
              sessionStorage.removeItem("replayfy:pending-issue");
              Integrations.createSessionIssue(p, {
                sessionPublicId: intent.sessionPublicId,
              })
                .then(({ data: res }) => {
                  if (res?.url) window.open(res.url, "_blank", "noopener");
                  toast &&
                    toast(
                      res?.ref && !res?.url
                        ? `Sent to ${name} · ${res.ref}`
                        : `Issue created on ${name}`,
                      { kind: "ok" },
                    );
                })
                .catch(
                  () =>
                    toast &&
                    toast(
                      `Connected ${name}, but couldn't file the issue automatically.`,
                      { kind: "err" },
                    ),
                );
            }
          }
        } catch {
          /* ignore a malformed pending-issue intent */
        }
      } else {
        toast &&
          toast(`Couldn't connect ${name}. Please try again.`, { kind: "err" });
      }
      const next = new URLSearchParams(searchParams);
      next.delete(p);
      setSearchParams(next, { replace: true });
      break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const connect = async (intg: IntegrationDef) => {
    // Credential-free providers open a config form instead of an OAuth redirect.
    if (CONFIG_PROVIDERS[intg.id]) {
      setConfigTarget(intg);
      return;
    }
    if (!intg.wireable) {
      toast &&
        toast(
          `You're on the waitlist for ${intg.name} — we'll email you when it's ready.`,
          { kind: "ok" },
        );
      return;
    }
    setBusy(intg.id);
    try {
      const { data } = await Integrations.connect(intg.id);
      window.location.assign(data.authorizeUrl); // OAuth — leaves the app
    } catch (e) {
      toast &&
        toast(
          "Couldn't start the connection: " +
            (e instanceof Error ? e.message : "error"),
          { kind: "err" },
        );
      setBusy(null);
    }
  };
  // Disconnect goes through the app's ConfirmDialog, not window.confirm(): the
  // button opens the dialog (setDiscTarget); the dialog's confirm runs the API.
  const [discTarget, setDiscTarget] = useState<IntegrationDef | null>(null);
  const disconnect = (intg: IntegrationDef) => setDiscTarget(intg);
  const doDisconnect = async () => {
    const intg = discTarget;
    if (!intg) return;
    setBusy(intg.id);
    try {
      await Integrations.disconnect(intg.id);
      refetch();
      toast && toast(`${intg.name} disconnected`);
    } catch (e) {
      toast &&
        toast(
          "Couldn't disconnect: " + (e instanceof Error ? e.message : "error"),
          { kind: "err" },
        );
    } finally {
      setBusy(null);
      setDiscTarget(null);
    }
  };
  const discDialog = discTarget ? (
    <ConfirmDialog
      title={`Disconnect ${discTarget.name}?`}
      icon="link"
      confirmLabel="Disconnect"
      busy={busy === discTarget.id}
      onConfirm={doDisconnect}
      onClose={() => setDiscTarget(null)}
    >
      <p
        style={{
          fontSize: "var(--text-base)",
          color: "var(--t2)",
          lineHeight: "var(--lh-body)",
          margin: "0 0 var(--sp-18)",
        }}
      >
        The workspace will stop being able to file or post to{" "}
        <b style={{ color: "var(--text)", fontWeight: "var(--fw-semibold)" }}>
          {discTarget.name}
        </b>
        . You can reconnect it at any time.
      </p>
    </ConfirmDialog>
  ) : null;

  const open = openId
    ? (INTEGRATIONS.find((i) => i.id === openId) ?? null)
    : null;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return INTEGRATIONS;
    return INTEGRATIONS.filter(
      (i) =>
        i.name.toLowerCase().includes(needle) ||
        i.tagline.toLowerCase().includes(needle) ||
        i.category.toLowerCase().includes(needle),
    );
  }, [q]);

  const configSpec = configTarget ? CONFIG_PROVIDERS[configTarget.id] : null;
  const configModal =
    configTarget && configSpec ? (
      <IntegrationConfigModal
        target={configTarget}
        spec={configSpec}
        onClose={() => setConfigTarget(null)}
        onConnected={refetch}
      />
    ) : null;

  if (open) {
    return (
      <div className="intg">
        <IntgDetail
          intg={open}
          connected={isConnected(open.id)}
          busy={busy === open.id}
          onBack={() => navigate("/settings/integrations")}
          onConnect={() => connect(open)}
          onDisconnect={() => disconnect(open)}
        />
        {configModal}
        {discDialog}
      </div>
    );
  }

  const featured = INTEGRATIONS.find((i) => i.featured)!;
  const showHero = !q && filtered.includes(featured);
  const grid = showHero
    ? filtered.filter((i) => i.id !== featured.id)
    : filtered;

  return (
    <div className="intg">
      <div className="intg-search">
        <Icon name="search" size={14} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search integrations…"
          aria-label="Search integrations"
        />
        {q && (
          <button
            className="intg-search-x"
            onClick={() => setQ("")}
            aria-label="Clear"
          >
            <Icon name="x" size={13} />
          </button>
        )}
      </div>

      {showHero && (
        <IntgHero
          intg={featured}
          connected={isConnected(featured.id)}
          onOpen={() => navigate("/settings/integrations/" + featured.id)}
        />
      )}

      {INTEGRATION_CATEGORIES.map((cat) => {
        const inCat = grid.filter((i) => i.category === cat);
        if (!inCat.length) return null;
        return (
          <section className="intg-group" key={cat}>
            <div className="intg-group-h">{cat}</div>
            <div className="intg-grid">
              {inCat.map((i) => (
                <IntgCard
                  key={i.id}
                  intg={i}
                  connected={isConnected(i.id)}
                  onOpen={() => navigate("/settings/integrations/" + i.id)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {!filtered.length && (
        <div className="intg-empty">
          <Icon name="search" size={15} /> No integrations match “{q}”.
        </div>
      )}
      {configModal}
    </div>
  );
}
