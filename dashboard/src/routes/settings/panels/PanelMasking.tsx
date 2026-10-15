import { useEffect, useState } from "react";
import { Icon, Popover, Select, Toggle } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Settings } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { SetRow, SecTitle } from "./SetRow";
import {
  MASK_TEMPLATES,
  MASKING_COPY,
  MASKING_FALLBACK,
  coverParamValue,
  isValidSelector,
  isValidUrlPattern,
  selectorIssue,
  urlPatternIssue,
  maskingToRules,
  rulesToSelectors,
  csvToList,
  listToCsv,
  type ApiMasking,
  type MaskRule,
} from "../settings.data";

/* Panel: Privacy & masking — wired to GET/PATCH /v1/settings/masking. The two
   selector arrays (block/mask) are flattened into the design's rule rows and
   split back on save; URL patterns, the CC/query toggles and the allowed-params
   list all map 1:1 to the masking config.

   Every write is derived from what is rendered (saveRules sends the WHOLE rule
   list), so nothing may be written until `data` is this workspace's own and
   current: while it loads or fails the panel shows MASKING_FALLBACK, right
   after a workspace switch it shows the previous workspace's config
   (`stale`), after a failed refetch it may be out of date (`error`), and from
   a save until the refetch it triggers has landed it is the list as it was
   BEFORE that save (`saving`), so a second edit would undo the first.
   `locked` disables the controls and every write handler refuses on its own
   as well. */
