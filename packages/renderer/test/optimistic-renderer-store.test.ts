import {
  PROTOCOL_VERSION,
  type Commit,
  type MutationNoop,
  type MutationRejection,
  type MutationRequest,
  type Snapshot,
} from "@electron-sync-store/core";
import { describe, expect, it, vi } from "vitest";

import { createRendererStore, type RendererStore } from "../src/index.js";
import { FakeRendererTransport } from "./fake-transport.js";

interface AppState {
  counter: number;
  theme: string;
}

function snapshot(
  revision = 10,
  state: AppState = { counter: 0, theme: "dark" },
): Snapshot<AppState> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    storeId: "app",
    serverEpoch: "epoch-1",
    revision,
    state,
  };
}

function commitFor(
  request: MutationRequest<AppState>,
  revision: number,
): Commit<AppState> {
  return {
    type: "commit",
    protocolVersion: PROTOCOL_VERSION,
    storeId: request.storeId,
    serverEpoch: request.serverEpoch,
    sourceClientId: request.clientId,
    mutationId: request.mutationId,
    revision,
    patch: request.patch,
  };
}

function remoteCommit(
  revision: number,
  patch: Partial<AppState>,
  mutationId = `remote-${revision}`,
): Commit<AppState> {
  return {
    type: "commit",
    protocolVersion: PROTOCOL_VERSION,
    storeId: "app",
    serverEpoch: "epoch-1",
    sourceClientId: "remote-client",
    mutationId,
    revision,
    patch,
  };
}

function noopFor(request: MutationRequest<AppState>): MutationNoop {
  return {
    type: "noop",
    protocolVersion: PROTOCOL_VERSION,
    storeId: request.storeId,
    serverEpoch: request.serverEpoch,
    clientId: request.clientId,
    mutationId: request.mutationId,
    revision: request.baseRevision,
  };
}

function rejectionFor(
  request: MutationRequest<AppState>,
  code: MutationRejection["code"] = "unauthorized",
): MutationRejection {
  return {
    type: "rejected",
    protocolVersion: PROTOCOL_VERSION,
    storeId: request.storeId,
    serverEpoch: request.serverEpoch,
    clientId: request.clientId,
    mutationId: request.mutationId,
    revision: request.baseRevision,
    code,
    message: "mutation rejected",
    retryable: false,
  };
}

async function hydratedStore(): Promise<{
  store: RendererStore<AppState>;
  transport: FakeRendererTransport<AppState>;
}> {
  const transport = new FakeRendererTransport<AppState>();
  const creating = createRendererStore<AppState>({ id: "app", transport });
  transport.resolveConnect(snapshot());
  return { store: await creating, transport };
}

