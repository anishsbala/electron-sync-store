import type { DemoState } from "../shared/demo-state.js";

export interface DemoEvent {
  sequence: number;
  type: "State change" | "Sync change";
  timestamp: string;
  revision: number | null;
  pendingMutations: number;
  status: string;
  state: DemoState;
}

export function prependBoundedEvent(
  events: readonly DemoEvent[],
  event: DemoEvent,
  limit = 100,
): DemoEvent[] {
  return [event, ...events].slice(0, limit);
}
