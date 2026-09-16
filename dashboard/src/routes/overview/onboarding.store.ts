/* Workspace-scoped persistence for the onboarding checklist: the simulated
   SDK detection (stubbed until a real first-event signal exists), the
   skip/dismiss flags, and the last-celebrated step set (so the hero cat only
   celebrates each completion once). localStorage only — no backend. */

const key = (ws: number | null, name: string) => `rf-onb:${ws ?? "anon"}:${name}`;

export const onbStore = {
  get(ws: number | null, name: string): string | null {
    try {
      return localStorage.getItem(key(ws, name));
    } catch {
      return null;
    }
  },
  set(ws: number | null, name: string, value: string) {
    try {
      localStorage.setItem(key(ws, name), value);
    } catch {
      /* private mode — degrade to session-only behaviour */
    }
  },
  remove(ws: number | null, name: string) {
    try {
      localStorage.removeItem(key(ws, name));
    } catch {
      /* ignore */
    }
  },
  /** `?onb=reset` — wipe every onboarding flag for this workspace. */
  reset(ws: number | null) {
    ["sim-sdk", "install-opened", "skipped", "dismissed", "seen"].forEach((n) =>
      onbStore.remove(ws, n),
    );
  },
};

export const ONB_STEP_KEYS = [
  "sdk",
  "funnel",
  "cohort",
  "team",
  "integration",
] as const;
export type OnbStepKey = (typeof ONB_STEP_KEYS)[number];