async function settleMutation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("optimistic renderer mutations", () => {
  it("applies an object patch and synchronization metadata synchronously", async () => {
    const { store, transport } = await hydratedStore();
    const observations: string[] = [];
    store.subscribe((state) => {
      const sync = store.getSyncState();
      observations.push(`${state.counter}@${sync.revision}+${sync.pendingMutations}`);
    });

    store.setState({ counter: 5 });

    expect(store.getState().counter).toBe(5);
    expect(store.getSyncState()).toMatchObject({
      revision: 10,
      pendingMutations: 1,
      status: "synced",
    });
    expect(observations).toEqual(["5@10+1"]);
    expect(transport.mutationRequests).toHaveLength(1);
    expect(transport.pendingMutationCount).toBe(1);
    expect(transport.mutationRequests[0]).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      serverEpoch: "epoch-1",
      clientId: store.getSyncState().clientId,
      baseRevision: 10,
      patch: { counter: 5 },
    });
    expect(transport.mutationRequests[0]?.mutationId).toEqual(expect.any(String));
    expect(transport.mutationRequests[0]?.mutationId).not.toBe("");
  });

  it("uses distinct mutation IDs and the confirmed revision for consecutive writes", async () => {
    const { store, transport } = await hydratedStore();

    store.setState({ counter: 1 });
    store.setState({ theme: "light" });

    expect(store.getState()).toEqual({ counter: 1, theme: "light" });
    expect(store.getSyncState()).toMatchObject({ revision: 10, pendingMutations: 2 });
    expect(transport.mutationRequests).toHaveLength(2);
    expect(transport.mutationRequests[0]?.baseRevision).toBe(10);
    expect(transport.mutationRequests[1]?.baseRevision).toBe(10);
    expect(transport.mutationRequests[0]?.mutationId).not.toBe(
      transport.mutationRequests[1]?.mutationId,
    );
  });

  it("skips local no-ops without allocating or submitting a mutation", async () => {
    const { store, transport } = await hydratedStore();
    const stateListener = vi.fn();
    const syncListener = vi.fn();
    store.subscribe(stateListener);
    store.subscribeSync(syncListener);

    store.setState({ counter: 0 });

    expect(transport.mutationRequests).toHaveLength(0);
    expect(store.getSyncState().pendingMutations).toBe(0);
    expect(stateListener).not.toHaveBeenCalled();
    expect(syncListener).not.toHaveBeenCalled();
  });

  it("rejects nonserializable patches before changing local state", async () => {
    const { store, transport } = await hydratedStore();

    expect(() =>
      store.setState({ counter: new Map() } as unknown as Partial<AppState>),
    ).toThrow(/serializable/u);
    expect(store.getState()).toEqual({ counter: 0, theme: "dark" });
    expect(store.getSyncState().pendingMutations).toBe(0);
    expect(transport.mutationRequests).toHaveLength(0);
  });

  it("rejects a nonserializable functional result without submitting it", async () => {
    const { store, transport } = await hydratedStore();
    const updater = vi.fn(() => ({ theme: new Set(["light"]) }));

    expect(() =>
      store.setState(updater as unknown as (state: Readonly<AppState>) => Partial<AppState>),
    ).toThrow(/serializable/u);
    expect(updater).toHaveBeenCalledOnce();
    expect(store.getState()).toEqual({ counter: 0, theme: "dark" });
    expect(transport.mutationRequests).toHaveLength(0);
  });

  it("evaluates a functional updater exactly once against visible state", async () => {
    const { store, transport } = await hydratedStore();
    const updater = vi.fn((state: Readonly<AppState>) => ({
      counter: state.counter + 1,
    }));

    store.setState({ counter: 4 });
    store.setState(updater);

    expect(updater).toHaveBeenCalledOnce();
    expect(updater).toHaveBeenCalledWith({ counter: 4, theme: "dark" });
    expect(store.getState().counter).toBe(5);
    expect(transport.mutationRequests[1]?.patch).toEqual({ counter: 5 });
  });

  it("preserves local mutation order under a reentrant subscriber write", async () => {
    const { store, transport } = await hydratedStore();
    let reentered = false;
    store.subscribe(() => {
      if (!reentered) {
        reentered = true;
        store.setState({ theme: "light" });
      }
    });

    store.setState({ counter: 1 });

    expect(transport.mutationRequests.map((request) => request.patch)).toEqual([
      { counter: 1 },
      { theme: "light" },
    ]);
    expect(store.getState()).toEqual({ counter: 1, theme: "light" });
  });
});

