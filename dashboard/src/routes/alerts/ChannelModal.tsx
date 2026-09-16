/* ---------- Channel editor -------------------------------------------------
   The alerts list's only edit surface: where a fired alert routes. Destinations
   are routing INTENT — the picker sends provider names, never a URL or key, and
   the secret is resolved from WorkspaceIntegration at dispatch.

   A provider the workspace hasn't connected is shown but NOT selectable: the
   backend rejects it with a 400 (assertDestinationsConnected), and a channel
   that silently never pages is the worst failure an alert can have. Connected-
   ness comes from Settings.integrations — the same source the Create-issue
   picker gates on.
   ---------- */
import { useState } from "react";
import { toast } from "sonner";
import { Checkbox, Icon, Modal } from "@/components/primitives";
import { Alerts as AlertsApi, Settings } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { INTEGRATIONS } from "@/routes/settings/integrations.data";
import { DEST_PROVIDERS, type Alert, type DestProvider } from "./alerts.data";

type ApiIntegration = { id: string; label?: string; connected: boolean };

type Props = {
  alert: Alert;
  onClose: () => void;
  onSaved: () => void;
};

export function ChannelModal({ alert, onClose, onSaved }: Props) {
  const [picked, setPicked] = useState<DestProvider[]>(alert.dests);
  const [busy, setBusy] = useState(false);
  const { data } = useApi<{ integrations: ApiIntegration[] }>(() =>
    Settings.integrations<{ integrations: ApiIntegration[] }>(),
  );
  const connected = new Set(
    (data?.integrations ?? [])
      .filter((i) => i.connected)
      .map((i) => i.id.toUpperCase()),
  );

  const toggle = (p: DestProvider) =>
    setPicked((xs) => (xs.includes(p) ? xs.filter((x) => x !== p) : [...xs, p]));

  const save = async () => {
    setBusy(true);
    try {
      // [] is meaningful, not empty: it clears external routing back to the
      // in-app bell (+ email if opted in). The backend maps it to DbNull.
      await AlertsApi.update(String(alert.id), {
        destinations: picked.map((provider) => ({ provider })),
      });
      toast.success("Channels updated");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(
        "Couldn't update channels: " +
          (e instanceof Error ? e.message : "error"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Where this alert goes"
      subtitle={alert.issue ? alert.issue.title : alert.name}
      width={460}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save channels"}
          </button>
        </>
      }
    >
      <div className="al-ch-list">
        {DEST_PROVIDERS.map((p) => {
          const def = INTEGRATIONS.find((i) => i.id === p.toLowerCase());
          const isOn = connected.has(p);
          return (
            <label
              key={p}
              className={`al-ch${isOn ? "" : " off"}`}
              aria-disabled={!isOn}
            >
              <span className="al-ch-logo">{def?.logo}</span>
              <span className="al-ch-txt">
                <span className="al-ch-t">{def?.name ?? p}</span>
                <span className="al-ch-s">
                  {isOn ? def?.tagline : "Not connected — set it up in Settings"}
                </span>
              </span>
              {isOn ? (
                <Checkbox on={picked.includes(p)} onChange={() => toggle(p)} />
              ) : (
                <span className="tag">Off</span>
              )}
            </label>
          );
        })}
      </div>

      {/* The bell is not a choice, and email has no PATCH field — stating both
          keeps the picker from implying it controls more than it does. */}
      <div className="al-ch-note">
        <Icon name="bell" size={13} />
        <span>
          The in-app bell always receives this alert.
          {alert.emailEnabled
            ? ` Email goes to ${alert.emailTo || "the alert creator"}.`
            : " Email is off."}
        </span>
      </div>
    </Modal>
  );
}
