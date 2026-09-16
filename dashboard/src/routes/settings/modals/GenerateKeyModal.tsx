import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Icon, Modal } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { ApiKeys } from "@/api/endpoints";

export type CreatedKey = { name: string; scope: string; rawKey: string };
type GenerateKeyModalProps = {
  onClose: () => void;
  onCreated?: () => void;
  /** When set (e.g. after a key rotation), the modal opens straight on the
   *  reveal screen for this already-created key — no generate form. */
  preset?: CreatedKey;
};

/* Generate an API key → POST /v1/api-keys. Scope enum is upper-cased for the
   backend (PUBLIC/SERVER/WEBHOOK). The raw key comes back exactly ONCE on
   create (the server only persists a hash), so the modal has two phases:
   (1) the generate form, then (2) a reveal screen that shows the plaintext key
   with a copy button. We must NOT close on create — that would discard the only
   copy of the key. onCreated?.() refetches the list behind the reveal. */
export function GenerateKeyModal({
  onClose,
  onCreated,
  preset,
}: GenerateKeyModalProps) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState("public");
  const [envs, setEnvs] = useState(["prod"]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(preset ?? null);
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const reduce = useReducedMotion();
  const SCOPES = [
    [
      "public",
      "Public key",
      "Client-safe. Used by SDKs in browsers and mobile apps.",
      "globe",
    ],
    [
      "server",
      "Server key",
      "Server-only. Read/write access to the management API.",
      "chip",
    ],
    [
      "webhook",
      "Webhook secret",
      "Signs outbound webhooks so your server can verify them.",
      "plug",
    ],
  ];
  const toggleEnv = (e: string) =>
    setEnvs((v) => (v.includes(e) ? v.filter((x) => x !== e) : [...v, e]));

  const generate = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const { data } = await ApiKeys.create<{
        name: string;
        scope: string;
        prefix: string;
        rawKey: string;
      }>({
        name: name.trim(),
        scope: scope.toUpperCase(),
        envs: scope === "webhook" ? [] : envs,
      });
      setCreated({ name: data.name, scope: data.scope, rawKey: data.rawKey });
      onCreated?.(); // refetch the list behind the reveal; do NOT close yet
    } catch (e) {
      toast &&
        toast(e instanceof Error ? e.message : "Could not create key", {
          kind: "err",
        });
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard?.writeText(created.rawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      toast && toast("API key copied to clipboard", { kind: "ok" });
    } catch {
      toast &&
        toast("Could not copy — select and copy the key manually", {
          kind: "err",
        });
    }
  };

  // Fade + slide + blur between phases; offset and blur are dropped when
  // reduced motion is on. The blur bridges the form↔reveal identity change so
  // the two very different panels don't hard-cut at the handoff.
  const dx = reduce ? 0 : 14;
  const bl = reduce ? 0 : 3;
  const anim = { duration: 0.22, ease: [0.32, 0.72, 0, 1] as const };

  const scopeLabel = (s: string) =>
    s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;

  return (
    <Modal
      title={created ? "Copy your API key" : "Generate new API key"}
      onClose={onClose}
      width={500}
      headerIcon={created ? "check" : "key"}
      headerTone={created ? "ok" : undefined}
      /* form → the one-time key reveal. The title and close button stay put
         while the body expands underneath them, so the step change reads as
         this surface answering rather than a second dialog taking over. */
      viewKey={created ? "created" : "form"}
      subtitle={
        created
          ? "This is the only time we can show you the key — copy it now and store it somewhere safe."
          : "Choose a scope, give the key a name, and we'll show it once on the next screen."
      }
      footer={
        created ? (
          <>
            <span className="sp" />
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <span className="sp" />
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              style={{
                opacity: name.trim() && !busy ? 1 : 0.5,
                pointerEvents: name.trim() && !busy ? "auto" : "none",
              }}
              onClick={generate}
            >
              {busy ? (
                "Generating…"
              ) : (
                <>
                  <Icon name="key" size={13} /> Generate key
                </>
              )}
            </button>
          </>
        )
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        {!created ? (
          <motion.div
            key="form"
            initial={{ opacity: 0, x: -dx, filter: `blur(${bl}px)` }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: -dx, filter: `blur(${bl}px)` }}
            transition={anim}
          >
            <div className="fld">
              <div className="fld-l">Name</div>
              <input
                className="in"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Production iOS"
              />
            </div>
            <div className="fld">
              <div className="fld-l">Scope</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
                {SCOPES.map((s) => (
                  <button
                    key={s[0]}
                    className={`scope-card ${scope === s[0] ? "on" : ""}`}
                    onClick={() => setScope(s[0])}
                  >
                    <span className="scope-ic">
                      <Icon name={s[3]} size={15} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                      <span className="scope-t">{s[1]}</span>
                      <span className="scope-d">{s[2]}</span>
                    </span>
                    <span className="scope-radio" />
                  </button>
                ))}
              </div>
            </div>
            {scope !== "webhook" && (
              <div className="fld">
                <div className="fld-l">Environments</div>
                <div style={{ display: "flex", gap: "var(--sp-8)" }}>
                  {["prod", "staging", "dev"].map((e) => (
                    <button
                      key={e}
                      className={`env-chip ${envs.includes(e) ? "on" : ""}`}
                      onClick={() => toggleEnv(e)}
                    >
                      {envs.includes(e) && (
                        <Icon
                          name="x"
                          size={10}
                          style={{ transform: "rotate(45deg)" }}
                        />
                      )}
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="reveal"
            initial={{ opacity: 0, x: dx, filter: `blur(${bl}px)` }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: dx, filter: `blur(${bl}px)` }}
            transition={anim}
          >
            <div className="gk-reveal-lead">
              <span className="tag ok">{scopeLabel(created.scope)}</span> key{" "}
              <b>{created.name}</b> is ready.
            </div>
            <div className="gk-key">
              <input
                className="gk-key-in mono"
                readOnly
                value={created.rawKey}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button className="btn sm" onClick={copy}>
                {copied ? (
                  <>
                    <Icon name="check" size={12} /> Copied
                  </>
                ) : (
                  <>
                    <Icon name="doc" size={12} /> Copy
                  </>
                )}
              </button>
            </div>
            <div className="gk-warn">
              <Icon name="warn" size={13} /> You won't be able to see this key
              again — copy it and store it somewhere safe.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}
