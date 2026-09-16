import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon, Select } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Workspaces } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { relTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { InviteModal } from "../modals/InviteModal";
import { SkInviteRows, SkTeamRows } from "./SetSkeletons";
import {
  uhue,
  adaptMember,
  adaptInvite,
  type ApiMember,
  type ApiInvite,
  type MemberRow,
} from "../settings.data";

// Assignable roles for a non-owner member. OWNER is intentionally excluded —
// the owner row is a static badge and can't be reassigned or removed (the API
// forbids both), so it never appears as an option here.
const ROLES = ['Admin', 'Member', 'Viewer'];

/* Panel: Team — members from GET /v1/workspaces/:id/members, pending invites
   from GET .../invites. Invite → InviteModal → POST .../invites; resend/cancel
   hit the matching invite routes then refetch. The member Role is an editable
   Select (PATCH .../members/:memberId) that also carries a "Remove member"
   action (DELETE .../members/:memberId) behind a warning modal. The workspace
   owner is exempt: their row shows a read-only badge, matching the backend
   guards that reject changing or removing the owner. */
export function PanelTeam() {
  const [invite, setInvite] = useState(false);
  // Deep-link (⌘K → "Invite teammates"): `/settings/team?invite=1` opens the
  // invite modal directly instead of just landing on the page. One-shot via a ref
  // latch — a bare effect double-fires under React 18 StrictMode — and the param
  // is stripped so a manual modal-close won't reopen it.
  const [searchParams, setSearchParams] = useSearchParams();
  const inviteDeepLinked = useRef(false);
  useEffect(() => {
    if (searchParams.get("invite") == null || inviteDeepLinked.current) return;
    inviteDeepLinked.current = true;
    setInvite(true);
    setSearchParams(
      (p) => {
        p.delete("invite");
        return p;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);
  // Portal the Invite button into the settings header, beside the "Team" title.
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  useEffect(
    () => setActionSlot(document.getElementById("set-page-action")),
    [],
  );
  const { workspaceId, can, role, memberships, setWorkspace, refresh } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [delMember, setDelMember] = useState<MemberRow | null>(null);
  // Leave-workspace confirm. `leaving` guards the button while the request +
  // refetch are in flight so a double-click can't fire two leave calls.
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const {
    data: memberData,
    loading: membersLoading,
    stale: membersStale,
    refetch: refetchMembers,
  } = useApi<ApiMember[]>(
    () => Workspaces.members<ApiMember[]>(workspaceId!),
    [workspaceId],
    { enabled: workspaceId != null },
  );
  const {
    data: inviteData,
    loading: invitesLoading,
    stale: invitesStale,
    refetch: refetchInvites,
  } = useApi<ApiInvite[]>(
    () => Workspaces.invites<ApiInvite[]>(workspaceId!),
    [workspaceId],
    { enabled: workspaceId != null },
  );
  /* Cold load only. `stale` = the PREVIOUS workspace's roster, held by
     keepPreviousData while the new key resolves — showing it would put one
     workspace's members under another's id. `syncing` is deliberately NOT here:
     a role change or a cancelled invite refetches the SAME key, and blanking the
     table the admin is working in to re-fetch a row they just changed would
     throw away the thing they are looking at. */
  const membersBusy = membersLoading || membersStale;
  const invitesBusy = invitesLoading || invitesStale;
  const members = membersBusy ? [] : (memberData ?? []).map(adaptMember);
  const invites = invitesBusy ? [] : (inviteData ?? []).map(adaptInvite);

  const guard = async (fn: () => Promise<unknown>, ok: string) => {
    if (workspaceId == null) return;
    try {
      await fn();
      toast && toast(ok, { kind: "ok" });
      refetchInvites();
    } catch (e) {
      toast &&
        toast(e instanceof Error ? e.message : "Failed", { kind: "err" });
    }
  };
  const resend = (id: number) =>
    guard(() => Workspaces.resendInvite(workspaceId!, id), "Invite resent");
  const cancel = (id: number) =>
    guard(() => Workspaces.cancelInvite(workspaceId!, id), "Invite cancelled");
  const resendAll = () =>
    guard(
      () =>
        Promise.all(
          invites.map((p) => Workspaces.resendInvite(workspaceId!, p.id)),
        ),
      "Invites resent",
    );

  // Change a member's role (Owner/Admin/Member) → PATCH, then refetch members.
  const changeRole = async (m: MemberRow, role: string) => {
    if (workspaceId == null || m.role === role) return;
    try {
      await Workspaces.updateMember(workspaceId, m.id, { role: role.toUpperCase() });
      toast && toast(`${m.name} is now ${role}`, { kind: "ok" });
      refetchMembers();
    } catch (e) {
      toast && toast(e instanceof Error ? e.message : "Couldn't change role", { kind: "err" });
    }
  };
  // Remove a member after the warning modal confirms.
  const confirmDelete = async () => {
    if (workspaceId == null || !delMember) return;
    try {
      await Workspaces.removeMember(workspaceId, delMember.id);
      toast && toast(`${delMember.name} removed`, { kind: "ok" });
      setDelMember(null);
      refetchMembers();
    } catch (e) {
      toast && toast(e instanceof Error ? e.message : "Couldn't remove member", { kind: "err" });
    }
  };

  // The workspace you're about to leave (name for the confirm copy).
  const currentWs = memberships.find((m) => m.workspaceId === workspaceId)?.workspace;
  const wsName = currentWs?.name ?? "this workspace";
  /* The backend blocks the LAST owner from leaving (they'd strand the
     workspace). Mirror it so the button explains itself instead of round-
     tripping to a 403: an owner who is the only owner among the loaded members
     is blocked here too. Non-owners are never blocked. `members` is already
     loaded for the roster, so this is free. */
  const ownerCount = members.filter((m) => m.role === "Owner").length;
  // Only trust the owner-count once the roster has actually loaded: during the
  // cold load `members` is [] (membersBusy), so ownerCount is 0 and an OWNER
  // would be wrongly flagged sole — briefly disabling their Leave button with
  // the wrong reason. While loading, leave it enabled; the backend still
  // refuses a genuine sole owner.
  const soleOwner = role === "OWNER" && !membersBusy && ownerCount <= 1;

  const confirmLeave = async () => {
    if (workspaceId == null || leaving) return;
    setLeaving(true);
    try {
      await Workspaces.leave(workspaceId);
      // Move off the workspace we just left: hop to another membership if there
      // is one, else clear the pointer and let RequireAuth send us to
      // onboarding. refresh() re-reads /v1/me so the left workspace is gone from
      // the switcher; applyMe keeps a still-valid pointer or falls back itself.
      const next = memberships.find((m) => m.workspaceId !== workspaceId);
      if (next) setWorkspace(next.workspaceId);
      await refresh();
      toast && toast(`You've left ${wsName}`, { kind: "ok" });
      setLeaveOpen(false);
      navigate("/", { replace: true });
    } catch (e) {
      toast && toast(e instanceof Error ? e.message : "Couldn't leave workspace", { kind: "err" });
      setLeaving(false);
    }
  };

  return (
    <>
      {/* Inviting, changing a role and removing a member are all ADMIN on the
          API. The only gate here used to be the TARGET member's role — it
          protected the owner's row from everyone, and protected nothing from
          anyone else. */}
      {can.manageTeam &&
        actionSlot &&
        createPortal(
          <button className="btn primary sm" onClick={() => setInvite(true)}>
            <Icon name="plus" size={12} /> Invite member
          </button>,
          actionSlot,
        )}

      <div className="set-card">
        <table className="set-team-tbl" style={{ margin: 0 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: "var(--sp-16)" }}>Member</th>
              <th style={{ width: 110 }}>Role</th>
              <th style={{ width: 130 }}>Last active</th>
              <th style={{ width: 44 }}></th>
            </tr>
          </thead>
          <tbody>
            {/* Ahead of the "No members yet." guard below: with no rows and no
                skeleton, a cold load rendered that guard — every workspace has
                at least its owner, so it was never true, just early. */}
            {membersBusy && <SkTeamRows />}
            {members.map((m) => (
              <tr key={m.email}>
                <td style={{ paddingLeft: "var(--sp-16)" }}>
                  <div className="set-team-member">
                    <span className="u-av" style={{ background: uhue(m.name) }}>
                      {m.name[0]}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="set-team-name">{m.name}</div>
                      <div className="mono set-team-email">{m.email}</div>
                    </div>
                  </div>
                </td>
                {/* Role — owner is read-only (API rejects changing/removing the
                    owner); everyone else gets the Select with a Remove action. */}
                <td>
                  {m.role === "Owner" || !can.manageTeam ? (
                    <span className="tag info">{m.role}</span>
                  ) : (
                    <Select
                      value={m.role}
                      label="Change role"
                      width={128}
                      options={[
                        ...ROLES,
                        { divider: true },
                        {
                          value: "__remove__",
                          label: (
                            <span style={{ color: "var(--red)" }}>Remove member</span>
                          ),
                        },
                      ]}
                      onChange={(v) =>
                        v === "__remove__" ? setDelMember(m) : changeRole(m, v)
                      }
                    />
                  )}
                </td>
                <td className="set-team-active">{relTime(m.lastActiveAt)}</td>
                <td />
              </tr>
            ))}
            {!membersBusy && members.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  style={{
                    padding: "var(--sp-16)",
                    textAlign: "center",
                    color: "var(--t3)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  No members yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="set-card" style={{ marginTop: "var(--sp-24)" }}>
        <div className="set-card-h">
          <h3>Pending invites</h3>
          <span style={{ flex: 1 }} />
          {invites.length > 0 && (
            <button className="btn q sm" onClick={resendAll}>
              Resend all
            </button>
          )}
        </div>
        <table style={{ margin: 0 }}>
          <tbody>
            {invitesBusy && <SkInviteRows />}
            {invites.map((p) => (
              <tr key={p.id}>
                <td style={{ paddingLeft: "var(--sp-16)" }}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: "var(--sp-10)" }}
                  >
                    <span
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        background: "var(--line-2)",
                        border: "1.5px dashed var(--line-strong)",
                        display: "grid",
                        placeItems: "center",
                        color: "var(--t3)",
                      }}
                    >
                      <Icon name="cal" size={12} />
                    </span>
                    <div>
                      <div className="mono" style={{ fontSize: "var(--text-sm)" }}>
                        {p.email}
                      </div>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--t3)" }}>
                        Invite sent {p.sent}
                      </div>
                    </div>
                  </div>
                </td>
                <td style={{ width: 110 }}>
                  <span className="tag">{p.role}</span>
                </td>
                <td
                  style={{ width: 180, textAlign: "right", paddingRight: "var(--sp-12)" }}
                >
                  <button className="btn q sm" onClick={() => resend(p.id)}>
                    <Icon name="refresh" size={11} /> Resend
                  </button>
                  <button
                    className="btn q sm"
                    style={{ marginLeft: "var(--sp-4)", color: "var(--red)" }}
                    onClick={() => cancel(p.id)}
                  >
                    <Icon name="trash" size={11} />
                  </button>
                </td>
              </tr>
            ))}
            {!invitesBusy && invites.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  style={{
                    padding: "var(--sp-16)",
                    textAlign: "center",
                    color: "var(--t3)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  No pending invites.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Leave workspace — self-service exit. Any member may leave; the sole
          owner can't (mirrors the API), so the action is shown but disabled
          with a reason. Sits apart from the roster, styled as a quiet danger
          row rather than a loud "danger zone" the page doesn't otherwise have. */}
      <div className="set-card" style={{ marginTop: "var(--sp-24)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-16)",
            padding: "var(--sp-14) var(--sp-16)",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: "var(--text-base)", fontWeight: "var(--fw-semibold)", color: "var(--text)" }}>
              Leave workspace
            </div>
            <div style={{ fontSize: "var(--text-sm)", color: "var(--t3)", marginTop: "var(--sp-2)", lineHeight: "var(--lh-normal)" }}>
              {soleOwner
                ? "You're the only owner. Transfer ownership to another member, or delete the workspace, before you can leave."
                : `Remove yourself from ${wsName} — you'll lose access until you're invited back.`}
            </div>
          </div>
          <button
            className="btn sm"
            disabled={soleOwner}
            style={{
              flexShrink: 0,
              color: soleOwner ? undefined : "var(--red)",
              borderColor: soleOwner ? undefined : "color-mix(in srgb, var(--red) 32%, var(--line-strong))",
            }}
            onClick={() => setLeaveOpen(true)}
          >
            <Icon name="logout" size={12} /> Leave
          </button>
        </div>
      </div>

      {invite && (
        <InviteModal
          onClose={() => setInvite(false)}
          workspaceId={workspaceId}
          onInvited={refetchInvites}
        />
      )}

      {/* Remove-member warning modal. */}
      {delMember && (
        <div
          onClick={() => setDelMember(null)}
          style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(17,17,20,.42)", display: "grid", placeItems: "center", padding: "var(--sp-20)" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 424, background: "var(--surface)", borderRadius: "var(--r-lg)", border: "1px solid var(--line)", boxShadow: "0 12px 28px rgb(17 17 20 / .16), 0 32px 64px -22px rgb(17 17 20 / .28)", padding: "var(--sp-20)" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-10)", marginBottom: "var(--sp-10)" }}>
              <span style={{ width: 34, height: 34, borderRadius: "var(--r-md)", display: "grid", placeItems: "center", background: "color-mix(in srgb, var(--red) 12%, transparent)", color: "var(--red)", flexShrink: 0 }}><Icon name="trash" size={16} /></span>
              <h3 style={{ fontSize: "var(--text-md)", fontWeight: "var(--fw-semibold)" }}>Remove {delMember.name}?</h3>
            </div>
            <p style={{ fontSize: "var(--text-base)", color: "var(--t2)", lineHeight: "var(--lh-body)", margin: "0 0 var(--sp-18)" }}>
              <b style={{ color: "var(--text)" }}>{delMember.email}</b> will immediately lose access to this workspace and all its recordings. This can’t be undone.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--sp-8)" }}>
              <button className="btn" onClick={() => setDelMember(null)}>Cancel</button>
              <button className="btn" style={{ background: "var(--red)", borderColor: "var(--red)", color: "#fff" }} onClick={confirmDelete}><Icon name="trash" size={13} /> Remove member</button>
            </div>
          </div>
        </div>
      )}

      {/* Leave-workspace confirm. Same modal chrome as the remove-member one
          above, but the accent is neutral, not red — you're removing yourself,
          not deleting someone. */}
      {leaveOpen && (
        <div
          onClick={() => !leaving && setLeaveOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(17,17,20,.42)", display: "grid", placeItems: "center", padding: "var(--sp-20)" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 424, background: "var(--surface)", borderRadius: "var(--r-lg)", border: "1px solid var(--line)", boxShadow: "0 12px 28px rgb(17 17 20 / .16), 0 32px 64px -22px rgb(17 17 20 / .28)", padding: "var(--sp-20)" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-10)", marginBottom: "var(--sp-10)" }}>
              <span style={{ width: 34, height: 34, borderRadius: "var(--r-md)", display: "grid", placeItems: "center", background: "var(--accent-tint)", color: "var(--accent)", flexShrink: 0 }}><Icon name="logout" size={16} /></span>
              <h3 style={{ fontSize: "var(--text-md)", fontWeight: "var(--fw-semibold)" }}>Leave {wsName}?</h3>
            </div>
            <p style={{ fontSize: "var(--text-base)", color: "var(--t2)", lineHeight: "var(--lh-body)", margin: "0 0 var(--sp-18)" }}>
              You'll immediately lose access to this workspace and its recordings. An admin can invite you back later.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--sp-8)" }}>
              <button className="btn" disabled={leaving} onClick={() => setLeaveOpen(false)}>Cancel</button>
              <button className="btn" disabled={leaving} style={{ background: "var(--red)", borderColor: "var(--red)", color: "#fff" }} onClick={confirmLeave}><Icon name="logout" size={13} /> {leaving ? "Leaving…" : "Leave workspace"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
