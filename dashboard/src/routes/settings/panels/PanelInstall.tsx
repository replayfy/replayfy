import { useState, useEffect } from "react";
import { Icon, Modal, Popover } from "@/components/primitives";
import { InstallSnippet } from "@/components/install";
import { useToast } from "@/components/feedback";
import { ApiKeys, Dashboard, Settings } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { relTime } from "@/lib/format";
import { GenerateKeyModal, type CreatedKey } from "../modals/GenerateKeyModal";
import {
  adaptApiKey,
  SNIP,
  fillSnippet,
  type ApiApiKey,
  type ApiMasking,
} from "../settings.data";
import { SkHostRows, SkInstallBanner, SkKeyRows } from "./SetSkeletons";

type DashCounts = {
  recordings: number;
  live: number;
  lastEventAt: string | null;
  lastEventDomain: string | null;
};

/* Deep link from the selected platform into the public docs (docs.replayfy.app);
   the Web frameworks all share the browser SDK page. Falls back to the quickstart. */
const DOC_PATH: Record<string, string> = {
  web: "platforms/web",
  react: "platforms/web",
  next: "platforms/web",
  vue: "platforms/web",
  rn: "platforms/react-native",
  swift: "platforms/ios",
  android: "platforms/android",
  flutter: "platforms/flutter",
};

/* Panel: Install — API keys from GET /v1/api-keys (revoked keys filtered out);
   Rotate → POST .../rotate, Revoke key → DELETE .../:id. Allowed hosts read/write
   through the masking config (Settings.masking.allowedHosts) since that's where
   the ingest allowlist lives. GenerateKeyModal POSTs a new key and reveals it once.
   The install status banner is wired to GET /v1/dashboard/counts (single indexed
   aggregate — no scan) so it reflects whether events are actually arriving, and
   polls while waiting so it flips to "active" on its own. The snippet embeds the
   workspace's REAL publishable key from GET /v1/api-keys/public (the per-platform
   SNIP_PROJECT_KEY placeholder is substituted). */
