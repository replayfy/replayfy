import { useState } from "react";
import { Modal } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Workspaces } from "@/api/endpoints";

type DeleteWorkspaceModalProps = {
  onClose: () => void;
  workspaceId: number | null;
  name: string;
};

/* Confirm-to-delete → DELETE /v1/workspaces/:id (ADMIN-gated). On success the
   current workspace is gone, so we hard-reload to '/' and let /me re-derive the
   next workspace rather than leaving the app pointed at a deleted id. */
export function DeleteWorkspaceModal({
  onClose,
  workspaceId,
  name,
}: DeleteWorkspaceModalProps) {
  const [txt, setTxt] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const ok = !!name && txt.trim() === name && !busy;
  const del = async () => {
    if (!ok || workspaceId == null) return;
    setBusy(true);
    try {
      await Workspaces.remove(workspaceId);
      window.location.assign("/");
    } catch (e) {
      toast &&
        toast(e instanceof Error ? e.message : "Could not delete workspace", {
          kind: "err",
        });
      setBusy(false);
    }
  };
  return (
    <Modal
      title={
        <>
          Delete <span style={{ color: "var(--red)" }}>{name}</span>?
        </>
      }
      onClose={onClose}
      width={460}
      subtitle={
        <>
          This will permanently delete <strong>{name}</strong> and every
          recording, comment, cohort, playlist, and invite associated with it.
          Team members will lose access immediately.
        </>
      }
      footer={
        <>
          <span className="sp" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger"
            style={{
              opacity: ok ? 1 : 0.5,
              pointerEvents: ok ? "auto" : "none",
            }}
            onClick={del}
          >
            Delete workspace
          </button>
        </>
      }
    >
      <div style={{ fontSize: "var(--text-sm)", marginBottom: "var(--sp-8)" }}>
        To confirm, type{" "}
        <code
          className="mono"
          style={{
            background: "var(--line)",
            padding: "var(--sp-2) var(--sp-6)",
            borderRadius: "var(--r-xs)",
          }}
        >
          {name}
        </code>{" "}
        below:
      </div>
      <input
        className="in"
        autoFocus
        value={txt}
        onChange={(e) => setTxt(e.target.value)}
        placeholder={name}
      />
    </Modal>
  );
}
