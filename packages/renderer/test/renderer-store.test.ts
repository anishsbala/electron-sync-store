import {
  PROTOCOL_VERSION,
  type Commit,
  type Snapshot,
} from "@electron-sync-store/core";
import { describe, expect, it, vi } from "vitest";

import { createRendererStore } from "../src/index.js";
import { FakeRendererTransport } from "./fake-transport.js";

interface AppState {
  counter: number;
  label: string;
}

function snapshot(
  revision = 10,
  state: AppState = { counter: revision, label: "snapshot" },
  serverEpoch = "epoch-1",
): Snapshot<AppState> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    storeId: "app",
    serverEpoch,
    revision,
    state,
  };
}

function commit(
  revision: number,
  patch: Partial<AppState>,
  serverEpoch = "epoch-1",
): Commit<AppState> {
  return {
    type: "commit",
    protocolVersion: PROTOCOL_VERSION,
    storeId: "app",
    serverEpoch,
    sourceClientId: "main",
    mutationId: `mutation-${revision}`,
    revision,
    patch,
  };
}

async function hydratedStore(
  initialSnapshot = snapshot(),
): Promise<{
  store: Awaited<ReturnType<typeof createRendererStore<AppState>>>;
  transport: FakeRendererTransport<AppState>;
}> {
  const transport = new FakeRendererTransport<AppState>();
  const creating = createRendererStore<AppState>({ id: "app", transport });
  transport.resolveConnect(initialSnapshot);
  return { store: await creating, transport };
}