describe("canonical renderer reconciliation", () => {
  it("acknowledges an own commit without repeating the visible state change", async () => {
    const { store, transport } = await hydratedStore();
    const stateListener = vi.fn();
    const syncObservations: string[] = [];
    store.subscribe(stateListener);
    store.subscribeSync((sync) => {
      expect(store.getState().counter).toBe(5);
      syncObservations.push(`${sync.revision}+${sync.pendingMutations}`);
    });
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;
    stateListener.mockClear();
    syncObservations.length = 0;

    transport.resolveMutation(request.mutationId, commitFor(request, 11));
    await settleMutation();

    expect(store.getState().counter).toBe(5);
    expect(store.getSyncState()).toMatchObject({ revision: 11, pendingMutations: 0 });
    expect(stateListener).not.toHaveBeenCalled();
    expect(syncObservations).toEqual(["11+0"]);
  });

  it("rebases an unrelated remote commit beneath a pending local patch", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });

    transport.deliverCommit(remoteCommit(11, { theme: "light" }));

    expect(store.getState()).toEqual({ counter: 5, theme: "light" });
    expect(store.getSyncState()).toMatchObject({ revision: 11, pendingMutations: 1 });
  });

  it("rebases a same-key remote commit beneath a pending local patch", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });

    transport.deliverCommit(remoteCommit(11, { counter: 3 }));

    expect(store.getState().counter).toBe(5);
    expect(store.getSyncState()).toMatchObject({ revision: 11, pendingMutations: 1 });
  });

  it("keeps later different-key pending state while acknowledgments arrive", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 1 });
    store.setState({ theme: "light" });
    const [first, second] = transport.mutationRequests as [
      MutationRequest<AppState>,
      MutationRequest<AppState>,
    ];

    transport.resolveMutation(first.mutationId, commitFor(first, 11));
    await settleMutation();
    expect(store.getState()).toEqual({ counter: 1, theme: "light" });
    expect(store.getSyncState()).toMatchObject({ revision: 11, pendingMutations: 1 });

    transport.resolveMutation(second.mutationId, commitFor(second, 12));
    await settleMutation();
    expect(store.getState()).toEqual({ counter: 1, theme: "light" });
    expect(store.getSyncState()).toMatchObject({ revision: 12, pendingMutations: 0 });
  });

  it("keeps a later same-key mutation visible after the first commits", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 1 });
    store.setState({ counter: 2 });
    const [first, second] = transport.mutationRequests as [
      MutationRequest<AppState>,
      MutationRequest<AppState>,
    ];

    transport.resolveMutation(first.mutationId, commitFor(first, 11));
    await settleMutation();
    expect(store.getState().counter).toBe(2);
    expect(store.getSyncState().pendingMutations).toBe(1);

    transport.resolveMutation(second.mutationId, commitFor(second, 12));
    await settleMutation();
    expect(store.getState().counter).toBe(2);
    expect(store.getSyncState()).toMatchObject({ revision: 12, pendingMutations: 0 });
  });

  it("is idempotent when the response precedes the Commit broadcast", async () => {
    const { store, transport } = await hydratedStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;
    const result = commitFor(request, 11);
    listener.mockClear();

    transport.resolveMutation(request.mutationId, result);
    await settleMutation();
    transport.deliverCommit(result);

    expect(store.getSyncState()).toMatchObject({ revision: 11, pendingMutations: 0 });
    expect(store.getState().counter).toBe(5);
    expect(listener).not.toHaveBeenCalled();
  });

  it("is idempotent when the Commit broadcast precedes the response", async () => {
    const { store, transport } = await hydratedStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;
    const result = commitFor(request, 11);
    listener.mockClear();

    transport.deliverCommit(result);
    transport.deliverCommit(result);
    transport.resolveMutation(request.mutationId, result);
    await settleMutation();

    expect(store.getSyncState()).toMatchObject({ revision: 11, pendingMutations: 0 });
    expect(store.getState().counter).toBe(5);
    expect(listener).not.toHaveBeenCalled();
  });

  it("removes a still-pending mutation identified by a stale Commit", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;

    transport.deliverCommit(remoteCommit(11, { counter: 5 }, "other"));
    transport.deliverCommit(commitFor(request, 11));

    expect(store.getSyncState()).toMatchObject({ revision: 11, pendingMutations: 0 });
    expect(store.getState().counter).toBe(5);
  });

  it("preserves pending state and starts recovery for a revision gap", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });

    transport.deliverCommit(remoteCommit(12, { theme: "light" }));

    expect(store.getState()).toEqual({ counter: 5, theme: "dark" });
    expect(store.getSyncState()).toMatchObject({
      status: "resyncing",
      revision: 10,
      pendingMutations: 1,
    });
  });

  it("does not compare epochs or remove pending state on an epoch mismatch", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;

    transport.deliverCommit({
      ...commitFor(request, 11),
      serverEpoch: "epoch-2",
    });

    expect(store.getState().counter).toBe(5);
    expect(store.getSyncState()).toMatchObject({
      serverEpoch: "epoch-1",
      revision: 10,
      pendingMutations: 1,
      status: "resyncing",
    });
  });
});