export function PanelInstall() {
  const [tab, setTab] = useState("web");
  const [draft, setDraft] = useState("");
  const [genKey, setGenKey] = useState(false);
  // Set after a successful rotate → opens the reveal modal on the new raw key.
  const [revealed, setRevealed] = useState<CreatedKey | null>(null);
  // The key pending revoke — drives the destructive-confirm modal.
  const [revokeTarget, setRevokeTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const toast = useToast();
  const {
    data: keyData,
    loading: keysLoading,
    stale: keysStale,
    refetch: refetchKeys,
  } = useApi<ApiApiKey[]>(() => ApiKeys.list<ApiApiKey[]>());
  const {
    data: masking,
    loading: maskingLoading,
    stale: maskingStale,
    refetch: refetchMasking,
  } = useApi<ApiMasking>(() => Settings.masking.get<ApiMasking>());
  const {
    data: counts,
    loading: countsLoading,
    stale: countsStale,
    refetch: refetchCounts,
  } = useApi<DashCounts>(() => Dashboard.counts<DashCounts>());
  // The workspace's real publishable key for the snippet (full working key, not
  // the truncated prefix). Null until it loads, or for a legacy key that needs a
  // rotate — the snippet then shows its placeholder rather than a dead key.
  const { data: publicKeyRes } = useApi<{ publicKey: string | null } | null>(
    () => ApiKeys.getPublic<{ publicKey: string | null } | null>(),
  );
  /* Cold load only, per read — the three resolve independently and there is no
     reason to hold the keys table back on the counts. `stale` = the PREVIOUS
     workspace's keys/hosts/counts (keepPreviousData) while the new key resolves;
     `syncing` is excluded so rotating a key or adding a host reconciles under
     the rows already on screen instead of blanking them. */
  const keysBusy = keysLoading || keysStale;
  const hostsBusy = maskingLoading || maskingStale;
  const countsBusy = countsLoading || countsStale;
  const keys = keysBusy
    ? []
    : (keyData ?? []).filter((k) => !k.revokedAt).map(adaptApiKey);
  /* NOT blanked while busy, unlike `keys`: saveHosts PATCHes the whole
     allowedHosts array, so an empty `hosts` is not just an empty render — it is
     the value "Add host" would write, i.e. the allowlist replaced by the one new
     entry. Only the rows below are gated. */
  const hosts = masking?.allowedHosts ?? [];
  const active = (counts?.recordings ?? 0) > 0;
  // Poll counts while waiting for the first event so the banner flips to "active"
  // on its own — no manual refresh. Stops the moment an event lands.
  useEffect(() => {
    if (active) return;
    const id = setInterval(() => refetchCounts(), 5000);
    return () => clearInterval(id);
  }, [active, refetchCounts]);
  // Inject the real key into the current platform's snippet; fall back to the
  // fixture placeholder when the key hasn't loaded (or a legacy key needs a rotate).
  const publicKey = publicKeyRes?.publicKey ?? null;
  const snippetCode =
    publicKey && SNIP[tab] ? fillSnippet(SNIP[tab].code, publicKey) : undefined;

  const keyAction = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast && toast(ok, { kind: "ok" });
      refetchKeys();
    } catch (e) {
      toast &&
        toast(e instanceof Error ? e.message : "Failed", { kind: "err" });
    }
  };
  const saveHosts = async (next: string[]) => {
    try {
      await Settings.masking.set({ allowedHosts: next });
      refetchMasking();
    } catch (e) {
      toast &&
        toast(e instanceof Error ? e.message : "Could not save hosts", {
          kind: "err",
        });
      refetchMasking();
    }
  };

  return (
    <>
      {/* Ahead of the active/waiting fork: `active` is counts-derived, so until
          the counts land it is false — a workspace that has been ingesting for
          months opened Settings to "Waiting for your first event…". */}
      {countsBusy ? (
        <SkInstallBanner />
      ) : active ? (
        <div className="ins-banner ok">
          <span className="ins-banner-ic">
            <span className="ins-banner-dot" />
          </span>
          <div className="ins-banner-txt">
            <b>Replay is active</b>
            <span>
              Last event received {relTime(counts?.lastEventAt)}
              {counts?.lastEventDomain && (
                <>
                  {" "}
                  from <span className="mono">{counts.lastEventDomain}</span>
                </>
              )}
            </span>
          </div>
        </div>
      ) : (
        <div className="ins-banner wait">
          <span className="ins-banner-ic">
            <span className="ins-banner-pulse" />
          </span>
          <div className="ins-banner-txt">
            <b>Waiting for your first event…</b>
            <span>
              Add the snippet below to your app — sessions appear here within
              seconds of the first pageview.
            </span>
          </div>
        </div>
      )}

      <InstallSnippet
        platform={tab}
        onPlatform={setTab}
        code={snippetCode}
        style={{ marginTop: "var(--sp-20)" }}
      />
      <div style={{ marginTop: "var(--sp-10)", fontSize: "var(--text-sm)", color: "var(--t2)" }}>
        Full setup guide, every SDK option, and how to identify users —{" "}
        <a
          href={`https://docs.replayfy.app/${DOC_PATH[tab] ?? "quickstart"}`}
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--accent)", fontWeight: "var(--fw-medium)" }}
        >
          read the docs ↗
        </a>
      </div>

      <div
        className="set-card-h"
        style={{
          padding: 0,
          border: "none",
          marginTop: "var(--sp-28)",
          marginBottom: "var(--sp-10)",
          display: "flex",
          alignItems: "center",
        }}
      >
        <h3 style={{ fontSize: "var(--text-md)", fontWeight: "var(--fw-semibold)" }}>API keys</h3>
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => setGenKey(true)}>
          <Icon name="plus" size={12} /> Generate key
        </button>
      </div>
      <div className="set-card">
        <table style={{ margin: 0 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: "var(--sp-16)" }}>Key</th>
              <th style={{ width: 100 }}>Scope</th>
              <th style={{ width: 100 }}>Created</th>
              <th style={{ width: 100 }}>Last used</th>
              <th style={{ width: 100 }}>Last rotated</th>
              <th style={{ width: 44 }}></th>
            </tr>
          </thead>
          <tbody>
            {keysBusy && <SkKeyRows />}
            {keys.map((k) => (
              <tr key={k.id}>
                <td style={{ paddingLeft: "var(--sp-16)" }}>
                  <div style={{ fontWeight: "var(--fw-semibold)", fontSize: "var(--text-sm)" }}>
                    {k.name}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: "var(--text-xs)", color: "var(--t3)", marginTop: "var(--sp-2)" }}
                  >
                    {k.keyDisplay}
                  </div>
                </td>
                <td>
                  <span
                    className={`tag ${k.scope === "public" ? "info" : k.scope === "server" ? "warn" : ""}`}
                  >
                    {k.scope}
                  </span>
                </td>
                <td style={{ fontSize: "var(--text-xs)", color: "var(--t2)" }}>
                  {k.created}
                </td>
                <td style={{ fontSize: "var(--text-xs)", color: "var(--t2)" }}>
                  {k.lastUsed}
                </td>
                <td style={{ fontSize: "var(--text-xs)", color: "var(--t2)" }}>
                  {k.lastRotated}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <Popover
                    align="right"
                    trigger={
                      <button className="ibtn">
                        <Icon name="more" size={14} />
                      </button>
                    }
                  >
                    {({ close }) => (
                      <>
                        <button
                          onClick={async () => {
                            close();
                            try {
                              const res = await ApiKeys.rotate<{
                                name: string;
                                scope: string;
                                rawKey: string;
                              }>(k.id);
                              setRevealed({
                                name: res.data.name,
                                scope: res.data.scope,
                                rawKey: res.data.rawKey,
                              });
                              toast && toast("Key rotated", { kind: "ok" });
                              refetchKeys();
                            } catch (e) {
                              toast &&
                                toast(
                                  e instanceof Error ? e.message : "Failed",
                                  { kind: "err" },
                                );
                            }
                          }}
                        >
                          <Icon name="refresh" size={14} /> Rotate key
                        </button>
                        <div className="sep" />
                        <button
                          className="danger"
                          onClick={() => {
                            setRevokeTarget({ id: k.id, name: k.name });
                            close();
                          }}
                        >
                          <Icon name="trash" size={14} /> Revoke key
                        </button>
                      </>
                    )}
                  </Popover>
                </td>
              </tr>
            ))}
            {!keysBusy && keys.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  style={{
                    padding: "var(--sp-16)",
                    textAlign: "center",
                    color: "var(--t3)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  No API keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="set-h3" style={{ marginTop: "var(--sp-28)" }}>
        Allowed hosts
      </h3>
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--t2)",
          marginBottom: "var(--sp-10)",
          lineHeight: "var(--lh-normal)",
        }}
      >
        If set, the ingest pipeline only accepts events whose URLs match one of
        these hosts. Use <span className="mono">*.example.com</span> for
        wildcards.
      </div>
      <div className="set-card">
        <table style={{ margin: 0 }}>
          <tbody>
            {hostsBusy && <SkHostRows />}
            {!hostsBusy &&
              hosts.map((h) => (
                <tr key={h}>
                  <td style={{ paddingLeft: "var(--sp-16)" }} className="mono">
                    {h}
                  </td>
                  <td style={{ width: 44 }}>
                    <button
                      className="ibtn"
                      onClick={() => saveHosts(hosts.filter((x) => x !== h))}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            {/* "No hosts allowlisted — all domains accepted." is a claim about
                the ingest filter, so it waits for the read that backs it. */}
            {!hostsBusy && hosts.length === 0 && (
              <tr>
                <td
                  colSpan={2}
                  style={{
                    padding: "var(--sp-16)",
                    textAlign: "center",
                    color: "var(--t3)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  No hosts allowlisted — all domains accepted.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="set-card-add">
          <input
            className="in mono"
            style={{ flex: 1, fontSize: "var(--text-sm)" }}
            placeholder="example.com or *.api.example.com"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            className="btn primary sm"
            onClick={() => {
              const v = draft.trim();
              if (v && !hosts.includes(v)) {
                saveHosts([...hosts, v]);
                setDraft("");
              }
            }}
          >
            <Icon name="plus" size={12} /> Add host
          </button>
        </div>
      </div>
      {genKey && (
        <GenerateKeyModal
          onClose={() => setGenKey(false)}
          onCreated={refetchKeys}
        />
      )}
      {/* Reveal the freshly-rotated key once — same copy-once screen as generate. */}
      {revealed && (
        <GenerateKeyModal preset={revealed} onClose={() => setRevealed(null)} />
      )}
      {/* Destructive-confirm before revoking a key. */}
      {revokeTarget && (
        <Modal
          title="Revoke API key?"
          onClose={() => setRevokeTarget(null)}
          width={440}
          footer={
            <>
              <span className="sp" />
              <button className="btn" onClick={() => setRevokeTarget(null)}>
                Cancel
              </button>
              <button
                className="btn"
                style={{
                  background: "var(--red)",
                  borderColor: "var(--red)",
                  color: "#fff",
                }}
                onClick={() => {
                  const t = revokeTarget;
                  setRevokeTarget(null);
                  keyAction(() => ApiKeys.remove(t.id), "Key revoked");
                }}
              >
                <Icon name="trash" size={13} /> Revoke key
              </button>
            </>
          }
        >
          <p
            style={{
              fontSize: "var(--text-base)",
              color: "var(--t2)",
              lineHeight: "var(--lh-body)",
              margin: "-4px 0 var(--sp-4)",
            }}
          >
            <b style={{ color: "var(--text)" }}>{revokeTarget.name}</b> will stop
            working immediately — any SDK or service still using it will fail to
            send events until you swap in a new key. This can't be undone.
          </p>
        </Modal>
      )}
    </>
  );
}
