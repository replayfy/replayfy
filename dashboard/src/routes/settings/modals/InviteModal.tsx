import { useState } from "react";
import { Modal } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Workspaces } from "@/api/endpoints";

type InviteModalProps = {
  onClose: () => void;
  workspaceId: number | null;
  onInvited?: () => void;
};

/* Invite teammates → POST /v1/workspaces/:id/invites. The textarea accepts many
   emails (comma/newline separated); the backend takes one email per call, so we
   fan out with allSettled and report how many landed vs. failed (e.g. already a
   member / already invited each 403 individually). */
export function InviteModal({
  onClose,
  workspaceId,
  onInvited,
}: InviteModalProps) {
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState("Member");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const ROLES = [
    ["Viewer", "Can watch recordings only"],
    ["Member", "Can watch, comment, build playlists"],
    ["Admin", "Can also change settings"],
  ];
  const send = async () => {
    if (workspaceId == null || busy) return;
    const list = emails
      .split(/[\s,]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (list.length === 0) {
      toast && toast("Enter at least one email", { kind: "err" });
      return;
    }
    setBusy(true);
    try {
      const results = await Promise.allSettled(
        list.map((email) =>
          Workspaces.createInvite(workspaceId, {
            email,
            role: role.toUpperCase(),
          }),
        ),
      );
      const sent = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - sent;
      if (sent > 0)
        toast &&
          toast(
            failed
              ? `${sent} invite${sent > 1 ? "s" : ""} sent, ${failed} skipped`
              : `${sent} invite${sent > 1 ? "s" : ""} sent`,
            { kind: "ok" },
          );
      else toast && toast("No invites sent", { kind: "err" });
      onInvited?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Invite teammates"
      onClose={onClose}
      subtitle="Members can watch recordings, comment, and build playlists. Admins can also change settings."
      footer={
        <>
          <span className="sp" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={send}>
            Send invites
          </button>
        </>
      }
    >
      <div className="fld">
        <div className="fld-l">Email addresses</div>
        <textarea
          className="in"
          autoFocus
          rows={3}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder="theo@example.com, priya@example.com"
          style={{ resize: "vertical", fontFamily: "inherit" }}
        />
        <div style={{ fontSize: "var(--text-xs)", color: "var(--t3)", marginTop: "var(--sp-6)" }}>
          Separate multiple emails with commas or new lines.
        </div>
      </div>
      <div className="fld">
        <div className="fld-l">Role</div>
        <div className="role-cards">
          {ROLES.map((r) => (
            <button
              key={r[0]}
              className={`role-card ${role === r[0] ? "on" : ""}`}
              onClick={() => setRole(r[0])}
            >
              <div className="role-n">{r[0]}</div>
              <div className="role-d">{r[1]}</div>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