describe("mutation acknowledgments and failures", () => {
  it("removes a canonical no-op without advancing the revision", async () => {
    const { store, transport } = await hydratedStore();
    const stateListener = vi.fn();
    const syncListener = vi.fn();
    store.subscribe(stateListener);
    store.subscribeSync(syncListener);
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;
    stateListener.mockClear();
    syncListener.mockClear();

    transport.resolveMutation(request.mutationId, noopFor(request));
    await settleMutation();

    expect(store.getState().counter).toBe(0);
    expect(store.getSyncState()).toMatchObject({ revision: 10, pendingMutations: 0 });
    expect(stateListener).toHaveBeenCalledOnce();
    expect(syncListener).toHaveBeenCalledOnce();

  });

  it("does not notify state when a no-op removal leaves a later same-key value", async () => {
    const { store, transport } = await hydratedStore();
    const stateListener = vi.fn();
    store.subscribe(stateListener);
    store.setState({ counter: 1 });
    store.setState({ counter: 2 });
    const [first] = transport.mutationRequests as [MutationRequest<AppState>];
    stateListener.mockClear();

    transport.resolveMutation(first.mutationId, noopFor(first));
    await settleMutation();

    expect(store.getState().counter).toBe(2);
    expect(store.getSyncState()).toMatchObject({ revision: 10, pendingMutations: 1 });
    expect(stateListener).not.toHaveBeenCalled();
  });

  it("rolls back only a rejected different-key mutation", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    store.setState({ theme: "light" });
    const [first] = transport.mutationRequests as [MutationRequest<AppState>];

    transport.resolveMutation(first.mutationId, rejectionFor(first));
    await settleMutation();

    expect(store.getState()).toEqual({ counter: 0, theme: "light" });
    expect(store.getSyncState()).toMatchObject({
      revision: 10,
      pendingMutations: 1,
      status: "synced",
    });
  });

  it("preserves a later same-key mutation when the earlier one is rejected", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 1 });
    store.setState({ counter: 2 });
    const [first] = transport.mutationRequests as [MutationRequest<AppState>];

    transport.resolveMutation(first.mutationId, rejectionFor(first));
    await settleMutation();

    expect(store.getState().counter).toBe(2);
    expect(store.getSyncState()).toMatchObject({ pendingMutations: 1, status: "synced" });
  });

  it("retains an uncertain mutation and starts transport recovery", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;

    transport.rejectMutation(request.mutationId, new Error("IPC disconnected"));
    await settleMutation();

    expect(store.getState().counter).toBe(5);
    expect(store.getSyncState()).toMatchObject({
      revision: 10,
      pendingMutations: 1,
      status: "resyncing",
    });
    expect(store.getSyncState().error).toBeNull();
    expect(transport.resyncRequests[0]?.pendingMutationIds).toEqual([
      request.mutationId,
    ]);

    store.setState({ counter: 6 });
    expect(store.getState().counter).toBe(6);
    expect(store.getSyncState().pendingMutations).toBe(2);
    expect(transport.mutationRequests).toHaveLength(1);
  });

  it("ignores late mutation fulfillment and rejection after destroy", async () => {
    const first = await hydratedStore();
    first.store.setState({ counter: 5 });
    const firstRequest = first.transport.mutationRequests[0] as MutationRequest<AppState>;
    first.store.destroy();
    first.transport.resolveMutation(firstRequest.mutationId, commitFor(firstRequest, 11));

    const second = await hydratedStore();
    second.store.setState({ counter: 5 });
    const secondRequest = second.transport.mutationRequests[0] as MutationRequest<AppState>;
    second.store.destroy();
    second.transport.rejectMutation(secondRequest.mutationId, new Error("late"));
    await settleMutation();

    expect(first.store.getSyncState()).toMatchObject({ status: "destroyed", pendingMutations: 0 });
    expect(second.store.getSyncState()).toMatchObject({ status: "destroyed", pendingMutations: 0 });
    expect(() => first.store.setState({ counter: 6 })).toThrow(/destroyed/u);
  });
});
