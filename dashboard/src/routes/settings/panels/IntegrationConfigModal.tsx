import { useEffect, useState } from "react";
import { Icon, Modal } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Integrations } from "@/api/endpoints";
import type { IntegrationDef } from "../integrations.data";

type CfgField = {
  key: string;
  label: string;
  placeholder: string;
  optional?: boolean;
};
type CfgSpec = { fields: CfgField[]; note: string };

/* ============================================================================
   IntegrationConfigModal — the "connect via a form" modal for credential-free
   providers (PagerDuty = an Events-API integration key; Webhook = a destination
   URL). Full-width inputs, matching the design system's `.text-input` usage.

   Webhook signing is NOT a user choice: the backend mints the signing secret on
   configure and returns it once. This modal reveals it (with copy) and, on
   reopening a connected webhook, re-fetches it via GET webhook/config so the
   secret is never stranded. PagerDuty has no secret and closes on success.
   ========================================================================== */
export function IntegrationConfigModal({
  target,
  spec,
  onClose,
  onConnected,
}: {
  target: IntegrationDef;
  spec: CfgSpec;
  onClose: () => void;
  onConnected: () => void;
}) {
  const toast = useToast();
  const isWebhook = target.id === "webhook";
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // The auto-generated signing secret (revealed on connect, or re-fetched when
  // reopening an already-connected webhook). null until we have one.
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(isWebhook);

  // Reopening a connected webhook → prefill the URL and reveal the stored secret.
  useEffect(() => {
    if (!isWebhook) return;
    let alive = true;
    Integrations.webhookConfig()
      .then(({ data }) => {
        if (!alive || !data?.connected) return;
        if (data.url) setVals((v) => ({ ...v, url: data.url! }));
        if (data.signingSecret) setSecret(data.signingSecret);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoadingExisting(false);
      });
    return () => {
      alive = false;
    };
  }, [isWebhook]);

  const required = spec.fields.filter((f) => !f.optional);
  const canSave = required.every((f) => (vals[f.key] ?? "").trim());

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      for (const f of spec.fields) {
        const v = (vals[f.key] ?? "").trim();
        if (v) body[f.key] = v;
      }
      const { data } = await Integrations.configure(target.id, body);
      onConnected();
      if (isWebhook) {
        // Keep the modal open so the user can copy the freshly-minted secret.
        if (data?.signingSecret) setSecret(data.signingSecret);
        toast && toast(`${target.name} ${secret ? "updated" : "connected"}`, {
          kind: "ok",
        });
      } else {
        toast && toast(`${target.name} connected`, { kind: "ok" });
        onClose();
      }
    } catch (e) {
      toast &&
        toast("Couldn't connect: " + (e instanceof Error ? e.message : "error"), {
          kind: "err",
        });
    } finally {
      setSaving(false);
    }
  };

  const copySecret = () => {
    if (!secret) return;
    navigator.clipboard?.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const connected = isWebhook && !!secret;

  return (
    <Modal
      title={`Connect ${target.name}`}
      subtitle={target.tagline}
      width={460}
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            {connected ? "Done" : "Cancel"}
          </button>
          <button
            className="btn primary"
            onClick={save}
            disabled={saving || !canSave}
          >
            {saving ? "Saving…" : connected ? "Save changes" : "Connect"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-14)" }}>
        {spec.fields.map((f) => (
          <div key={f.key} className="field-row" style={{ marginBottom: 0 }}>
            <label>
              {f.label}
              {f.optional && <span className="co-opt"> optional</span>}
            </label>
            <input
              className="text-input"
              style={{ width: "100%" }}
              value={vals[f.key] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) =>
                setVals((v) => ({ ...v, [f.key]: e.target.value }))
              }
            />
          </div>
        ))}

        {isWebhook && (
          <div className="field-row" style={{ marginBottom: 0 }}>
            <label>
              Signing secret
              <span className="co-opt"> auto-generated</span>
            </label>
            {secret ? (
              <div style={{ display: "flex", gap: "var(--sp-8)" }}>
                <input
                  className="text-input"
                  style={{
                    width: "100%",
                    fontFamily: "var(--mono)",
                    fontSize: "var(--text-sm)",
                  }}
                  readOnly
                  value={secret}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  className="btn"
                  onClick={copySecret}
                  style={{ flexShrink: 0 }}
                  title="Copy signing secret"
                >
                  <Icon name={copied ? "check" : "copy"} size={13} />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            ) : (
              <div
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--t3)",
                  padding: "var(--sp-10) var(--sp-12)",
                  border: "1px dashed var(--line-strong)",
                  borderRadius: "var(--r-md)",
                  background: "var(--bg)",
                }}
              >
                {loadingExisting
                  ? "Loading…"
                  : "We generate a signing secret automatically when you connect — you'll be able to copy it here."}
              </div>
            )}
          </div>
        )}

        <p
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--t3)",
            lineHeight: "var(--lh-normal)",
            margin: 0,
          }}
        >
          {spec.note}
        </p>
      </div>
    </Modal>
  );
}
