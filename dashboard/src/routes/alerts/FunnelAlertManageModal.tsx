/* ---------- Manage a funnel-conversion alert -------------------------------
   Funnel-conversion alerts are EMAIL-ONLY, so "managing" one isn't about
   changing a channel (the ChannelModal's job for metric/issue alerts) — it's
   editing WHO gets emailed and the CONDITION that fires it. PATCHes
   /v1/alerts/:id with { comparator, threshold, windowDays, recipients }; the
   server re-validates + caps the recipient list. Reuses the funnel builder's
   .fn-al-* styles so the control reads identically to where the alert is born.
   ---------- */
import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";
import { toast } from "sonner";
import { Icon, Modal } from "@/components/primitives";
import { Alerts as AlertsApi } from "@/api/endpoints";
import type { Alert } from "./alerts.data";

type Props = {
  alert: Alert;
  onClose: () => void;
  onSaved: () => void;
};

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim().toLowerCase());

export function FunnelAlertManageModal({ alert, onClose, onSaved }: Props) {
  // Seed from the saved alert. Our builder only ever creates DROP_PCT / BELOW,
  // so map anything else onto the nearer of the two rather than inventing a tab.
  const [mode, setMode] = useState<"drop" | "below">(
    alert.comparator === "DROP_PCT" ? "drop" : "below",
  );
  const [threshold, setThreshold] = useState(
    alert.threshold != null ? String(alert.threshold) : "20",
  );
  const [windowDays, setWindowDays] = useState(String(alert.windowDays ?? 7));
  const [emails, setEmails] = useState<string[]>(alert.recipients);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const addDraft = (): void => {
    const e = draft.trim().toLowerCase();
    if (isEmail(e) && !emails.includes(e)) {
      setEmails([...emails, e]);
      setDraft("");
    }
  };
  const onDraftKey = (ev: ReactKeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter" || ev.key === ",") {
      ev.preventDefault();
      addDraft();
    } else if (ev.key === "Backspace" && !draft && emails.length) {
      setEmails(emails.slice(0, -1));
    }
  };

  const t = Number(threshold);
  const w = Number(windowDays);
  const draftEmail = draft.trim().toLowerCase();
  const recipients =
    isEmail(draftEmail) && !emails.includes(draftEmail)
      ? [...emails, draftEmail]
      : emails;
  const valid =
    Number.isFinite(t) &&
    t >= 0 &&
    (mode !== "below" || t <= 100) &&
    Number.isFinite(w) &&
    w >= 1 &&
    w <= 90;

  const save = async () => {
    if (busy || !valid) return;
    setBusy(true);
    try {
      await AlertsApi.update(String(alert.id), {
        comparator: mode === "drop" ? "DROP_PCT" : "BELOW",
        threshold: t,
        windowDays: Math.floor(w),
        recipients,
      });
      toast.success("Alert updated");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(
        "Couldn’t update the alert: " +
          (e instanceof Error ? e.message : "error"),
      );
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Manage alert"
      subtitle={
        alert.funnel ? (
          <>
            Watching <span className="mono">{alert.funnel.name}</span> conversion
            — emailed, no in-app notification.
          </>
        ) : (
          "This funnel-conversion alert is emailed — no in-app notification."
        )
      }
      onClose={onClose}
      width={470}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={save}
            disabled={busy || !valid}
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      <div className="fn-al">
        <div className="fn-al-seg" role="tablist" aria-label="Alert condition">
          <button
            role="tab"
            aria-selected={mode === "drop"}
            className={`fn-al-tab ${mode === "drop" ? "on" : ""}`}
            onClick={() => setMode("drop")}
          >
            Drops by
          </button>
          <button
            role="tab"
            aria-selected={mode === "below"}
            className={`fn-al-tab ${mode === "below" ? "on" : ""}`}
            onClick={() => setMode("below")}
          >
            Falls below
          </button>
        </div>

        <div className="fn-al-row">
          <span className="fn-al-lead">
            {mode === "drop"
              ? "Alert when conversion drops by more than"
              : "Alert when conversion falls below"}
          </span>
          <span className="fn-al-inwrap">
            <input
              className="fn-al-in"
              type="number"
              min="0"
              inputMode="decimal"
              value={threshold}
              aria-label="Threshold percent"
              onChange={(e) => setThreshold(e.target.value)}
            />
            <span className="fn-al-pct">%</span>
          </span>
          <span className="fn-al-lead">
            {mode === "drop" ? "vs the previous" : "over the last"}
          </span>
          <span className="fn-al-inwrap">
            <input
              className="fn-al-in"
              type="number"
              min="1"
              max="90"
              inputMode="numeric"
              value={windowDays}
              aria-label="Window in days"
              onChange={(e) => setWindowDays(e.target.value)}
            />
            <span className="fn-al-pct">d</span>
          </span>
        </div>

        <div className="fn-al-recip">
          <label className="fn-al-l">Email these people</label>
          <div className="fn-al-chips">
            {emails.map((e) => (
              <span className="fn-al-chip" key={e}>
                {e}
                <button
                  type="button"
                  aria-label={`Remove ${e}`}
                  onClick={() => setEmails(emails.filter((x) => x !== e))}
                >
                  <Icon name="x" size={10} />
                </button>
              </span>
            ))}
            <input
              className="fn-al-recip-in"
              value={draft}
              placeholder={emails.length ? "Add another…" : "name@company.com"}
              aria-label="Add email"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onDraftKey}
              onBlur={addDraft}
            />
          </div>
        </div>

        <div className="fn-dc-note">
          Leave the list empty to email the alert’s creator. Checked once daily
          off the conversion history.
        </div>
      </div>
    </Modal>
  );
}
