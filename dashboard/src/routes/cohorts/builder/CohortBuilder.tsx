import { useEffect, useState } from "react";
import { Icon } from "@/components/primitives";
import { V3Drawer } from "@/components/overlays";
import { Cohorts as CohortsApi, type CohortPreview } from "@/api/endpoints";
import { CohortRule } from "./CohortRule";
import {
  CO_AVATARS,
  CO_OPS,
  coDefaultValue,
  coEmptyCond,
  coFieldDef,
  condsToFilter,
  type CoCond,
} from "../cohorts.data";
import type { CohortTemplate } from "../cohort-templates.data";

type CohortBuilderProps = {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
  /** Optional template to seed name/description/mode/rules from (picked in the
   *  gallery). null → a blank builder. */
  template?: CohortTemplate | null;
};

export function CohortBuilder({
  open,
  onClose,
  onCreated,
  template,
}: CohortBuilderProps) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [mode, setMode] = useState("auto");
  const [match] = useState("all");
  // A fresh cohort starts with a single empty rule (consistent with the funnel
  // "1 step" default) — no prefilled demo conditions.
  const [conds, setConds] = useState<CoCond[]>([coEmptyCond()]);
  // Seed (or reset) the form each time the drawer OPENS — the drawer stays
  // mounted, so without this a second template pick would reuse stale state.
  // A template prefills name/description/mode/rules; no template → blank.
  useEffect(() => {
    if (!open) return;
    if (template) {
      setName(template.name);
      setDesc(template.tagline);
      setMode(template.mode ?? "auto");
      setConds(
        template.rules.length
          ? template.rules.map((r) => ({ ...r }))
          : [coEmptyCond()],
      );
    } else {
      setName("");
      setDesc("");
      setMode("auto");
      setConds([coEmptyCond()]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template?.id]);
  const [preview, setPreview] = useState<CohortPreview | null>(null);
  const [creating, setCreating] = useState(false);
  const setAt = (i: number, next: CoCond) =>
    setConds((cs) => cs.map((c, idx) => (idx === i ? next : c)));
  const changeField = (i: number, nv: string) => {
    const nf = coFieldDef(nv);
    setAt(i, {
      field: nv,
      op: CO_OPS[nf.kind][0][0],
      value: coDefaultValue(nf),
    });
  };
  const add = () => setConds((cs) => [...cs, coEmptyCond()]);
  const remove = (i: number) => setConds((cs) => cs.filter((_, x) => x !== i));

  // Live match count — POST /v1/cohorts/preview, debounced as rules change.
  // Manual cohorts have no live rule set, so preview is skipped (0 until seeded).
  useEffect(() => {
    if (!open || mode !== "auto") {
      setPreview(null);
      return;
    }
    const filter = condsToFilter(conds, match);
    let cancelled = false;
    const t = setTimeout(() => {
      CohortsApi.preview({ filter })
        .then(({ data }) => {
          if (!cancelled) setPreview(data);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, mode, conds, match]);

  const create = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const kind = mode === "auto" ? "AUTO" : "MANUAL";
      await CohortsApi.create({
        name: name.trim(),
        description: desc.trim() || undefined,
        kind,
        filter: kind === "AUTO" ? condsToFilter(conds, match) : undefined,
      });
      onCreated?.();
      onClose();
    } catch (e) {
      alert(
        "Could not create cohort: " +
          (e instanceof Error ? e.message : "unknown error"),
      );
    } finally {
      setCreating(false);
    }
  };

  // Matched-users avatars — driven entirely by the live preview sample (never a
  // fabricated set). Manual mode / no match / no preview → no avatars.
  const sample = mode === "auto" && preview ? preview.sample : [];
  const shownAvatars = sample.slice(0, 5);
  const moreCount =
    mode === "auto" && preview ? preview.count - shownAvatars.length : 0;
  const avaInitials = (u: CohortPreview["sample"][number]): string => {
    if (u.initials && u.initials.trim())
      return u.initials.trim().slice(0, 2).toUpperCase();
    // Fall back to distinctId for anonymous-but-tracked users (e.g.
    // "rn_demo_user" → "RN") so they render a glyph instead of "?".
    const base = (u.name || u.email || u.distinctId || "").trim();
    if (!base) return "?";
    const parts = base.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return base.slice(0, 2).toUpperCase();
  };

  return (
    <V3Drawer
      open={open}
      onClose={onClose}
      title={template ? "New cohort from template" : "New cohort"}
      width={720}
      footer={
        <>
          <span className="co-foot-hint">
            {mode === "auto" ? (
              <>
                <Icon name="refresh" size={12} /> Recomputes every 5 min
              </>
            ) : (
              <>
                <Icon name="pin" size={12} /> Members are fixed until edited
              </>
            )}
          </span>
          <span className="sp" style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={create}
            disabled={creating || !name.trim()}
          >
            <Icon name="plus" size={12} />{" "}
            {creating ? "Creating…" : "Create cohort"}
          </button>
        </>
      }
    >
      <div className="co-grp">
        <div className="field-row">
          <label>Name</label>
          <input
            className="text-input co-name-in"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Power users (Pro)"
          />
        </div>
        <div className="field-row">
          <label>
            Description <span className="co-opt">optional</span>
          </label>
          <textarea
            className="text-input co-desc-in"
            rows={2}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="What is this segment, and how should the team use it?"
          />
        </div>
      </div>

      <div className="co-grp">
        <label className="co-lab">Membership</label>
        <div className="co-modes">
          <button
            className={`co-mode ${mode === "auto" ? "on" : ""}`}
            onClick={() => setMode("auto")}
          >
            <span className="co-mode-ic">
              <Icon name="refresh" size={15} />
            </span>
            <span className="co-mode-t">Auto-updated</span>
            <span className="co-mode-d">
              Membership follows live rules — users join and leave as they
              match.
            </span>
            <span className="co-mode-rd" />
          </button>
          <button
            className={`co-mode ${mode === "manual" ? "on" : ""}`}
            onClick={() => setMode("manual")}
          >
            <span className="co-mode-ic">
              <Icon name="users" size={15} />
            </span>
            <span className="co-mode-t">Manual</span>
            <span className="co-mode-d">
              Hand-pick a fixed set of users. Membership only changes when you
              edit it.
            </span>
            <span className="co-mode-rd" />
          </button>
        </div>
      </div>

      {mode === "auto" ? (
        <div className="co-grp">
          <div className="co-cond-head">
            <label className="co-lab" style={{ margin: 0 }}>
              Rules
            </label>
            <span className="co-rules-hint">Users must match all</span>
          </div>
          <div className="co-conds">
            {conds.map((c, i) => (
              <CohortRule
                key={i}
                cond={c}
                index={i}
                connector={match === "all" ? "and" : "or"}
                canRemove={conds.length > 1}
                onField={(nv) => changeField(i, nv)}
                onOp={(op) => setAt(i, { ...c, op })}
                onValue={(v) => setAt(i, { ...c, value: v })}
                onRemove={() => remove(i)}
              />
            ))}
          </div>
          <button className="co-addrule" onClick={add}>
            <Icon name="plus" size={12} /> Add rule
          </button>
        </div>
      ) : (
        <div className="co-grp">
          <label className="co-lab">Members</label>
          <div className="co-manual">
            <div className="co-manual-ic">
              <Icon name="users" size={18} />
            </div>
            <div className="co-manual-txt">
              <b>Add members after creating</b>
              <span>
                Pick users from any session, search by property, or import a CSV
                of user IDs.
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="co-preview">
        {shownAvatars.length > 0 && (
          <div className="co-ava">
            {shownAvatars.map((u, i) => (
              <span
                key={u.id}
                className="co-av"
                style={{
                  background: CO_AVATARS[i % CO_AVATARS.length][0],
                  zIndex: 6 - i,
                }}
              >
                {avaInitials(u)}
              </span>
            ))}
          </div>
        )}
        {moreCount > 0 && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              height: 26,
              padding: "0 var(--sp-10)",
              borderRadius: "var(--r-pill)",
              border: "1px solid var(--line)",
              background: "var(--surface)",
              fontSize: "var(--text-xs)",
              fontWeight: "var(--fw-semibold)",
              color: "var(--t2)",
              flexShrink: 0,
            }}
          >
            +{moreCount.toLocaleString()} more user{moreCount === 1 ? "" : "s"}
          </span>
        )}
        <div className="co-preview-txt">
          {mode === "auto" ? (
            <>
              <b>{preview ? preview.count.toLocaleString() : "…"}</b> users
              match right now
            </>
          ) : (
            <>
              <b>0</b> members · add them after creating
            </>
          )}
        </div>
        {mode === "auto" && (
          <span className="co-preview-live">
            <span className="co-live-dot" /> live
          </span>
        )}
      </div>
    </V3Drawer>
  );
}
