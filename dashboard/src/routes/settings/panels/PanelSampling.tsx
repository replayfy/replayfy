import { useEffect, useState } from "react";
import { Toggle } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Settings } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { SetRow } from "./SetRow";
import { csvToList, listToCsv, type ApiSampling } from "../settings.data";

/* Panel: Sampling — wired to GET/PATCH /v1/settings/sampling. samplingRate is a
   0..1 fraction on the backend (shown as 0-100%); the slider keeps a local echo
   and commits once on release so a drag fires one PATCH, not one per step. The
   two override toggles PATCH on change; the URL globs commit on blur. */
export function PanelSampling() {
  const { data, refetch } = useApi<ApiSampling>(() =>
    Settings.sampling.get<ApiSampling>(),
  );
  const toast = useToast();
  const serverRate = Math.round((data?.samplingRate ?? 1) * 100);
  const errAll = data?.alwaysRecordErrors ?? true;
  const idAll = data?.alwaysRecordIdentified ?? false;
  const serverUrls = listToCsv(data?.alwaysRecordOnUrls);

  const [rate, setRate] = useState(serverRate);
  const [urls, setUrls] = useState(serverUrls);
  useEffect(() => {
    setRate(serverRate);
  }, [serverRate]);
  useEffect(() => {
    setUrls(serverUrls);
  }, [serverUrls]);

  const save = async (patch: Partial<ApiSampling>) => {
    try {
      await Settings.sampling.set(patch);
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

  return (
    <>
      <SetRow
        label="Sample rate"
        help="The percentage of sessions to record. 100% records every session."
      >
        <div
          style={{
            display: "flex",
            gap: "var(--sp-12)",
            alignItems: "center",
            minWidth: 320,
          }}
        >
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            onMouseUp={() => {
              if (rate !== serverRate) save({ samplingRate: rate / 100 });
            }}
            onKeyUp={() => {
              if (rate !== serverRate) save({ samplingRate: rate / 100 });
            }}
            onTouchEnd={() => {
              if (rate !== serverRate) save({ samplingRate: rate / 100 });
            }}
            className="range"
            style={{ flex: 1 }}
          />
          <span
            className="mono"
            style={{ minWidth: 46, textAlign: "right", fontWeight: "var(--fw-semibold)" }}
          >
            {rate}%
          </span>
        </div>
      </SetRow>
      <SetRow
        label="Always record sessions with errors"
        help="Override the sample rate if any captured error fires during the session."
      >
        <Toggle on={errAll} onChange={(v) => save({ alwaysRecordErrors: v })} />
      </SetRow>
      <SetRow
        label="Always record identified users"
        help="Override the sample rate once the user is identified (e.g., logged in)."
      >
        <Toggle
          on={idAll}
          onChange={(v) => save({ alwaysRecordIdentified: v })}
        />
      </SetRow>
      <SetRow
        label="Always record on these URLs"
        help="Recording is forced for matching URLs regardless of sample rate. Comma-separated globs (/checkout/**)."
      >
        <input
          className="in mono"
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          onBlur={() => {
            if (urls !== serverUrls)
              save({ alwaysRecordOnUrls: csvToList(urls) });
          }}
          placeholder="/checkout/**, /onboarding/**"
          style={{ width: 320, fontSize: "var(--text-sm)" }}
        />
      </SetRow>
    </>
  );
}
