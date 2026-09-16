/* ============================================================================
   useAiMode — the workspace-level Replayfy AI switch.
   Backed by GET/PATCH /v1/settings/ai-mode ({ enabled } → { aiEnabled }).
   Optimistic: the UI flips instantly and reverts (with the server value) only
   if the write fails. While the first read is in flight we default to AI ON so
   the richer surface never flashes in after the fact.
   ========================================================================== */
import { useCallback, useState } from "react";
import { Settings } from "@/api/endpoints";
import { useApi } from "@/api/useApi";

type AiModeResp = { aiEnabled: boolean };

export function useAiMode(): {
  ai: boolean;
  ready: boolean;
  setAi: (on: boolean) => void;
} {
  const { data, refetch } = useApi<AiModeResp>(() =>
    Settings.aiMode.get<AiModeResp>(),
  );
  const [override, setOverride] = useState<boolean | null>(null);
  const ai = override ?? data?.aiEnabled ?? true;

  const setAi = useCallback(
    (on: boolean) => {
      setOverride(on);
      Settings.aiMode
        .set<AiModeResp>({ enabled: on })
        .then(() => refetch())
        .catch(() => {
          // Write failed (offline / no backend): fall back to whatever the server
          // last reported so the control never lies about persisted state.
          setOverride(null);
          refetch();
        });
    },
    [refetch],
  );

  return { ai, ready: data !== undefined, setAi };
}