export function PanelMasking() {
  const { data, stale, syncing, error, refetch } = useApi<ApiMasking>(() =>
    Settings.masking.get<ApiMasking>(),
  );
  /* "write" while the PATCH is in flight, then "sync" until the refetch it
     starts is no longer running (`syncing` is the query's own fetch flag). */
  const [saving, setSaving] = useState<"write" | "sync" | null>(null);
  useEffect(() => {
    if (saving === "sync" && !syncing) setSaving(null);
  }, [saving, syncing]);
  const m = data ?? MASKING_FALLBACK;
  const locked = data == null || stale || error != null || saving !== null;
  /* .ibtn has no :disabled rule; dim it like .btn:disabled while locked. */
  const lockedIbtn = locked ? { opacity: 0.5, cursor: "not-allowed" } : undefined;
  const toast = useToast();
  const rules = maskingToRules(m);
  const urls = m.redactUrlPatterns ?? [];
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState("block");
  const [urlDraft, setUrlDraft] = useState("");
  const [ruleErr, setRuleErr] = useState<string | null>(null);
  const [urlErr, setUrlErr] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(listToCsv(m.allowedQueryParams));
  useEffect(() => {
    setAllowed(listToCsv(m.allowedQueryParams));
  }, [m.allowedQueryParams]);

  const save = async (patch: Partial<ApiMasking>) => {
    if (locked) return;
    setSaving("write");
    try {
      await Settings.masking.set(patch);
      toast && toast("Saved", { kind: "ok" });
    } catch (e) {
      toast &&
        toast(e instanceof Error ? e.message : "Could not save", {
          kind: "err",
        });
    }
    refetch();
    setSaving("sync");
  };
  /* Selectors are checked in this browser before they are saved, and syntax
     only newer browsers parse is refused too (see selectorIssue): one bad
     rule can switch off every other rule of its mode on the recorder. A save
     that only REMOVES rows always goes through, so a bad rule stored before
     this check can still be cleared. Returns whether the save was sent. */
  const saveRules = (next: MaskRule[], added?: string): boolean => {
    if (locked) return false;
    const removalOnly =
      added === undefined && next.every((r) => rules.includes(r));
    if (!removalOnly && next.some((r) => !isValidSelector(r.s))) {
      const issue = added === undefined ? null : selectorIssue(added);
      setRuleErr(
        issue === "invalid"
          ? MASKING_COPY.invalidDraft
          : issue === "newSyntax"
            ? MASKING_COPY.newSelectorDraft
            : MASKING_COPY.invalidRulesBlock,
      );
      return false;
    }
    setRuleErr(null);
    void save(rulesToSelectors(next));
    return true;
  };
  /* Same rule for URL patterns: the web SDK compiles each one as a RegExp.
     Removals always go through (save() still refuses while locked). An add
     is checked as typed, then a trailing "key=" is extended through its value
     (coverParamValue); a pattern already listed is not added again. */
  const saveUrls = (next: string[]) => {
    setUrlErr(null);
    void save({ redactUrlPatterns: next });
  };
  const addUrl = (raw: string): boolean => {
    if (locked) return false;
    const issue = urlPatternIssue(raw);
    if (issue || urls.some((p) => !isValidUrlPattern(p))) {
      setUrlErr(
        issue === "invalid"
          ? MASKING_COPY.invalidDraftPattern
          : issue === "newSyntax"
            ? MASKING_COPY.newPatternDraft
            : MASKING_COPY.invalidPatternsBlock,
      );
      return false;
    }
    const p = coverParamValue(raw);
    if (!urls.includes(p)) saveUrls([...urls, p]);
    return true;
  };

  return (
    <>
      {error && (
        <div className="ai-key-msg err" role="alert">
          <Icon name="warn" size={12} /> {MASKING_COPY.loadError}
          <button type="button" className="bl-portal-link" onClick={refetch}>
            Retry
          </button>
        </div>
      )}
      <SetRow
        label={MASKING_COPY.maskInputsLabel}
        help={MASKING_COPY.maskInputsHelp.map((p, i) => (
          <span
            key={i}
            style={{ display: "block", marginTop: i ? "var(--sp-6)" : 0 }}
          >
            {p}
          </span>
        ))}
      >
        <Toggle
          on={m.maskAllInputs}
          disabled={locked}
          onChange={(v) => save({ maskAllInputs: v })}
        />
      </SetRow>
      <div className="set-card">
        <div className="set-card-h">
          <h3>Active rules</h3>
          <span style={{ flex: 1 }} />
          <Popover
            align="right"
            trigger={
              <button className="btn sm" disabled={locked}>
                <Icon name="plus" size={12} /> Add from template
              </button>
            }
          >
            {({ close }) =>
              MASK_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  disabled={locked}
                  onClick={() => {
                    if (t.kind === "url") addUrl(t.pattern!);
                    else if (!rules.find((x) => x.s === t.selector))
                      saveRules(
                        [...rules, { s: t.selector!, m: t.mode! }],
                        t.selector!,
                      );
                    close();
                  }}
                >
                  <Icon
                    name={t.kind === "url" ? "console" : "settings"}
                    size={14}
                  />
                  {t.label}
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: "var(--text-2xs)",
                      color: "var(--t3)",
                      fontFamily: "var(--mono)",
                    }}
                  >
                    {t.kind === "url" ? "URL" : t.mode}
                  </span>
                </button>
              ))
            }
          </Popover>
        </div>
        <table style={{ margin: 0 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: "var(--sp-16)" }}>CSS selector</th>
              <th style={{ width: 110 }}>Mode</th>
              <th style={{ width: 44 }}></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={i}>
                <td style={{ paddingLeft: "var(--sp-16)" }} className="mono">
                  {r.s}
                  {!isValidSelector(r.s) && (
                    <div
                      className="ai-key-msg err"
                      style={{ fontFamily: "var(--font)" }}
                    >
                      <Icon name="warn" size={12} />{" "}
                      {(selectorIssue(r.s) === "newSyntax"
                        ? MASKING_COPY.newSelectorRule
                        : MASKING_COPY.invalidRule)(
                        r.m === "block" ? "block" : "mask",
                      )}
                    </div>
                  )}
                </td>
                <td>
                  <span className={`tag ${r.m === "block" ? "err" : "warn"}`}>
                    {r.m}
                  </span>
                </td>
                <td>
                  <button
                    className="ibtn"
                    disabled={locked}
                    style={lockedIbtn}
                    onClick={() => saveRules(rules.filter((_, x) => x !== i))}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
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
                  No rules yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="set-card-add">
          <input
            className={`in mono${ruleErr ? " in-err" : ""}`}
            style={{ flex: 1, fontSize: "var(--text-sm)" }}
            placeholder='[data-private], .secret, input[name="card"]'
            value={draft}
            disabled={locked}
            aria-invalid={ruleErr ? true : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setRuleErr(null);
            }}
          />
          <Select
            value={mode}
            options={["block", "mask"]}
            onChange={setMode}
            width={90}
          />
          <button
            className="btn primary sm"
            disabled={locked}
            onClick={() => {
              const s = draft.trim();
              if (s && saveRules([...rules, { s, m: mode }], s)) setDraft("");
            }}
          >
            Add
          </button>
        </div>
        {ruleErr && (
          <div
            className="ai-key-msg err"
            role="alert"
            style={{ padding: "0 var(--sp-14) var(--sp-14)" }}
          >
            <Icon name="warn" size={12} /> {ruleErr}
          </div>
        )}
      </div>
      <div className="set-card">
        <div className="set-card-h">
          <h3>Redact URL patterns</h3>
        </div>
        <table style={{ margin: 0 }}>
          <tbody>
            {urls.map((p, i) => (
              <tr key={i}>
                <td style={{ paddingLeft: "var(--sp-16)" }} className="mono">
                  {p}
                  {!isValidUrlPattern(p) && (
                    <div
                      className="ai-key-msg err"
                      style={{ fontFamily: "var(--font)" }}
                    >
                      <Icon name="warn" size={12} />{" "}
                      {urlPatternIssue(p) === "newSyntax"
                        ? MASKING_COPY.newPattern
                        : MASKING_COPY.invalidPattern}
                    </div>
                  )}
                </td>
                <td style={{ width: 44 }}>
                  <button
                    className="ibtn"
                    disabled={locked}
                    style={lockedIbtn}
                    onClick={() => saveUrls(urls.filter((_, x) => x !== i))}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </td>
              </tr>
            ))}
            {urls.length === 0 && (
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
                  No URL patterns set.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="set-card-add">
          <input
            className={`in mono${urlErr ? " in-err" : ""}`}
            style={{ flex: 1, fontSize: "var(--text-sm)" }}
            placeholder="email=, phone=, /reset/[^/?#]+"
            value={urlDraft}
            disabled={locked}
            aria-invalid={urlErr ? true : undefined}
            onChange={(e) => {
              setUrlDraft(e.target.value);
              setUrlErr(null);
            }}
          />
          <button
            className="btn primary sm"
            disabled={locked}
            onClick={() => {
              const p = urlDraft.trim();
              if (p && addUrl(p)) setUrlDraft("");
            }}
          >
            Add
          </button>
        </div>
        {urlErr && (
          <div
            className="ai-key-msg err"
            role="alert"
            style={{ padding: "0 var(--sp-14) var(--sp-14)" }}
          >
            <Icon name="warn" size={12} /> {urlErr}
          </div>
        )}
        <div
          className="set-help"
          style={{
            maxWidth: "none",
            margin: 0,
            padding: "0 var(--sp-14) var(--sp-14)",
          }}
        >
          {MASKING_COPY.urlPatternsHelp}
        </div>
      </div>
      <SecTitle>Global defaults</SecTitle>
      <SetRow
        label="Block credit-card-like text"
        help={MASKING_COPY.cardTextHelp}
      >
        <Toggle
          on={m.blockCreditCardText}
          disabled={locked}
          onChange={(v) => save({ blockCreditCardText: v })}
        />
      </SetRow>
      <SetRow
        label="Strip query params from URLs"
        help={MASKING_COPY.stripQueryHelp}
      >
        <Toggle
          on={m.stripQueryParams}
          disabled={locked}
          onChange={(v) => save({ stripQueryParams: v })}
        />
      </SetRow>
      <SetRow
        label="Allowed query params"
        help={MASKING_COPY.allowedParamsHelp}
      >
        <input
          className="in mono"
          style={{ width: 280, fontSize: "var(--text-sm)" }}
          value={allowed}
          disabled={locked}
          onChange={(e) => setAllowed(e.target.value)}
          onBlur={() => {
            if (allowed !== listToCsv(m.allowedQueryParams))
              save({ allowedQueryParams: csvToList(allowed) });
          }}
        />
      </SetRow>
    </>
  );
}
