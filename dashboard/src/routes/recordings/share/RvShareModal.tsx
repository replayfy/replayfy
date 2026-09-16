/* ---------- Share recording modal (v3 — single view, minimal-radius) ----------
   One surface, no step-morph: a visibility selector ("Anyone with the link" with
   a view/comment dropdown) and an inline Generate → Copy action at the top; the
   minted link reveals in place beneath it; then the per-panel data toggles and
   link expiry. Icons are neutral line glyphs in a low-contrast tile — a scanning
   aid, not decoration. All classes are `shx-`, styled in share-v2.css.

   NOTE: the chosen permission (view / comment) is sent to the share API as
   `permission`. Enforcing "comment" on the public viewer (letting a link holder
   leave comments) is a backend + shared-player follow-up; the selector ships the
   intent now. */
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { Icon, Modal } from "@/components/primitives";
import { Sessions } from "@/api/endpoints";
import { rvDuration, type RvSession } from "../recordings.data";


/* Options, grouped so hierarchy comes from structure rather than a flat list.
   Web and mobile diverge — mobile adds Screens (Interaction) and Crashes
   (Diagnostics) and relabels console → Logs. Defaults: everything ON except
   Comments (internal team context). */
type ShareOpt = { key: string; label: string; hint: string; icon: string };
type ShareGroup = { label: string; opts: ShareOpt[] };

const WEB_GROUPS: ShareGroup[] = [
  {
    label: "Interaction",
    opts: [
      { key: "events", label: "Timeline events", hint: "clicks, navigation, errors", icon: "activity" },
      { key: "comments", label: "Comments", hint: "team comments on this session", icon: "comment" },
    ],
  },
  {
    label: "Technical data",
    opts: [
      { key: "console", label: "Console logs", hint: "console.log / warn / error output", icon: "console" },
      { key: "network", label: "Network requests", hint: "XHR + fetch with timing", icon: "network" },
      { key: "perf", label: "Performance", hint: "request durations + summary", icon: "gauge" },
    ],
  },
];

const MOBILE_GROUPS: ShareGroup[] = [
  {
    label: "Interaction",
    opts: [
      { key: "events", label: "Timeline events", hint: "taps, screens, custom events", icon: "activity" },
      { key: "screens", label: "Screens", hint: "screen-navigation flow", icon: "monitor" },
      { key: "comments", label: "Comments", hint: "team comments on this session", icon: "comment" },
    ],
  },
  {
    label: "Technical data",
    opts: [
      { key: "console", label: "Logs", hint: "console / logcat output", icon: "console" },
      { key: "network", label: "Network requests", hint: "native requests with timing", icon: "network" },
      { key: "perf", label: "Performance", hint: "CPU, memory, thermal, battery", icon: "gauge" },
    ],
  },
  {
    label: "Diagnostics",
    opts: [
      { key: "crashes", label: "Crashes", hint: "crash + ANR reports with stacks", icon: "warn" },
    ],
  },
];

const MOBILE_PLATFORMS = new Set(["android", "ios", "react_native", "rn", "flutter"]);
const groupsFor = (plat: string): ShareGroup[] =>
  MOBILE_PLATFORMS.has(plat) ? MOBILE_GROUPS : WEB_GROUPS;
const allKeys = (groups: ShareGroup[]): string[] =>
  groups.flatMap((g) => g.opts.map((o) => o.key));
const defaultPanels = (plat: string): Record<string, boolean> =>
  Object.fromEntries(allKeys(groupsFor(plat)).map((k) => [k, k !== "comments"]));

const EXPIRY_OPTS = [
  { v: "24h", l: "24 hours" },
  { v: "7d", l: "7 days" },
  { v: "30d", l: "30 days" },
];
const EXPIRY_HOURS: Record<string, number> = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };

/* Link-holder capability. "comment" is sent to the API now; enforcing it on the
   public viewer is a backend follow-up (see the file header). */
type Perm = "view" | "comment";
const PERMS: { v: Perm; t: string; d: string; icon: string }[] = [
  { v: "view", t: "Can view", d: "Watch the recording only", icon: "eye" },
  { v: "comment", t: "Can comment", d: "Watch and leave comments", icon: "comment" },
];

/* Spring toggle — the knob glides via `layout` (its flex position flips with
   the `on` class), so the move is physical rather than a linear transition. */
function ShSwitch({ on }: { on: boolean }) {
  const reduce = useReducedMotion();
  return (
    <span className={`shx-sw ${on ? "on" : ""}`} aria-hidden="true">
      <motion.span
        className="shx-kn"
        layout
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 34 }}
      />
    </span>
  );
}

