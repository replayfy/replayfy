import { type CSSProperties } from "react";
import { Select, Toggle } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Settings } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { SetRow } from "./SetRow";
import {
  RETENTION_DAY_TO_LABEL,
  RETENTION_LABEL_TO_DAY,
  EXTEND_CODE_TO_LABEL,
  EXTEND_LABEL_TO_CODE,
  fmtBytes,
  type ApiRetention,
} from "../settings.data";

/* Panel: Retention — wired to GET/PATCH /v1/settings/retention. The day count
   and bookmark-extension code map to/from the design's human labels; the storage
   meter renders real storageUsedBytes / storageQuotaBytes from the same read. */
export function PanelRetention() {
  const { data, refetch } = useApi<ApiRetention>(() =>
    Settings.retention.get<ApiRetention>(),
  );
  const toast = useToast();
  const retentionDays =
    RETENTION_DAY_TO_LABEL[data?.retentionDays ?? 30] ?? "30 days";
  // Default an unset extension to +30 days, not "Never expire": on a 30-day plan
  // "never" reads as forever, which the plan cap forbids — 30 days is the honest
  // default that also matches the plan ceiling.
  const extend =
    EXTEND_CODE_TO_LABEL[data?.extendBookmarked ?? "30d"] ?? "+30 days";
  const keepErrors = data?.keepErrorsLonger ?? true;
  // The plan ceiling caps BOTH selects below. Stating it in the help text beats
  // only revealing it in the rejection toast after someone picks "Never expire"
  // on a 30-day plan.
  const maxDays = data?.maxRetentionDays ?? null;
  const capNote =
    maxDays == null ? "" : ` Your plan allows up to ${maxDays} days.`;
  const used = data?.storageUsedBytes ?? 0;
  const quota = data?.storageQuotaBytes ?? 0;
  const usedPctExact = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  // Never let real (but tiny) usage render as an empty bar — floor the fill to a
  // visible sliver whenever there is any usage.
  const barPct = used > 0 ? Math.max(usedPctExact, 2) : 0;

  const save = async (patch: Partial<ApiRetention>) => {
    try {
      await Settings.retention.set(patch);
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
        label="Default retention period"
        help={`All new recordings will be kept this long, then permanently deleted.${capNote}`}
      >
        <Select
          value={retentionDays}
          label="Keep recordings for"
          options={[
            "7 days",
            "14 days",
            "30 days",
            "90 days",
            "180 days",
            "1 year",
          ]}
          onChange={(v) =>
            save({ retentionDays: RETENTION_LABEL_TO_DAY[v] ?? 30 })
          }
          width={130}
        />
      </SetRow>
      <SetRow
        label="Extend bookmarked recordings"
        help={`Bookmarked or playlisted sessions are kept beyond the default retention.${
          maxDays == null
            ? ""
            : ` The default plus this extension still can't exceed your plan's ${maxDays} days.`
        }`}
      >
        <Select
          value={extend}
          label="Extend retention"
          options={["Never expire", "+30 days", "+90 days", "+1 year"]}
          onChange={(v) =>
            save({ extendBookmarked: EXTEND_LABEL_TO_CODE[v] ?? "never" })
          }
          width={140}
        />
      </SetRow>
      <SetRow
        label="Keep sessions with errors longer"
        help="Sessions with ≥1 captured error are kept 2× as long as normal sessions."
      >
        <Toggle
          on={keepErrors}
          onChange={(v) => save({ keepErrorsLonger: v })}
        />
      </SetRow>
      <div className="set-card" style={{ padding: "var(--sp-18)", marginTop: "var(--sp-24)" }}>
        <div className="set-sec-t" style={{ margin: 0 }}>
          Storage used
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "var(--sp-8)",
            marginTop: "var(--sp-10)",
          }}
        >
          <span
            style={{ fontSize: "var(--text-2xl)", fontWeight: "var(--fw-bold)", fontFamily: "var(--mono)" }}
          >
            {fmtBytes(used)}
          </span>
          <span style={{ fontSize: "var(--text-base)", color: "var(--t2)" }}>
            of {fmtBytes(quota)}
          </span>
        </div>
        {/* Ticked / equalizer meter — same construction as the billing usage
            bars: a neutral tick track with the fill re-drawn in the row hue
            (amber once storage runs high), clipped to the used share. */}
        <div
          className="blt-bar"
          style={
            {
              marginTop: "var(--sp-12)",
              "--c": usedPctExact > 80 ? "var(--amber)" : "var(--accent)",
            } as CSSProperties
          }
        >
          <span className="blt-fill" style={{ width: barPct + "%" }} />
        </div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--t2)", marginTop: "var(--sp-10)" }}>
          {used > 0 && usedPctExact < 1 ? "<1" : Math.round(usedPctExact)}% used
          · {retentionDays} default retention
        </div>
      </div>
    </>
  );
}
