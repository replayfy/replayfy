import { useEffect, useState } from "react";
import { Icon, Popover, Select, Toggle } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Settings } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { SetRow, SecTitle } from "./SetRow";
import {
  MASK_TEMPLATES,
  MASKING_FALLBACK,
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
   list all map 1:1 to the masking config. */
export function PanelMasking() {
  const { data, refetch } = useApi<ApiMasking>(() =>
    Settings.masking.get<ApiMasking>(),
  );
  const m = data ?? MASKING_FALLBACK;
  const toast = useToast();
  const rules = maskingToRules(m);
  const urls = m.redactUrlPatterns ?? [];
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState("block");
  const [urlDraft, setUrlDraft] = useState("");
  const [allowed, setAllowed] = useState(listToCsv(m.allowedQueryParams));
  useEffect(() => {
    setAllowed(listToCsv(m.allowedQueryParams));
  }, [m.allowedQueryParams]);

  const save = async (patch: Partial<ApiMasking>) => {
    try {
      await Settings.masking.set(patch);
      toast && toast("Saved", { kind: "ok" });
      refetch();
    } catch (e) {
      toast &&
        toast(e instanceof Error ? e.message : "Could not save", {
          kind: "err",
        });
      refetch();
    }
  };
  const saveRules = (next: MaskRule[]) => save(rulesToSelectors(next));

  return (
    <>
      <SetRow
        label="Mask all <input> values by default"
        help="Recommended. Individual inputs can be allowlisted later."
      >
        <Toggle
          on={m.maskAllInputs}
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
              <button className="btn sm">
                <Icon name="plus" size={12} /> Add from template
              </button>
            }
          >
            {({ close }) =>
              MASK_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    if (t.kind === "url") {
                      if (!urls.includes(t.pattern!))
                        save({ redactUrlPatterns: [...urls, t.pattern!] });
                    } else if (!rules.find((x) => x.s === t.selector))
                      saveRules([...rules, { s: t.selector!, m: t.mode! }]);
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
                </td>
                <td>
                  <span className={`tag ${r.m === "block" ? "err" : "warn"}`}>
                    {r.m}
                  </span>
                </td>
                <td>
                  <button
                    className="ibtn"
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
            className="in mono"
            style={{ flex: 1, fontSize: "var(--text-sm)" }}
            placeholder='[data-private], .secret, input[name="card"]'
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Select
            value={mode}
            options={["block", "mask"]}
            onChange={setMode}
            width={90}
          />
          <button
            className="btn primary sm"
            onClick={() => {
              if (draft.trim()) {
                saveRules([...rules, { s: draft.trim(), m: mode }]);
                setDraft("");
              }
            }}
          >
            Add
          </button>
        </div>
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
                </td>
                <td style={{ width: 44 }}>
                  <button
                    className="ibtn"
                    onClick={() =>
                      save({
                        redactUrlPatterns: urls.filter((_, x) => x !== i),
                      })
                    }
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
            className="in mono"
            style={{ flex: 1, fontSize: "var(--text-sm)" }}
            placeholder="token=, auth=, /api/secret/"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
          />
          <button
            className="btn primary sm"
            onClick={() => {
              if (urlDraft.trim()) {
                save({ redactUrlPatterns: [...urls, urlDraft.trim()] });
                setUrlDraft("");
              }
            }}
          >
            Add
          </button>
        </div>
      </div>
      <SecTitle>Global defaults</SecTitle>
      <SetRow
        label="Block credit-card-like text"
        help="Regex-detects and blocks anything that looks like a credit-card number even outside form fields."
      >
        <Toggle
          on={m.blockCreditCardText}
          onChange={(v) => save({ blockCreditCardText: v })}
        />
      </SetRow>
      <SetRow
        label="Strip query params from URLs"
        help="Useful when query strings contain tokens or PII. Path is still captured."
      >
        <Toggle
          on={m.stripQueryParams}
          onChange={(v) => save({ stripQueryParams: v })}
        />
      </SetRow>
      <SetRow
        label="Allowed query params"
        help="Comma-separated. These will be kept; everything else is stripped."
      >
        <input
          className="in mono"
          style={{ width: 280, fontSize: "var(--text-sm)" }}
          value={allowed}
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