export function RvShareModal({
  open,
  onClose,
  s,
}: {
  open: boolean;
  onClose: () => void;
  s: RvSession;
}) {
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState(false);
  const [expiry, setExpiry] = useState("7d");
  const [perm, setPerm] = useState<Perm>("view");
  const [permOpen, setPermOpen] = useState(false);
  const [panels, setPanels] = useState<Record<string, boolean>>(() => defaultPanels(s.plat));
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const groups = groupsFor(s.plat);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setLink(null);
    setBusy(false);
    setPerm("view");
    setPermOpen(false);
    setPanels(defaultPanels(s.plat));
    setExpiry("7d");
  }, [open]);

  // Close the visibility menu on an outside click (it's a lightweight popover, not
  // a portalled Popover — the modal already traps focus, so a mousedown guard is
  // enough).
  useEffect(() => {
    if (!permOpen) return;
    const h = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".shx-vis-wrap")) setPermOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [permOpen]);

  if (!open) return null;

  const copy = (url: string) => {
    try {
      navigator.clipboard?.writeText(url);
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
    toast.success("Link copied");
  };

  const mint = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await Sessions.share(s.id, {
        panels,
        expiresInHours: EXPIRY_HOURS[expiry],
        permission: perm,
      });
      const d = (res.data ?? {}) as { url?: string; token?: string };
      let full: string;
      if (d.url) full = d.url.startsWith("http") ? d.url : `${window.location.origin}${d.url}`;
      else if (d.token) full = `${window.location.origin}/s/${d.token}`;
      else full = `https://replayfy.io/s/${s.id}f7b09`;
      setLink(full);
      copy(full);
    } catch (e) {
      toast.error(`Couldn't create share link: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const display = link ? link.replace(/^https?:\/\//, "") : "";
  const springTap = reduce ? undefined : { scale: 0.975 };

  return (
    <Modal
      title="Share recording"
      headerIcon="share"
      subtitle={
        <>
          <span className="shx-hname">{s.name}</span>
          <span className="shx-hmeta"> · {rvDuration(s.durationMs ?? 0)}</span>
        </>
      }
      width={460}
      onClose={onClose}
    >
      <div className="shx">
        {/* Visibility selector + inline Generate / Copy. */}
        <div className="shx-vis-row">
          <div className="shx-vis-wrap">
            <button
              type="button"
              className="shx-vis"
              aria-haspopup="menu"
              aria-expanded={permOpen}
              onClick={() => setPermOpen((o) => !o)}
            >
              <span className="shx-vis-ic" aria-hidden="true">
                <Icon name="globe" size={16} />
              </span>
              <span className="shx-vis-tx">
                <span className="shx-vis-t">Anyone with the link</span>
                <span className="shx-vis-s">{perm === "comment" ? "Can comment" : "Can view"}</span>
              </span>
              <Icon name="chev" size={14} className="shx-vis-cx" />
            </button>
            {permOpen && (
              <div className="shx-perm-menu" role="menu">
                {PERMS.map((p) => (
                  <button
                    key={p.v}
                    type="button"
                    role="menuitemradio"
                    aria-checked={perm === p.v}
                    className={`shx-perm-i ${perm === p.v ? "sel" : ""}`}
                    onClick={() => {
                      setPerm(p.v);
                      setPermOpen(false);
                    }}
                  >
                    <span className="shx-perm-ic" aria-hidden="true">
                      <Icon name={p.icon} size={14} />
                    </span>
                    <span className="shx-perm-tx">
                      <span className="shx-perm-t">{p.t}</span>
                      <span className="shx-perm-d">{p.d}</span>
                    </span>
                    {perm === p.v && <Icon name="check" size={14} className="shx-perm-ck" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <motion.button
            type="button"
            className="shx-cta shx-cta-inline"
            onClick={link ? () => copy(link) : mint}
            disabled={busy}
            whileTap={springTap}
            transition={{ type: "spring", stiffness: 600, damping: 30 }}
          >
            {link ? (
              copied ? (
                <>
                  <Icon name="check" size={15} /> Copied
                </>
              ) : (
                <>
                  <Icon name="copy" size={15} /> Copy link
                </>
              )
            ) : busy ? (
              <>
                <span className="shx-spin" aria-hidden="true" /> Generating…
              </>
            ) : (
              <>
                <Icon name="link" size={15} /> Generate link
              </>
            )}
          </motion.button>
        </div>

        {/* The minted link — revealed in place once generated. */}
        {link && (
          <div className="shx-artifact">
            <span className="shx-artifact-ic" aria-hidden="true">
              <Icon name="lock" size={15} />
            </span>
            <span className="shx-url" title={link}>
              {display}
            </span>
            <button
              type="button"
              className="shx-artifact-re"
              onClick={mint}
              disabled={busy}
              aria-label="Regenerate link"
              title="Regenerate link"
            >
              <Icon name="refresh" size={14} />
            </button>
          </div>
        )}

        {/* What's included. */}
        {groups.map((g) => (
          <section className="shx-grp" key={g.label}>
            <div className="shx-glabel">{g.label}</div>
            <div className="shx-rows">
              {g.opts.map((o) => {
                const on = panels[o.key] ?? o.key !== "comments";
                return (
                  <button
                    type="button"
                    key={o.key}
                    className={`shx-row ${on ? "on" : ""}`}
                    role="switch"
                    aria-checked={on}
                    onClick={() => setPanels((p) => ({ ...p, [o.key]: !on }))}
                  >
                    <span className="shx-ic">
                      <Icon name={o.icon} size={15} />
                    </span>
                    <span className="shx-tx">
                      <span className="shx-title">{o.label}</span>
                      <span className="shx-desc">{o.hint}</span>
                    </span>
                    <ShSwitch on={on} />
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        {/* Expiry. */}
        <section className="shx-grp">
          <div className="shx-glabel">Link expires</div>
          <div className="shx-seg" role="radiogroup" aria-label="Link expiry">
            {EXPIRY_OPTS.map((o) => {
              const sel = expiry === o.v;
              return (
                <button
                  key={o.v}
                  role="radio"
                  aria-checked={sel}
                  className={`shx-seg-b ${sel ? "on" : ""}`}
                  onClick={() => setExpiry(o.v)}
                >
                  {sel && (
                    <motion.span
                      className="shx-seg-pill"
                      layoutId="shx-seg-pill"
                      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 36 }}
                    />
                  )}
                  <span className="l">{o.l}</span>
                </button>
              );
            })}
          </div>
        </section>

        <p className="shx-note">
          Anyone with this link can view the recording — no account needed.
        </p>
      </div>
    </Modal>
  );
}
