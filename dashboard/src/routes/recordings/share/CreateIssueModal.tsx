/* ---------- Create-issue integration picker ----------------------------------
   Opened from the recording stagebar's "Create issue" button. Lists the issue-
   capable integrations (the OAuth-backed ones: Linear / GitHub / Slack) using
   the same card design as the Settings → Integrations screen. Behaviour per card:
     • connected      → POST /v1/integrations/:provider/session-issue, then the
                        modal transforms into a success state showing the created
                        issue URL to copy (or the Slack message ref) — it does NOT
                        navigate away.
     • not connected  → stash the intent (provider + session) in sessionStorage
                        and kick off the OAuth connect; when the partner redirects
                        back, PanelIntegrations resumes and files the issue, then
                        fires the "issue created" toast.
   A workspace with several trackers connected simply picks from the list here.
   ---------- */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Icon, Modal } from "@/components/primitives";
import { Settings, Integrations } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { INTEGRATIONS } from "@/routes/settings/integrations.data";

type ApiIntegration = { id: string; label?: string; connected: boolean };

/** Persisted across the OAuth redirect so the issue can be filed on return. */
export const PENDING_ISSUE_KEY = "replayfy:pending-issue";

// Only issue/message targets belong in the "Create issue" picker — the
// alert-only wired providers (PagerDuty, Webhook, Sentry) are excluded.
const ISSUE_PROVIDERS = INTEGRATIONS.filter((i) => i.canFileIssue);

type IssueResult = { name: string; url?: string; ref?: string };

type Props = {
  open: boolean;
  sessionPublicId?: string;
  onClose: () => void;
};

export function CreateIssueModal({ open, sessionPublicId, onClose }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<IssueResult | null>(null);
  const [copied, setCopied] = useState(false);
  const { data } = useApi<{ integrations: ApiIntegration[] }>(
    () => Settings.integrations<{ integrations: ApiIntegration[] }>(),
    [],
    { enabled: open },
  );
  const connected = new Set(
    (data?.integrations ?? [])
      .filter((i) => i.connected)
      .map((i) => i.id.toLowerCase()),
  );

  // The picker stays mounted (RvStage renders it), so reset transient state each
  // time it closes — otherwise a reopen would flash the last success screen.
  useEffect(() => {
    if (!open) {
      setResult(null);
      setBusy(null);
      setCopied(false);
    }
  }, [open]);

  if (!open) return null;

  const fileOn = async (id: string, name: string) => {
    if (!sessionPublicId || busy) return;
    // Not connected → remember what we were doing, then start OAuth. On return,
    // PanelIntegrations reads PENDING_ISSUE_KEY and files the issue + toasts.
    if (!connected.has(id)) {
      setBusy(id);
      try {
        sessionStorage.setItem(
          PENDING_ISSUE_KEY,
          JSON.stringify({ provider: id, sessionPublicId }),
        );
        const { data: c } = await Integrations.connect(id);
        window.location.assign(c.authorizeUrl); // OAuth — leaves the app
      } catch (e) {
        sessionStorage.removeItem(PENDING_ISSUE_KEY);
        toast.error(
          `Couldn't connect ${name}: ` +
            (e instanceof Error ? e.message : "error"),
        );
        setBusy(null);
      }
      return;
    }
    // Connected → file, then transform the modal into the success state.
    setBusy(id);
    try {
      const { data: res } = await Integrations.createSessionIssue(id, {
        sessionPublicId,
      });
      setResult({ name, url: res?.url, ref: res?.ref });
    } catch (e) {
      toast.error(
        `Couldn't create the issue: ` +
          (e instanceof Error ? e.message : "error"),
      );
    } finally {
      setBusy(null);
    }
  };

  const copyUrl = () => {
    if (!result?.url) return;
    try {
      navigator.clipboard?.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn't copy");
    }
  };

  // ── Success state — show the created issue URL to copy (no navigation). ──
  if (result) {
    return (
      <Modal
        title="Issue created"
        subtitle={`Filed on ${result.name} — ${result.url ? "copy the link to open the issue." : "it's been posted to your workspace."}`}
        width={520}
        onClose={onClose}
        headerIcon="check"
        headerTone="ok"
      >
        {result.url ? (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-8)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-md)",
                padding: "var(--sp-8) var(--sp-8) var(--sp-8) var(--sp-12)",
                background: "var(--bg)",
              }}
            >
              <span
                className="mono"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: "var(--text-sm)",
                  color: "var(--t2)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {result.url}
              </span>
              <button
                className={"btn sm" + (copied ? "" : " primary")}
                onClick={copyUrl}
                style={{ flexShrink: 0 }}
              >
                <Icon name={copied ? "check" : "copy"} size={12} />{" "}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </>
        ) : (
          result.ref && (
            <div
              className="mono"
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--t2)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-md)",
                padding: "var(--sp-10) var(--sp-12)",
                background: "var(--bg)",
              }}
            >
              {result.ref}
            </div>
          )
        )}
      </Modal>
    );
  }

  // ── Picker state — choose which tracker to file on. ──
  return (
    <Modal
      title="Create an issue"
      subtitle="Choose where to file this recording."
      width={520}
      onClose={onClose}
      headerIcon="issue"
    >
      <div className="pick-list">
        {ISSUE_PROVIDERS.map((intg) => {
          const isOn = connected.has(intg.id);
          const isBusy = busy === intg.id;
          return (
            <button
              key={intg.id}
              className="intg-card"
              disabled={!!busy || !sessionPublicId}
              onClick={() => fileOn(intg.id, intg.name)}
              aria-label={`Create an issue on ${intg.name}`}
            >
              <span className="intg-logo">{intg.logo}</span>
              <span className="intg-card-b">
                <span className="intg-card-t">
                  {intg.name}
                  {isOn && <span className="intg-dot" title="Connected" />}
                </span>
                <span className="intg-card-d">
                  {isBusy
                    ? isOn
                      ? "Creating issue…"
                      : `Connecting ${intg.name}…`
                    : isOn
                      ? `Create an issue in ${intg.name}`
                      : `Connect ${intg.name} to file issues`}
                </span>
              </span>
              <Icon name="chevR" size={14} className="intg-card-go" />
            </button>
          );
        })}
      </div>
      <p
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--t3)",
          lineHeight: "var(--lh-normal)",
          margin: "var(--sp-14) var(--sp-2) 0",
        }}
      >
        Not connected yet? Picking one starts a secure connect — you'll come
        straight back and the issue is filed automatically. Manage integrations
        in Settings.
      </p>
    </Modal>
  );
}
