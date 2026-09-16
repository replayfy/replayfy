/* ---------- "Alert on this funnel" modal -------------------------------------
   Opened from the funnel builder header for a SAVED funnel. Creates a
   FUNNEL_CONVERSION alert on the funnel's OVERALL conversion (POST
   /v1/alerts/from-funnel): "Drops by" = DROP_PCT (relative drop vs the prior
   equal-length window), "Falls below" = BELOW a fixed conversion %. These alerts
   are EMAIL-ONLY — evaluated daily off the conversion rollup and emailed to the
   recipients below (defaults to your account email; add anyone else). Reuses the
   shared Modal primitive.
   ---------- */
import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Icon, Modal } from "@/components/primitives";
import { Alerts } from "@/api/endpoints";
import { useAuth } from "@/lib/auth";

type Props = {
  funnelId: number;
  funnelName: string;
  /** The funnel's own window (days) — the comparison window, shown for context. */
  windowDays: number;
  onClose: () => void;
};

const DEFAULTS: Record<"drop" | "below", string> = { drop: "20", below: "40" };
const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim().toLowerCase());

export function FunnelAlertModal({
  funnelId,
  funnelName,
  windowDays,
  onClose,
}: Props) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [mode, setMode] = useState<"drop" | "below">("drop");
  const [threshold, setThreshold] = useState(DEFAULTS.drop);
  const [touched, setTouched] = useState(false);
  const [emails, setEmails] = useState<string[]>(
    user?.email ? [user.email.toLowerCase()] : [],
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const switchMode = (m: "drop" | "below") => {
    setMode(m);
    if (!touched) setThreshold(DEFAULTS[m]);
  };

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
  // Include a valid, un-committed draft so the user needn't press Enter first.
  const draftEmail = draft.trim().toLowerCase();
  const recipients =
    isEmail(draftEmail) && !emails.includes(draftEmail)
      ? [...emails, draftEmail]
      : emails;
  const valid =
    Number.isFinite(t) &&
    t >= 0 &&
    (mode !== "below" || t <= 100) &&
    recipients.length >= 1;

  const create = async () => {
    if (busy || !valid) return;
    setBusy(true);
    try {
      await Alerts.fromFunnel({
        funnelId,
        comparator: mode === "drop" ? "DROP_PCT" : "BELOW",
        threshold: t,
        recipients,
      });
      toast.success("Alert created", {
        description: `We’ll email you daily if “${funnelName}” conversion ${
          mode === "drop" ? "drops" : "falls below your threshold"
        }.`,
        action: { label: "View alerts", onClick: () => navigate("/alerts") },
      });
      onClose();
    } catch {
      toast.error("Couldn’t create the alert");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Alert on this funnel"
      subtitle={
        <>
          Get an email when <span className="mono">{funnelName}</span> conversion
          changes.
        </>
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
            onClick={create}
            disabled={busy || !valid}
          >
            {busy ? "Creating…" : "Create alert"}
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
            onClick={() => switchMode("drop")}
          >
            Drops by
          </button>
          <button
            role="tab"
            aria-selected={mode === "below"}
            className={`fn-al-tab ${mode === "below" ? "on" : ""}`}
            onClick={() => switchMode("below")}
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
              onChange={(e) => {
                setTouched(true);
                setThreshold(e.target.value);
              }}
            />
            <span className="fn-al-pct">%</span>
          </span>
          <span className="fn-al-lead">
            {mode === "drop"
              ? `vs the previous ${windowDays}d.`
              : `over the last ${windowDays}d.`}
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
          Checked once daily off the conversion history. Sent by email — no
          in-app notification.
        </div>
      </div>
    </Modal>
  );
}
