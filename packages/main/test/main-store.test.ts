import type { MutationRequest } from "@electron-sync-store/core";
import { PROTOCOL_VERSION } from "@electron-sync-store/core";
import { describe, expect, it, vi } from "vitest";

import { createMainStore } from "../src/index.js";

interface AppState {
  counter: number;
  label: string;
  profile: {
    name: string;
  };
}

let nextMutationNumber = 0;

function createAppStore() {
  return createMainStore<AppState>("app", {
    counter: 0,
    label: "initial",
    profile: { name: "Ada" },
  });
}

function createMutation(
  store: ReturnType<typeof createAppStore>,
  patch: Partial<AppState>,
  overrides: Partial<MutationRequest<AppState>> = {},
): MutationRequest<AppState> {
  nextMutationNumber += 1;
  return {
    protocolVersion: PROTOCOL_VERSION,
    storeId: "app",
    serverEpoch: store.getServerEpoch(),
    clientId: "renderer-a",
    mutationId: `mutation-${nextMutationNumber}`,
    baseRevision: store.getRevision(),
    patch,
    ...overrides,
  };
}

describe("createMainStore", () => {
  it("creates a non-empty unique epoch for each store lifetime", () => {
    const first = createAppStore();
    const second = createAppStore();

    expect(first.getServerEpoch()).not.toBe("");
    expect(second.getServerEpoch()).not.toBe(first.getServerEpoch());
  });

  it("starts at revision zero with an initial snapshot", () => {
    const store = createAppStore();

    expect(store.getRevision()).toBe(0);
    expect(store.getSnapshot()).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      serverEpoch: store.getServerEpoch(),
      revision: 0,
      state: {
        counter: 0,
        label: "initial",
        profile: { name: "Ada" },
      },
    });
  });

  it("assigns consecutive canonical revisions to renderer mutations", () => {
    const store = createAppStore();
    const first = store.handleMutation(createMutation(store, { counter: 1 }));
    const second = store.handleMutation(createMutation(store, { label: "updated" }));

    expect(first).toMatchObject({ type: "commit", revision: 1 });
    expect(second).toMatchObject({ type: "commit", revision: 2 });
    expect(store.getRevision()).toBe(2);
  });

  it("creates commits with source, epoch, mutation ID, and patch", () => {
    const store = createAppStore();
    const request = createMutation(store, { counter: 5 });
    const result = store.handleMutation(request);

    expect(result).toEqual({
      type: "commit",
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      serverEpoch: store.getServerEpoch(),
      sourceClientId: "renderer-a",
      mutationId: request.mutationId,
      revision: 1,
      patch: { counter: 5 },
    });
  });

  it("uses shallow patch semantics and preserves untouched references", () => {
    const store = createAppStore();
    const profile = store.getState().profile;

    store.handleMutation(createMutation(store, { counter: 3 }));

    expect(store.getState()).toEqual({
      counter: 3,
      label: "initial",
      profile: { name: "Ada" },
    });
    expect(store.getState().profile).toBe(profile);
  });

  it("composes different-key patches in processing order", () => {
    const store = createAppStore();

    store.handleMutation(createMutation(store, { counter: 2 }));
    store.handleMutation(createMutation(store, { label: "second" }));

    expect(store.getState()).toMatchObject({ counter: 2, label: "second" });
  });

  it("uses last-commit-wins for same-key patches", () => {
    const store = createAppStore();

    store.handleMutation(createMutation(store, { counter: 5 }));
    store.handleMutation(createMutation(store, { counter: 9 }));

    expect(store.getState().counter).toBe(9);
    expect(store.getRevision()).toBe(2);
  });

  it("accepts a stale informational base revision", () => {
    const store = createAppStore();
    store.handleMutation(createMutation(store, { counter: 1 }));
    const result = store.handleMutation(
      createMutation(store, { label: "from-stale-base" }, { baseRevision: 0 }),
    );

    expect(result).toMatchObject({ type: "commit", revision: 2 });
    expect(store.getState().label).toBe("from-stale-base");
  });

  it("notifies state subscribers synchronously with current and previous state", () => {
    const store = createAppStore();
    const events: string[] = [];
    store.subscribe((state, previousState) => {
      events.push(`${previousState.counter}->${state.counter}`);
    });

    events.push("before");
    store.handleMutation(createMutation(store, { counter: 4 }));
    events.push("after");

    expect(events).toEqual(["before", "0->4", "after"]);
  });

  it("emits each canonical commit once", () => {
    const commitListener = vi.fn();
    const store = createMainStore<AppState>(
      "app",
      { counter: 0, label: "initial", profile: { name: "Ada" } },
      { onCommit: commitListener },
    );

    const result = store.handleMutation(createMutation(store, { counter: 1 }));

    expect(commitListener).toHaveBeenCalledOnce();
    expect(commitListener).toHaveBeenCalledWith(result);
  });

  it("preserves revision order for commits created reentrantly", () => {
    const store = createAppStore();
    const revisions: number[] = [];
    store.subscribeCommits((commit) => revisions.push(commit.revision));
    store.subscribe((state) => {
      if (state.counter === 1) {
        store.setState({ counter: 2 });
      }
    });

    store.setState({ counter: 1 });

    expect(revisions).toEqual([1, 2]);
  });

  describe("canonical no-ops", () => {
    it("returns a successful MutationNoop without changing canonical position", () => {
      const store = createAppStore();
      const before = store.getState();
      const request = createMutation(store, { counter: 0 });

      const result = store.handleMutation(request);

      expect(result).toEqual({
        type: "noop",
        protocolVersion: PROTOCOL_VERSION,
        storeId: "app",
        serverEpoch: store.getServerEpoch(),
        clientId: "renderer-a",
        mutationId: request.mutationId,
        revision: 0,
      });
      expect(store.getRevision()).toBe(0);
      expect(store.getState()).toBe(before);
    });

    it("does not notify subscribers or emit a commit", () => {
      const store = createAppStore();
      const subscriber = vi.fn();
      const commitListener = vi.fn();
      store.subscribe(subscriber);
      store.subscribeCommits(commitListener);

      store.handleMutation(createMutation(store, { counter: 0 }));

      expect(subscriber).not.toHaveBeenCalled();
      expect(commitListener).not.toHaveBeenCalled();
    });

    it("deduplicates a no-op using the original outcome", () => {
      const store = createAppStore();
      const request = createMutation(store, { counter: 0 });
      const first = store.handleMutation(request);
      store.setState({ label: "revision-one" });

      const duplicate = store.handleMutation(request);

      expect(duplicate).toBe(first);
      expect(duplicate).toMatchObject({ type: "noop", revision: 0 });
      expect(store.getRevision()).toBe(1);
    });
  });

  describe("deduplication", () => {
    it("returns the original Commit without applying or emitting twice", () => {
      const store = createAppStore();
      const subscriber = vi.fn();
      const commitListener = vi.fn();
      store.subscribe(subscriber);
      store.subscribeCommits(commitListener);
      const request = createMutation(store, { counter: 1 });
      const first = store.handleMutation(request);

      const duplicate = store.handleMutation({
        ...request,
        patch: { counter: 99 },
      });

      expect(duplicate).toBe(first);
      expect(store.getState().counter).toBe(1);
      expect(store.getRevision()).toBe(1);
      expect(subscriber).toHaveBeenCalledOnce();
      expect(commitListener).toHaveBeenCalledOnce();
    });

    it("records the outcome before reentrant duplicate processing", () => {
      const store = createAppStore();
      const request = createMutation(store, { counter: 1 });
      let reentrantResult: unknown;
      store.subscribe(() => {
        reentrantResult = store.handleMutation(request);
      });

      const result = store.handleMutation(request);

      expect(reentrantResult).toBe(result);
      expect(store.getRevision()).toBe(1);
    });
  });

  describe("server epochs", () => {
    it("rejects stale-epoch mutations without side effects", () => {
      const store = createAppStore();
      const subscriber = vi.fn();
      const commitListener = vi.fn();
      store.subscribe(subscriber);
      store.subscribeCommits(commitListener);

      const result = store.handleMutation(
        createMutation(store, { counter: 1 }, { serverEpoch: "old-epoch" }),
      );

      expect(result).toMatchObject({
        type: "rejected",
        code: "stale-server-epoch",
        retryable: true,
        revision: 0,
      });
      expect(store.getState().counter).toBe(0);
      expect(store.getRevision()).toBe(0);
      expect(subscriber).not.toHaveBeenCalled();
      expect(commitListener).not.toHaveBeenCalled();
    });

    it("does not permanently deduplicate stale-epoch rejections", () => {
      const store = createAppStore();
      const request = createMutation(store, { counter: 1 });
      const rejected = store.handleMutation({ ...request, serverEpoch: "old" });
      const committed = store.handleMutation(request);

      expect(rejected).toMatchObject({ type: "rejected" });
      expect(committed).toMatchObject({ type: "commit", revision: 1 });
    });

    it("allows stale-epoch resync to retrieve the current snapshot", () => {
      const store = createAppStore();
      store.setState({ counter: 2 });

      const response = store.handleResync({
        protocolVersion: PROTOCOL_VERSION,
        storeId: "app",
        clientId: "renderer-a",
        serverEpoch: "old-epoch",
        knownRevision: 0,
        pendingMutationIds: [],
      });

      expect(response.snapshot.serverEpoch).toBe(store.getServerEpoch());
      expect(response.snapshot.revision).toBe(1);
      expect(response.snapshot.state.counter).toBe(2);
    });
  });

  describe("main-originated updates", () => {
    it("uses the same canonical state and revision sequence", () => {
      const store = createAppStore();
      const commits: unknown[] = [];
      store.subscribeCommits((commit) => commits.push(commit));

      store.setState({ counter: 4 });
      store.setState((state) => ({ counter: state.counter + 1 }));

      expect(store.getState().counter).toBe(5);
      expect(store.getRevision()).toBe(2);
      expect(commits).toHaveLength(2);
      expect(commits).toEqual([
        expect.objectContaining({
          type: "commit",
          sourceClientId: "main",
          revision: 1,
          serverEpoch: store.getServerEpoch(),
          patch: { counter: 4 },
        }),
        expect.objectContaining({
          sourceClientId: "main",
          revision: 2,
          patch: { counter: 5 },
        }),
      ]);
    });

    it("does nothing for a main-originated no-op", () => {
      const store = createAppStore();
      const before = store.getState();
      const commitListener = vi.fn();
      store.subscribeCommits(commitListener);

      store.setState({ counter: 0 });

      expect(store.getState()).toBe(before);
      expect(store.getRevision()).toBe(0);
      expect(commitListener).not.toHaveBeenCalled();
    });
  });

  describe("snapshot and resync", () => {
    it("returns a shallow state copy that cannot replace canonical top-level state", () => {
      const store = createAppStore();
      const snapshot = store.getSnapshot();

      snapshot.state.counter = 99;

      expect(store.getState().counter).toBe(0);
      expect(snapshot.state).not.toBe(store.getState());
    });

    it("reports committed, no-op, and unknown pending mutation IDs", () => {
      const store = createAppStore();
      const committedRequest = createMutation(store, { counter: 1 });
      const noopRequest = createMutation(store, { counter: 1 });
      store.handleMutation(committedRequest);
      store.handleMutation(noopRequest);

      const response = store.handleResync({
        protocolVersion: PROTOCOL_VERSION,
        storeId: "app",
        clientId: "renderer-a",
        serverEpoch: store.getServerEpoch(),
        knownRevision: 0,
        pendingMutationIds: [
          committedRequest.mutationId,
          noopRequest.mutationId,
          "unknown-mutation",
        ],
      });

      expect(response.snapshot.revision).toBe(1);
      expect(response.appliedMutationIds).toEqual([committedRequest.mutationId]);
      expect(response.noopMutationIds).toEqual([noopRequest.mutationId]);
    });
  });

  it("returns invalid-mutation for a bad patch with a usable envelope", () => {
    const store = createAppStore();
    const request = createMutation(store, { counter: 1 });
    const result = store.handleMutation({
      ...request,
      patch: { counter: undefined },
    });

    expect(result).toMatchObject({
      type: "rejected",
      code: "invalid-mutation",
      retryable: false,
    });
    expect(store.getRevision()).toBe(0);
  });

  describe("destroy", () => {
    it("rejects renderer mutations after destruction", () => {
      const store = createAppStore();
      const request = createMutation(store, { counter: 1 });
      store.destroy();

      expect(store.handleMutation(request)).toMatchObject({
        type: "rejected",
        code: "store-destroyed",
      });
      expect(store.getRevision()).toBe(0);
    });

    it("prevents direct mutation and snapshots after destruction", () => {
      const store = createAppStore();
      const commitListener = vi.fn();
      store.subscribeCommits(commitListener);
      store.destroy();

      expect(() => store.setState({ counter: 1 })).toThrow(/destroyed/u);
      expect(() => store.getSnapshot()).toThrow(/destroyed/u);
      expect(commitListener).not.toHaveBeenCalled();
    });
  });
});
