import { useEffect, useState } from "react";
import { Select, Toggle } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Settings } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { SetRow, SecTitle } from "./SetRow";
import { RECORDING_FALLBACK, type ApiRecording } from "../settings.data";

/* Panel: Recording — wired to GET/PATCH /v1/settings/recording. Each control
   reads from the live config; changing one PATCHes just that key then refetches
   (VIEWER PATCH → 403, surfaced via toast and the value reverts on refetch).
   Toggles/selects PATCH on change; number inputs keep a local echo and commit
   on blur so typing "15" doesn't fire a write per keystroke. */
export function PanelRecording() {
  const { data, refetch } = useApi<ApiRecording>(() =>
    Settings.recording.get<ApiRecording>(),
  );
  const o = data ?? RECORDING_FALLBACK;
  const toast = useToast();
  const set = async (
    k: keyof ApiRecording,
    v: ApiRecording[keyof ApiRecording],
  ) => {
    try {
      await Settings.recording.set({ [k]: v });
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
  const [fps, setFps] = useState(o.mobileFps);
  const [minDur, setMinDur] = useState(o.minDurationSeconds);
  useEffect(() => {
    setFps(o.mobileFps);
  }, [o.mobileFps]);
  useEffect(() => {
    setMinDur(o.minDurationSeconds);
  }, [o.minDurationSeconds]);
  return (
    <>
      <SecTitle>What to capture</SecTitle>
      <SetRow
        label="Record canvas elements"
        help="Includes <canvas> contents (charts, drawing tools, video frames). Increases recording size 5–10×."
      >
        <Toggle on={o.recordCanvas} onChange={(v) => set("recordCanvas", v)} />
      </SetRow>
      <SetRow
        label="Record cross-origin iframes"
        help="Requires Replay snippet to be installed in the iframe origin as well."
      >
        <Toggle
          on={o.recordCrossOriginIframes}
          onChange={(v) => set("recordCrossOriginIframes", v)}
        />
      </SetRow>
      <SetRow
        label="Autoplay next recording"
        help="When a session ends, automatically start the next one in the current view or playlist."
      >
        <Toggle
          on={o.autoplayNextRecording}
          onChange={(v) => set("autoplayNextRecording", v)}
        />
      </SetRow>
      <SecTitle>Network</SecTitle>
      <SetRow
        label="Capture network requests"
        help="XHR + fetch with method, status, timing, and (optionally) bodies. Authorization values are always stripped."
      >
        <Toggle
          on={o.captureNetwork}
          onChange={(v) => set("captureNetwork", v)}
        />
      </SetRow>
      <SetRow
        label="Capture request / response headers"
        help="Sensitive; off by default. Authorization, cookies, and tokens are server-side redacted before save."
      >
        <Toggle
          on={o.captureNetworkHeaders}
          onChange={(v) => set("captureNetworkHeaders", v)}
        />
      </SetRow>
      <SetRow
        label="Capture request / response bodies"
        help="JSON bodies up to 8KB. Keys named password / token / secret are redacted automatically."
      >
        <Toggle
          on={o.captureNetworkBodies}
          onChange={(v) => set("captureNetworkBodies", v)}
        />
      </SetRow>
      <SecTitle>Console &amp; errors</SecTitle>
      <SetRow
        label="Capture console logs"
        help="console.log, info, warn, error, and uncaught exceptions."
      >
        <Toggle
          on={o.captureConsole}
          onChange={(v) => set("captureConsole", v)}
        />
      </SetRow>
      <SetRow
        label="Capture performance metrics"
        help="Core Web Vitals (LCP, CLS, FID), memory pressure, long tasks."
      >
        <Toggle
          on={o.capturePerformance}
          onChange={(v) => set("capturePerformance", v)}
        />
      </SetRow>
      <SetRow
        label="Capture errors"
        help="Uncaught exceptions and unhandled promise rejections."
      >
        <Toggle
          on={o.captureErrors}
          onChange={(v) => set("captureErrors", v)}
        />
      </SetRow>
      <SecTitle>Mobile capture</SecTitle>
      <SetRow
        label="Screenshot frame rate (fps)"
        help="Frames per second for native (iOS / Android) session screenshots. Higher is smoother but larger."
      >
        <input
          type="number"
          min={1}
          max={30}
          className="num-in"
          value={fps}
          onChange={(e) =>
            setFps(Math.min(30, Math.max(1, Number(e.target.value) || 1)))
          }
          onBlur={() => {
            if (fps !== o.mobileFps) set("mobileFps", fps);
          }}
        />
      </SetRow>
      <SetRow
        label="Screenshot quality"
        help="JPEG quality tier for native screenshots. Higher is sharper but larger."
      >
        <Select
          value={o.mobileQuality}
          label="Screenshot quality"
          options={[
            { value: "low", label: "Low" },
            { value: "standard", label: "Standard" },
            { value: "high", label: "High" },
          ]}
          onChange={(v) => set("mobileQuality", v)}
          width={140}
        />
      </SetRow>
      <SecTitle>When to record</SecTitle>
      <SetRow
        label="Recording trigger"
        help="When to start capturing a session."
      >
        <Select
          value={o.recordingTrigger}
          label="Start recording"
          options={[
            { value: "always", label: "On every page load" },
            { value: "identified", label: "Only after identify() runs" },
            { value: "sample", label: "Random sampling (Sampling tab)" },
          ]}
          onChange={(v) => set("recordingTrigger", v)}
          width={250}
        />
      </SetRow>
      <SetRow
        label="Minimum session duration"
        help="Drop sessions shorter than this (seconds) before storing. Useful for filtering bots."
      >
        <input
          type="number"
          min={0}
          max={120}
          className="num-in"
          value={minDur}
          onChange={(e) => setMinDur(Number(e.target.value))}
          onBlur={() => {
            if (minDur !== o.minDurationSeconds)
              set("minDurationSeconds", minDur);
          }}
        />
      </SetRow>
    </>
  );
}
