/* ---------- Add-to-cohort picker ---------------------------------------------
   Opened from the user detail sidebar's "Add to cohort" button. Lists the
   workspace's cohorts; a row the user is NOT in adds them
   (POST /v1/cohorts/:id/members, which takes an array of end-user ids), and a
   row they're ALREADY in removes them
   (DELETE /v1/cohorts/:id/members/:userId). Membership comes from the page's
   detail fetch (`cohortIds`) — re-adding an existing member was a silent no-op
   before, because every row was an add.

   Only MANUAL cohorts are offered: an AUTO cohort's membership is recomputed
   from its filter, so a hand-added member is dropped on the next refresh —
   the row would look like it worked and then silently undo itself. The list
   endpoint takes no `kind` param, so the split happens here.
   ---------- */
import { useState } from "react";
import { toast } from "sonner";
import { Icon, Modal } from "@/components/primitives";
import { Sk } from "@/components/feedback";
import { Cohorts } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import type { ApiCohort } from "@/routes/cohorts/cohorts.data";

type Props = {
  open: boolean;
  userId: number;
  userName: string;
  /** Cohorts this user is in, from the parent's GET /v1/end-users/:id. */
  cohortIds: number[];
  /** Refetch the parent's detail so its `cohortIds` can't drift from ours. */
  onChanged: () => void;
  onClose: () => void;
};

export function AddToCohortModal({
  open,
  userId,
  userName,
  cohortIds,
  onChanged,
  onClose,
}: Props) {
  const [busy, setBusy] = useState<number | null>(null);
  const {
    data,
    loading,
    refetch: refetchCohorts,
  } = useApi<ApiCohort[]>(() => Cohorts.list<ApiCohort[]>(), [], {
    enabled: open,
  });

  /* Membership is the parent's server truth, mirrored locally so a row flips the
     instant its write resolves rather than a round-trip later. Re-seeding on the
     prop (React's "adjust state on prop change" — cheaper than an effect, no
     extra paint) means the refetch we kick off below reconciles us back to the
     server, so the modal and the page can never disagree. Keyed on the joined
     ids, not the array identity, so a fresh `?? []` each render can't clobber an
     optimistic flip. */
  const seed = cohortIds.join(",");
  const [ids, setIds] = useState<number[]>(cohortIds);
  const [seeded, setSeeded] = useState(seed);
  if (seeded !== seed) {
    setSeeded(seed);
    setIds(cohortIds);
  }

  if (!open) return null;

  const manual = (data ?? []).filter((c) => c.kind === "MANUAL");

  const toggle = async (id: number, name: string, isMember: boolean) => {
    // One write at a time: a fast double-tap would otherwise fire add+remove
    // and land in whichever order the network decided.
    if (busy) return;
    setBusy(id);
    try {
      if (isMember) {
        await Cohorts.removeMember(id, userId);
        setIds((prev) => prev.filter((c) => c !== id));
        toast.success(`${userName} removed from ${name}`);
      } else {
        await Cohorts.addMembers(id, { userIds: [userId] });
        setIds((prev) => [...prev, id]);
        toast.success(`${userName} added to ${name}`);
      }
      // membersCount lives on the cohorts list, cohortIds on the parent's
      // detail — refetch both so neither number is left stale by our write.
      refetchCohorts();
      onChanged();
    } catch (e) {
      const verb = isMember ? "remove from" : "add to";
      toast.error(
        `Couldn't ${verb} ${name}: ` + (e instanceof Error ? e.message : "error"),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title="Add to cohort"
      subtitle={`Pick a manual cohort for ${userName}.`}
      width={520}
      onClose={onClose}
      headerIcon="cohorts"
    >
      {loading ? (
        // Skeleton rows mirror the .intg-card layout below (logo tile · name +
        // description · member tag) so the modal body keeps its shape while the
        // cohort list loads — no text-only "Loading…" flash.
        <div className="pick-list" aria-busy="true" aria-label="Loading cohorts">
          {[0, 1, 2, 3].map((i) => (
            <div className="intg-card atc-sk" key={i} aria-hidden="true">
              <span className="intg-logo"><Sk w={18} h={18} r={6} /></span>
              <span className="intg-card-b">
                <Sk w={120 + ((i * 29) % 70)} h={12} />
                <Sk w={70 + ((i * 37) % 60)} h={9} style={{ marginTop: "var(--sp-6)" }} />
              </span>
              <Sk w={64} h={20} r={999} />
            </div>
          ))}
        </div>
      ) : manual.length === 0 ? (
        <p
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--t3)",
            lineHeight: "var(--lh-normal)",
            margin: "var(--sp-2)",
          }}
        >
          No manual cohorts yet. Auto-updated cohorts can't take a hand-added
          member — they recompute from their filter. Create a manual cohort in
          Cohorts first.
        </p>
      ) : (
        <div className="pick-list">
          {manual.map((c) => {
            const members = c.membersCount ?? 0;
            const isBusy = busy === c.id;
            const isMember = ids.includes(c.id);
            return (
              <button
                key={c.id}
                className="intg-card"
                disabled={!!busy}
                onClick={() => toggle(c.id, c.name, isMember)}
                aria-label={`${isMember ? "Remove" : "Add"} ${userName} ${
                  isMember ? "from" : "to"
                } ${c.name}`}
              >
                <span className="intg-logo">
                  <Icon name="cohorts" size={17} />
                </span>
                <span className="intg-card-b">
                  <span className="intg-card-t">
                    <span className="atc-name" title={c.name}>
                      {c.name}
                    </span>
                    {isMember && <span className="tag">Member</span>}
                  </span>
                  {(isBusy || c.description) && (
                    <span className="intg-card-d">
                      {isBusy
                        ? isMember
                          ? "Removing…"
                          : "Adding…"
                        : c.description}
                    </span>
                  )}
                </span>
                <span className="tag">
                  {members.toLocaleString()} {members === 1 ? "member" : "members"}
                </span>
                <span className={isMember ? "btn q sm" : "btn sm"}>
                  {isMember ? "Remove" : "Add"}
                </span>
                <Icon name="chevR" size={14} className="intg-card-go" />
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
