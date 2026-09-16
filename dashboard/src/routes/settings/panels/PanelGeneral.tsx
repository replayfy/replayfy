import { useState } from "react";
import { Icon } from "@/components/primitives";
import { Sk } from "@/components/feedback";
import { Workspaces, type WorkspaceSummary } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { useAuth } from "@/lib/auth";
import { ee } from "@ee";
import { SetRow } from "./SetRow";
import { DeleteWorkspaceModal } from "../modals/DeleteWorkspaceModal";

/* Panel: General — name / slug / plan read from GET /v1/workspaces/:id; the
   danger-zone delete is wired through DeleteWorkspaceModal → DELETE /v1/workspaces/:id.
   The name/slug/plan are read-only labels in the approved design (no input), so
   there is no PATCH control to wire here.
   TODO(api): Settings.region.get exists but the frozen General layout has no
   region row to bind it to, so it is intentionally not rendered (adding a row
   would change the approved design). */
export function PanelGeneral() {
  const [confirm, setConfirm] = useState(false);
  const { workspaceId, can } = useAuth();
  const {
    data: ws,
    loading,
    stale,
  } = useApi<WorkspaceSummary>(
    () => Workspaces.get(workspaceId!),
    [workspaceId],
    { enabled: workspaceId != null },
  );
  /* Cold load only. `stale` = the PREVIOUS workspace's name/slug/plan, held by
     keepPreviousData while the new id resolves — the one place on this page
     where showing the old value means showing another workspace's identity
     above a Delete workspace button. `syncing` is excluded (see useApi). */
  const busy = loading || stale;
  const name = ws?.name ?? "";
  return (
    <>
      {/* The labels and help text are static and keep rendering; only the three
          values wait. `plan` in particular defaults to FREE, so a cold load
          badged every paid workspace FREE for a beat before correcting. */}
      <SetRow
        label="Workspace name"
        help="Shown in the sidebar and on every invitation email."
      >
        {busy ? (
          <Sk w={132} h={13} />
        ) : (
          <span className="mono" style={{ fontSize: "var(--text-base)" }}>
            {name}
          </span>
        )}
      </SetRow>
      <SetRow
        label="Slug"
        help="URL-safe identifier used in dashboard links and the SDK projectId."
      >
        {busy ? (
          <Sk w={104} h={13} />
        ) : (
          <span className="mono" style={{ fontSize: "var(--text-base)" }}>
            {ws?.slug ?? ""}
          </span>
        )}
      </SetRow>
      {/* Plan is a billing concept — Enterprise Edition. The open-source build
          is unlimited and unmetered, so the plan row is omitted entirely. */}
      {ee.hasBilling && (
        <SetRow
          label="Plan"
          help="Quota and feature gates derive from this plan."
        >
          {busy ? (
            <Sk w={46} h={17} r={5} />
          ) : (
            <span className="tag info">{(ws?.plan ?? "FREE").toUpperCase()}</span>
          )}
        </SetRow>
      )}
      {/* Deleting the workspace is ADMIN on the API; a member reaching this
          far would only get a 403. Don't offer it. */}
      {can.deleteWorkspace && (
      <>
      <h3 className="set-danger-t">Danger zone</h3>
      <div className="set-danger">
        <div style={{ maxWidth: 460 }}>
          <div style={{ fontWeight: "var(--fw-semibold)", fontSize: "var(--text-base)" }}>
            Delete this workspace
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--t2)",
              marginTop: "var(--sp-4)",
              lineHeight: "var(--lh-normal)",
            }}
          >
            Permanently removes every recording, comment, cohort, playlist,
            invite, and team member. This cannot be undone.
          </div>
        </div>
        <button className="btn danger" onClick={() => setConfirm(true)}>
          <Icon name="trash" size={13} /> Delete workspace
        </button>
      </div>
      </>
      )}
      {confirm && (
        <DeleteWorkspaceModal
          onClose={() => setConfirm(false)}
          workspaceId={workspaceId}
          name={name}
        />
      )}
    </>
  );
}
