import { describe, expect, it } from "vitest";

import { initialDemoState } from "../src/shared/demo-state.js";
import {
  prependBoundedEvent,
  type DemoEvent,
} from "../src/renderer/event-log.js";
import { readWindowRole } from "../src/renderer/role.js";

function event(sequence: number): DemoEvent {
  return {
    sequence,
    type: "State change",
    timestamp: "12:00:00",
    revision: sequence,
    pendingMutations: 0,
    status: "synced",
    state: { ...initialDemoState, profile: { ...initialDemoState.profile } },
  };
}

describe("demo helpers", () => {
  it("routes known window roles and defaults invalid roles to Controller", () => {
    expect(readWindowRole("?view=observer")).toBe("observer");
    expect(readWindowRole("?view=inspector")).toBe("inspector");
    expect(readWindowRole("?view=unknown")).toBe("controller");
    expect(readWindowRole("")).toBe("controller");
  });

  it("keeps the newest synchronization events within the configured limit", () => {
    let events: DemoEvent[] = [];
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      events = prependBoundedEvent(events, event(sequence), 3);
    }

    expect(events.map((entry) => entry.sequence)).toEqual([5, 4, 3]);
  });

  it("uses the documented initial shared state", () => {
    expect(initialDemoState).toEqual({
      counter: 0,
      profile: { name: "Anish", status: "online" },
      theme: "dark",
      lastUpdatedBy: null,
    });
  });
});
