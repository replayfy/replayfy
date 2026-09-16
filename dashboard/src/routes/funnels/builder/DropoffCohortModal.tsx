/* ---------- Create-cohort-from-drop-off modal --------------------------------
   Opened from the funnel builder's per-step detail row for step ≥ 2 (a drop-off
   is a transition OUT of the previous step). Previews the count of IDENTIFIED
   users who dropped out at this step (one cheap CH aggregate, GET dropoff-count),
   then materialises them as a MANUAL cohort (POST dropoff-cohort) — a point-in-
   time snapshot that the cohort precompute crons never touch. Reuses the shared
   Modal primitive; the count is always real (never fabricated), matching the
   builder's live-preview discipline.
   ---------- */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Modal } from "@/components/primitives";
import { Funnels } from "@/api/endpoints";

type Props = {
  funnelId: number;
  funnelName: string;
  /** 0-based index of the step the user dropped BEFORE reaching (≥ 1). */
  stepIndex: number;
  /** Readable label for that step (its value, e.g. "/onboarding"). */
  stepName: string;
  /** Current analysed window from the builder's date range. */
  fromTs?: number;
  toTs?: number;
  onClose: () => void;
};

export function DropoffCohortModal({
  funnelId,
  funnelName,
  stepIndex,
  stepName,
  fromTs,
  toTs,
  onClose,
}: Props) {
  const navigate = useNavigate();
  const [count, setCount] = useState<number | null>(null);
  const [countErr, setCountErr] = useState(false);
  const [name, setName] = useState(`Dropped at "${stepName}" · ${funnelName}`);
  const [busy, setBusy] = useState(false);

  // Real dropper count for this step + window. One aggregate, debounced by the
  // effect (fires once per open); cancelled on unmount.
  useEffect(() => {
    let cancelled = false;
    setCount(null);
    setCountErr(false);
    Funnels.dropoffCount<{ count: number }>(funnelId, {
      stepIndex,
      fromTs,
      toTs,
    })
      .then((r) => {
        if (!cancelled) setCount(r.data?.count ?? 0);
      })
      .catch(() => {
        if (!cancelled) setCountErr(true);
      });
    return () => {
      cancelled = true;
    };
  }, [funnelId, stepIndex, fromTs, toTs]);

  const create = async () => {
    if (busy || count === 0) return;
    setBusy(true);
    try {
      const res = await Funnels.dropoffCohort<{
        cohortId: number;
        membersAdded: number;
        capped: boolean;
      }>(funnelId, { stepIndex, name: name.trim() || undefined, fromTs, toTs });
      const { cohortId, membersAdded, capped } = res.data;
      toast.success(
        `Cohort created — ${membersAdded.toLocaleString()} user${
          membersAdded === 1 ? "" : "s"
        }${capped ? " (capped)" : ""}`,
        {
          action: {
            label: "View cohort",
            // The Users page consumes ?cohort= (view a cohort = view its members).
            onClick: () => navigate(`/users?cohort=${cohortId}`),
          },
        },
      );
      onClose();
    } catch {
      toast.error("Couldn't create the cohort");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Create cohort from drop-off"
      subtitle={
        <>
          Everyone who reached the previous step but not{" "}
          <span className="mono">{stepName}</span>.
        </>
      }
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={create}
            // Disabled while still loading (null, no error) or when nobody
            // dropped here (0). An errored count still allows creating — the copy
            // says so, and the backend recomputes the members regardless.
            disabled={busy || count === 0 || (count === null && !countErr)}
          >
            {busy ? "Creating…" : "Create cohort"}
          </button>
        </>
      }
    >
      <div className="fn-dc">
        <label className="fn-dc-l" htmlFor="fn-dc-name">
          Cohort name
        </label>
        <input
          id="fn-dc-name"
          className="fn-dc-in"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Cohort name"
          autoComplete="off"
        />
        <div className="fn-dc-count">
          {countErr ? (
            "Couldn't load the count — you can still create it."
          ) : count === null ? (
            <>
              <span className="fn-dc-spin" /> Counting droppers…
            </>
          ) : count === 0 ? (
            "No identified users dropped here — the drop-offs in this window are anonymous visitors, who can’t be added to a cohort."
          ) : (
            <>
              <b>{count.toLocaleString()}</b> identified user
              {count === 1 ? "" : "s"} dropped here.
            </>
          )}
        </div>
        <div className="fn-dc-note">
          A point-in-time snapshot of distinct identified users — it won’t update
          as new users drop off, and excludes anonymous visitors (so it can differ
          from the session-level drop-off shown above).
        </div>
      </div>
    </Modal>
  );
}
