/* [icon, label] — signals the AI is warming up on the success screen */
export type Signal = [string, string];

export const SIGNALS: Signal[] = [
  ["warn", "Rage clicks"],
  ["cursor", "Dead clicks"],
  ["funnel", "Checkout regressions"],
  ["phone", "Crash spikes"],
  ["globe", "Slow API requests"],
  ["users", "Retention changes"],
];
