import { useSyncExternalStore } from "react";

/**
 * Decoupled hover bus linking the timeline markers (RvStage) and the Events
 * list (EventsPanel) as ONE system, without lifting transient UI state into
 * Recordings.tsx (which is prop-drilled and heavily owned). The value is a
 * source event's `offsetMs` — the shared key both a tick and a row already
 * carry — or null when nothing is hovered.
 *
 * A module store (not context) on purpose: the two consumers live in different
 * subtrees, the state is ephemeral and hover-frequency, and this keeps the
 * wiring out of the render-critical parent entirely.
 */
let current: number | null = null;
const listeners = new Set<() => void>();

export function setHoverKey(key: number | null): void {
  if (current === key) return;
  current = key;
  for (const l of listeners) l();
}

export function useHoverKey(): number | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        // When the last consumer unmounts (leaving the player), drop the
        // hovered key so a stale offsetMs can't briefly light up a matching
        // tick/row when the next recording mounts.
        if (listeners.size === 0) current = null;
      };
    },
    () => current,
    () => current,
  );
}