describe("createRendererStore", () => {
  it("connects with a generated client ID and hydrates a snapshot", async () => {
    const transport = new FakeRendererTransport<AppState>();
    const creating = createRendererStore<AppState>({ id: "app", transport });

    expect(transport.connectRequests).toHaveLength(1);
    expect(transport.connectRequests[0]).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
    });
    expect(transport.connectRequests[0]?.clientId).toEqual(expect.any(String));
    expect(transport.connectRequests[0]?.clientId).not.toBe("");

    transport.resolveConnect(snapshot());
    const store = await creating;

    expect(store.getState()).toEqual({ counter: 10, label: "snapshot" });
    expect(store.getSyncState()).toMatchObject({
      clientId: transport.connectRequests[0]?.clientId,
      serverEpoch: "epoch-1",
      revision: 10,
      pendingMutations: 0,
      status: "synced",
      error: null,
    });
  });

  it("keeps getState as a synchronous transport-free local read", async () => {
    const { store, transport } = await hydratedStore();
    const callsBefore = {
      connect: transport.connectRequests.length,
      mutate: transport.mutationRequests.length,
      resync: transport.resyncRequests.length,
    };

    const first = store.getState();
    const second = store.getState();

    expect(first).toBe(second);
    expect(transport.connectRequests).toHaveLength(callsBefore.connect);
    expect(transport.mutationRequests).toHaveLength(callsBefore.mutate);
    expect(transport.resyncRequests).toHaveLength(callsBefore.resync);
  });

  describe("handshake buffering", () => {
    it("applies a commit delivered before the snapshot promise resolves", async () => {
      const transport = new FakeRendererTransport<AppState>();
      const creating = createRendererStore<AppState>({ id: "app", transport });

      transport.deliverCommit(commit(11, { counter: 11 }));
      transport.resolveConnect(snapshot(10));
      const store = await creating;

      expect(store.getState().counter).toBe(11);
      expect(store.getSyncState().revision).toBe(11);
    });

    it("discards buffered commits already represented by the snapshot", async () => {
      const transport = new FakeRendererTransport<AppState>();
      const creating = createRendererStore<AppState>({ id: "app", transport });

      transport.deliverCommit(commit(9, { counter: 9 }));
      transport.deliverCommit(commit(10, { counter: 99 }));
      transport.resolveConnect(snapshot(10, { counter: 10, label: "canonical" }));
      const store = await creating;

      expect(store.getState()).toEqual({ counter: 10, label: "canonical" });
      expect(store.getSyncState().revision).toBe(10);
    });

    it("applies multiple buffered commits consecutively and ignores duplicates", async () => {
      const transport = new FakeRendererTransport<AppState>();
      const creating = createRendererStore<AppState>({ id: "app", transport });

      transport.deliverCommit(commit(12, { label: "twelve" }));
      transport.deliverCommit(commit(11, { counter: 11 }));
      transport.deliverCommit(commit(11, { counter: 999 }));
      transport.resolveConnect(snapshot(10));
      const store = await creating;

      expect(store.getState()).toEqual({ counter: 11, label: "twelve" });
      expect(store.getSyncState().revision).toBe(12);
    });

    it("requests resync for an initialization revision gap", async () => {
      const transport = new FakeRendererTransport<AppState>();
      transport.resyncResult = {
        snapshot: snapshot(12, { counter: 12, label: "resynced" }),
        appliedMutationIds: [],
        noopMutationIds: [],
      };
      const creating = createRendererStore<AppState>({ id: "app", transport });

      transport.deliverCommit(commit(12, { counter: 12 }));
      transport.resolveConnect(snapshot(10));
      const store = await creating;

      expect(transport.resyncRequests).toHaveLength(1);
      expect(transport.resyncRequests[0]).toMatchObject({
        storeId: "app",
        serverEpoch: "epoch-1",
        knownRevision: 10,
        pendingMutationIds: [],
      });
      expect(store.getState()).toEqual({ counter: 12, label: "resynced" });
      expect(store.getSyncState()).toMatchObject({ status: "synced", revision: 12 });
    });

    it("requests resync for a buffered epoch mismatch", async () => {
      const transport = new FakeRendererTransport<AppState>();
      transport.resyncResult = {
        snapshot: snapshot(2, { counter: 2, label: "new epoch" }, "epoch-2"),
        appliedMutationIds: [],
        noopMutationIds: [],
      };
      const creating = createRendererStore<AppState>({ id: "app", transport });

      transport.deliverCommit(commit(1, { counter: 1 }, "epoch-2"));
      transport.resolveConnect(snapshot(10));
      const store = await creating;

      expect(transport.resyncRequests).toHaveLength(1);
      expect(store.getState()).toEqual({ counter: 2, label: "new epoch" });
      expect(store.getSyncState()).toMatchObject({
        serverEpoch: "epoch-2",
        revision: 2,
        status: "synced",
      });
    });
  });

  describe("remote commits", () => {
    it("applies a contiguous commit and notifies synchronously", async () => {
      const { store, transport } = await hydratedStore();
      const events: string[] = [];
      store.subscribe((state, previousState) => {
        events.push(
          `${previousState.counter}->${state.counter}@${store.getSyncState().revision}`,
        );
      });

      events.push("before");
      transport.deliverCommit(commit(11, { counter: 11 }));
      events.push("after");

      expect(events).toEqual(["before", "10->11@11", "after"]);
      expect(store.getState().counter).toBe(11);
      expect(store.getSyncState().revision).toBe(11);
    });

    it("ignores duplicate and stale commits without notification", async () => {
      const { store, transport } = await hydratedStore();
      const listener = vi.fn();
      store.subscribe(listener);

      transport.deliverCommit(commit(10, { counter: 100 }));
      transport.deliverCommit(commit(9, { counter: 90 }));

      expect(store.getState().counter).toBe(10);
      expect(listener).not.toHaveBeenCalled();
    });

    it("uses a stable listener snapshot", async () => {
      const { store, transport } = await hydratedStore();
      const calls: string[] = [];
      const third = () => calls.push("third");
      let unsubscribeSecond: () => void = () => undefined;
      store.subscribe(() => {
        calls.push("first");
        unsubscribeSecond();
        store.subscribe(third);
      });
      unsubscribeSecond = store.subscribe(() => calls.push("second"));

      transport.deliverCommit(commit(11, { counter: 11 }));
      transport.deliverCommit(commit(12, { counter: 12 }));

      expect(calls).toEqual(["first", "second", "first", "third"]);
    });

    it("starts recovery on an ongoing revision gap without applying it", async () => {
      const { store, transport } = await hydratedStore();

      transport.deliverCommit(commit(12, { counter: 12 }));

      expect(store.getState().counter).toBe(10);
      expect(store.getSyncState()).toMatchObject({
        status: "resyncing",
        revision: 10,
      });
      expect(store.getSyncState().error).toBeNull();
      expect(transport.resyncRequests).toHaveLength(1);
    });
  });

  it("notifies sync subscribers for meaningful metadata changes", async () => {
    const { store, transport } = await hydratedStore();
    const listener = vi.fn();
    store.subscribeSync(listener);

    transport.deliverCommit(commit(11, { counter: 11 }));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      status: "synced",
      revision: 11,
      pendingMutations: 0,
    });
    expect(listener.mock.calls[0]?.[1]).toMatchObject({ revision: 10 });
  });

  describe("destroy", () => {
    it("disconnects, ignores later commits, and is idempotent", async () => {
      const { store, transport } = await hydratedStore();
      const stateListener = vi.fn();
      const syncListener = vi.fn();
      store.subscribe(stateListener);
      store.subscribeSync(syncListener);

      store.destroy();
      store.destroy();
      transport.deliverCommit(commit(11, { counter: 11 }));

      expect(transport.disconnectCount).toBe(1);
      expect(store.getSyncState().status).toBe("destroyed");
      expect(syncListener).toHaveBeenCalledOnce();
      expect(stateListener).not.toHaveBeenCalled();
      expect(() => store.getState()).toThrow(/destroyed/u);
      expect(() => store.subscribe(() => undefined)).toThrow(/destroyed/u);
    });

    it("cannot be resurrected by async initialization after abort", async () => {
      const transport = new FakeRendererTransport<AppState>();
      const controller = new AbortController();
      const creating = createRendererStore<AppState>({
        id: "app",
        transport,
        signal: controller.signal,
      });

      controller.abort();
      transport.resolveConnect(snapshot());

      await expect(creating).rejects.toMatchObject({ name: "AbortError" });
      expect(transport.disconnectCount).toBe(1);
    });
  });

  describe("errors", () => {
    it("rejects when the preload bridge is missing", async () => {
      await expect(createRendererStore<AppState>({ id: "app" })).rejects.toThrow(
        /exposeElectronSyncStore/u,
      );
    });

    it("rejects an invalid snapshot and disconnects", async () => {
      const transport = new FakeRendererTransport<AppState>();
      const creating = createRendererStore<AppState>({ id: "app", transport });
      transport.resolveConnect({
        ...snapshot(),
        revision: -1,
      } as Snapshot<AppState>);

      await expect(creating).rejects.toThrow(/nonnegative integer/u);
      expect(transport.disconnectCount).toBe(1);
    });

    it("rejects an invalid commit received during initialization", async () => {
      const transport = new FakeRendererTransport<AppState>();
      const creating = createRendererStore<AppState>({ id: "app", transport });
      transport.deliverCommit({
        ...commit(11, { counter: 11 }),
        protocolVersion: 2,
      });
      transport.resolveConnect(snapshot());

      await expect(creating).rejects.toThrow(/protocolVersion must be 1/u);
      expect(transport.disconnectCount).toBe(1);
    });

    it("starts recovery for an invalid incoming commit", async () => {
      const { store, transport } = await hydratedStore();

      transport.deliverCommit({ type: "commit", protocolVersion: 99 });

      expect(store.getSyncState().status).toBe("resyncing");
      expect(store.getState().counter).toBe(10);
      expect(transport.resyncRequests).toHaveLength(1);
    });

    it("propagates connect failures and disconnects", async () => {
      const transport = new FakeRendererTransport<AppState>();
      const creating = createRendererStore<AppState>({ id: "app", transport });

      transport.rejectConnect(new Error("connect failed"));

      await expect(creating).rejects.toThrow("connect failed");
      expect(transport.disconnectCount).toBe(1);
    });

    it("rejects an empty store ID before connecting", async () => {
      const transport = new FakeRendererTransport<AppState>();

      await expect(
        createRendererStore<AppState>({ id: " ", transport }),
      ).rejects.toThrow(/non-empty string/u);
      expect(transport.connectRequests).toHaveLength(0);
    });
  });
});
