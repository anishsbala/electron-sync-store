import {
  PROTOCOL_VERSION,
  type Commit,
  type MutationRejection,
  type MutationRequest,
  type ResyncResponse,
  type Snapshot,
} from "@electron-sync-store/core";
import { describe, expect, it, vi } from "vitest";

import {
  createRendererStore,
  type CreateRendererStoreOptions,
  type RendererStore,
} from "../src/index.js";
import { FakeRendererTransport } from "./fake-transport.js";

interface AppState {
  counter: number;
  theme: string;
}

function snapshot(
  revision = 10,
  state: AppState = { counter: 0, theme: "dark" },
  serverEpoch = "epoch-a",
): Snapshot<AppState> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    storeId: "app",
    serverEpoch,
    revision,
    state,
  };
}

function resyncResponse(
  nextSnapshot: Snapshot<AppState>,
  appliedMutationIds: string[] = [],
  noopMutationIds: string[] = [],
): ResyncResponse<AppState> {
  return { snapshot: nextSnapshot, appliedMutationIds, noopMutationIds };
}

function commitFor(
  request: MutationRequest<AppState>,
  revision: number,
  serverEpoch = request.serverEpoch,
): Commit<AppState> {
  return {
    type: "commit",
    protocolVersion: PROTOCOL_VERSION,
    storeId: "app",
    serverEpoch,
    sourceClientId: request.clientId,
    mutationId: request.mutationId,
    revision,
    patch: request.patch,
  };
}

function remoteCommit(
  revision: number,
  patch: Partial<AppState>,
  serverEpoch = "epoch-a",
  mutationId = `remote-${revision}`,
): Commit<AppState> {
  return {
    type: "commit",
    protocolVersion: PROTOCOL_VERSION,
    storeId: "app",
    serverEpoch,
    sourceClientId: "remote",
    mutationId,
    revision,
    patch,
  };
}

function staleEpochRejection(
  request: MutationRequest<AppState>,
): MutationRejection {
  return {
    type: "rejected",
    protocolVersion: PROTOCOL_VERSION,
    storeId: "app",
    serverEpoch: "epoch-b",
    clientId: request.clientId,
    mutationId: request.mutationId,
    revision: 0,
    code: "stale-server-epoch",
    message: "main restarted",
    retryable: true,
  };
}

async function hydratedStore(
  overrides: Omit<CreateRendererStoreOptions<AppState>, "id" | "transport"> = {},
): Promise<{
  store: RendererStore<AppState>;
  transport: FakeRendererTransport<AppState>;
}> {
  const transport = new FakeRendererTransport<AppState>();
  const creating = createRendererStore<AppState>({
    id: "app",
    transport,
    ...overrides,
  });
  transport.resolveConnect(snapshot());
  return { store: await creating, transport };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("uncertain mutation recovery", () => {
  it("removes a mutation that resync reports as committed without retrying", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;
    const flushing = store.flush();

    transport.rejectMutation(request.mutationId, new Error("response lost"));
    await settle();

    expect(store.getSyncState()).toMatchObject({
      status: "resyncing",
      pendingMutations: 1,
    });
    expect(transport.resyncRequests[0]?.pendingMutationIds).toEqual([
      request.mutationId,
    ]);
    transport.resolveResync(
      resyncResponse(
        snapshot(11, { counter: 5, theme: "dark" }),
        [request.mutationId],
      ),
    );
    await settle();

    await expect(flushing).resolves.toBeUndefined();
    expect(transport.mutationRequests).toHaveLength(1);
    expect(store.getState().counter).toBe(5);
    expect(store.getSyncState()).toMatchObject({
      status: "synced",
      revision: 11,
      pendingMutations: 0,
    });
  });

  it("removes a mutation that resync reports as a canonical no-op", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;

    transport.rejectMutation(request.mutationId, new Error("response lost"));
    await settle();
    transport.resolveResync(
      resyncResponse(snapshot(), [], [request.mutationId]),
    );
    await settle();

    await expect(store.flush()).resolves.toBeUndefined();
    expect(transport.mutationRequests).toHaveLength(1);
    expect(store.getState().counter).toBe(0);
    expect(store.getSyncState()).toMatchObject({
      status: "synced",
      revision: 10,
      pendingMutations: 0,
    });
  });

  it("retries an unresolved mutation with the same identity and patch", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    const original = transport.mutationRequests[0] as MutationRequest<AppState>;
    const flushing = store.flush();

    transport.rejectMutation(original.mutationId, new Error("not delivered"));
    await settle();
    transport.resolveResync(resyncResponse(snapshot()));
    await settle();

    const retry = transport.mutationRequests[1] as MutationRequest<AppState>;
    expect(retry).toMatchObject({
      mutationId: original.mutationId,
      patch: original.patch,
      serverEpoch: original.serverEpoch,
      baseRevision: original.baseRevision,
    });
    expect(store.getState().counter).toBe(5);
    transport.resolveMutation(retry.mutationId, commitFor(retry, 11));
    await settle();

    await expect(flushing).resolves.toBeUndefined();
    expect(store.getSyncState()).toMatchObject({
      status: "synced",
      revision: 11,
      pendingMutations: 0,
    });
  });

  it("does not rerun a functional updater while retrying", async () => {
    const { store, transport } = await hydratedStore();
    const updater = vi.fn((state: Readonly<AppState>) => ({
      counter: state.counter + 1,
    }));
    store.setState(updater);
    const original = transport.mutationRequests[0] as MutationRequest<AppState>;

    transport.rejectMutation(original.mutationId, new Error("uncertain"));
    await settle();
    transport.resolveResync(resyncResponse(snapshot()));
    await settle();

    expect(updater).toHaveBeenCalledOnce();
    expect(transport.mutationRequests[1]?.patch).toEqual({ counter: 1 });
  });

  it("keeps one resync in flight across several recovery triggers", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;

    transport.rejectMutation(request.mutationId, new Error("uncertain"));
    await settle();
    transport.deliverCommit(remoteCommit(12, { theme: "light" }));
    transport.deliverCommit(remoteCommit(13, { theme: "blue" }));

    expect(store.getSyncState().status).toBe("resyncing");
    expect(transport.resyncRequests).toHaveLength(1);
  });

  it("uses a matching Commit buffered during resync instead of retrying", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;

    transport.rejectMutation(request.mutationId, new Error("response lost"));
    await settle();
    transport.deliverCommit(commitFor(request, 11));
    transport.resolveResync(resyncResponse(snapshot()));
    await settle();

    await expect(store.flush()).resolves.toBeUndefined();
    expect(transport.mutationRequests).toHaveLength(1);
    expect(store.getState().counter).toBe(5);
    expect(store.getSyncState()).toMatchObject({
      status: "synced",
      revision: 11,
      pendingMutations: 0,
    });
  });

  it("enters terminal error only after the mutation attempt limit is exhausted", async () => {
    const { store, transport } = await hydratedStore({ maxMutationAttempts: 2 });
    store.setState({ counter: 5 });
    const original = transport.mutationRequests[0] as MutationRequest<AppState>;
    const flushAssertion = expect(store.flush()).rejects.toThrow(/unresolved after 2 attempts/u);

    transport.rejectMutation(original.mutationId, new Error("first uncertain"));
    await settle();
    transport.resolveResync(resyncResponse(snapshot()));
    await settle();
    const retry = transport.mutationRequests[1] as MutationRequest<AppState>;
    transport.rejectMutation(retry.mutationId, new Error("second uncertain"));
    await settle();
    transport.resolveResync(resyncResponse(snapshot()));
    await settle();

    await flushAssertion;
    expect(transport.mutationRequests).toHaveLength(2);
    expect(store.getState().counter).toBe(5);
    expect(store.getSyncState()).toMatchObject({
      status: "error",
      pendingMutations: 1,
    });
  });

  it("bounds resync transport failures", async () => {
    const { store, transport } = await hydratedStore({ maxResyncAttempts: 2 });
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;
    const flushAssertion = expect(store.flush()).rejects.toThrow(/exhausted 2 resync attempts/u);

    transport.rejectMutation(request.mutationId, new Error("uncertain"));
    await settle();
    transport.rejectResync(new Error("resync one failed"));
    await settle();
    expect(transport.resyncRequests).toHaveLength(2);
    transport.rejectResync(new Error("resync two failed"));
    await settle();

    await flushAssertion;
    expect(transport.resyncRequests).toHaveLength(2);
    expect(store.getSyncState().status).toBe("error");
  });
});

describe("pending-aware snapshot and commit recovery", () => {
  it("rebases a pending patch over a gap recovery snapshot and retries it", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    const original = transport.mutationRequests[0] as MutationRequest<AppState>;

    transport.deliverCommit(remoteCommit(12, { theme: "light" }));
    transport.rejectMutation(original.mutationId, new Error("uncertain"));
    await settle();
    expect(store.getState()).toEqual({ counter: 5, theme: "dark" });
    expect(store.getSyncState()).toMatchObject({ status: "resyncing", revision: 10 });

    transport.resolveResync(
      resyncResponse(snapshot(12, { counter: 0, theme: "light" })),
    );
    await settle();

    const retry = transport.mutationRequests[1] as MutationRequest<AppState>;
    expect(store.getState()).toEqual({ counter: 5, theme: "light" });
    expect(retry.mutationId).toBe(original.mutationId);
    transport.resolveMutation(retry.mutationId, commitFor(retry, 13));
    await settle();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.getSyncState().revision).toBe(13);
  });

  it("applies a contiguous Commit buffered while resync is pending", async () => {
    const { store, transport } = await hydratedStore();
    transport.deliverCommit({ type: "commit", protocolVersion: 99 });
    transport.deliverCommit(remoteCommit(11, { theme: "light" }));

    transport.resolveResync(resyncResponse(snapshot()));
    await settle();

    expect(store.getState().theme).toBe("light");
    expect(store.getSyncState()).toMatchObject({ status: "synced", revision: 11 });
  });

  it("discards buffered commits already included in the snapshot", async () => {
    const { store, transport } = await hydratedStore();
    const listener = vi.fn();
    store.subscribe(listener);
    transport.deliverCommit({ type: "commit", protocolVersion: 99 });
    transport.deliverCommit(remoteCommit(11, { theme: "light" }));

    transport.resolveResync(
      resyncResponse(snapshot(11, { counter: 0, theme: "light" })),
    );
    await settle();

    expect(store.getState().theme).toBe("light");
    expect(store.getSyncState().revision).toBe(11);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("deduplicates buffered Commit revisions", async () => {
    const { store, transport } = await hydratedStore();
    transport.deliverCommit({ type: "commit", protocolVersion: 99 });
    const next = remoteCommit(11, { theme: "light" });
    transport.deliverCommit(next);
    transport.deliverCommit(next);

    transport.resolveResync(resyncResponse(snapshot()));
    await settle();

    expect(store.getSyncState()).toMatchObject({ status: "synced", revision: 11 });
    expect(store.getState().theme).toBe("light");
  });

  it("requests another snapshot when a buffered gap remains", async () => {
    const { store, transport } = await hydratedStore();
    transport.deliverCommit({ type: "commit", protocolVersion: 99 });
    transport.deliverCommit(remoteCommit(11, { theme: "light" }));
    transport.deliverCommit(remoteCommit(13, { counter: 13 }));

    transport.resolveResync(resyncResponse(snapshot()));
    await settle();
    expect(transport.resyncRequests).toHaveLength(2);
    expect(store.getSyncState()).toMatchObject({ status: "resyncing", revision: 11 });

    transport.resolveResync(
      resyncResponse(snapshot(13, { counter: 13, theme: "light" })),
    );
    await settle();
    expect(store.getSyncState()).toMatchObject({ status: "synced", revision: 13 });
  });

  it("forces a fresh snapshot after the commit recovery buffer overflows", async () => {
    const { store, transport } = await hydratedStore({ maxBufferedCommits: 1 });
    transport.deliverCommit({ type: "commit", protocolVersion: 99 });
    transport.deliverCommit(remoteCommit(11, { theme: "light" }));
    transport.deliverCommit(remoteCommit(12, { counter: 12 }));

    transport.resolveResync(resyncResponse(snapshot()));
    await settle();
    expect(transport.resyncRequests).toHaveLength(2);
    expect(store.getSyncState().status).toBe("resyncing");

    transport.resolveResync(
      resyncResponse(snapshot(12, { counter: 12, theme: "light" })),
    );
    await settle();
    expect(store.getState()).toEqual({ counter: 12, theme: "light" });
    expect(store.getSyncState()).toMatchObject({ status: "synced", revision: 12 });
  });

  it("recovers a pending mutation into a new epoch with the same ID", async () => {
    const { store, transport } = await hydratedStore();
    const updater = vi.fn(() => ({ counter: 5 }));
    store.setState(updater);
    const original = transport.mutationRequests[0] as MutationRequest<AppState>;

    transport.resolveMutation(original.mutationId, staleEpochRejection(original));
    await settle();
    transport.resolveResync(
      resyncResponse(snapshot(0, { counter: 0, theme: "new" }, "epoch-b")),
    );
    await settle();

    const retry = transport.mutationRequests[1] as MutationRequest<AppState>;
    expect(updater).toHaveBeenCalledOnce();
    expect(retry).toMatchObject({
      mutationId: original.mutationId,
      patch: { counter: 5 },
      serverEpoch: "epoch-b",
      baseRevision: 0,
    });
    expect(store.getState()).toEqual({ counter: 5, theme: "new" });
    expect(store.getSyncState()).toMatchObject({
      serverEpoch: "epoch-b",
      revision: 0,
      pendingMutations: 1,
    });
  });

  it("queues synchronous setState during resync until the epoch is stable", async () => {
    const { store, transport } = await hydratedStore();
    transport.deliverCommit({ type: "commit", protocolVersion: 99 });

    store.setState({ counter: 5 });

    expect(store.getState().counter).toBe(5);
    expect(store.getSyncState()).toMatchObject({ status: "resyncing", pendingMutations: 1 });
    expect(transport.mutationRequests).toHaveLength(0);
    transport.resolveResync(
      resyncResponse(snapshot(0, { counter: 0, theme: "new" }, "epoch-b")),
    );
    await settle();

    expect(store.getState()).toEqual({ counter: 5, theme: "new" });
    expect(transport.mutationRequests[0]).toMatchObject({
      serverEpoch: "epoch-b",
      baseRevision: 0,
      patch: { counter: 5 },
    });
  });
});

describe("renderer flush and bounded queues", () => {
  it("resolves flush immediately when the store is settled", async () => {
    const { store, transport } = await hydratedStore();

    await expect(store.flush()).resolves.toBeUndefined();
    expect(transport.resyncRequests).toHaveLength(0);
  });

  it("settles multiple flush waiters after all pending mutations commit", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 1 });
    store.setState({ theme: "light" });
    const firstFlush = store.flush();
    const secondFlush = store.flush();
    const [first, second] = transport.mutationRequests as [
      MutationRequest<AppState>,
      MutationRequest<AppState>,
    ];

    transport.resolveMutation(first.mutationId, commitFor(first, 11));
    await settle();
    let settled = false;
    void firstFlush.then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);

    transport.resolveMutation(second.mutationId, commitFor(second, 12));
    await expect(Promise.all([firstFlush, secondFlush])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("allows flush to resolve after an ordinary mutation rejection", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;
    const flushing = store.flush();

    transport.resolveMutation(request.mutationId, {
      type: "rejected",
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      serverEpoch: "epoch-a",
      clientId: request.clientId,
      mutationId: request.mutationId,
      revision: 10,
      code: "unauthorized",
      message: "not allowed",
      retryable: false,
    });

    await expect(flushing).resolves.toBeUndefined();
    expect(store.getState().counter).toBe(0);
    expect(store.getSyncState().status).toBe("synced");
  });

  it("rejects all flush waiters when the store is destroyed", async () => {
    const { store } = await hydratedStore();
    store.setState({ counter: 5 });
    const first = expect(store.flush()).rejects.toThrow(/destroyed/u);
    const second = expect(store.flush()).rejects.toThrow(/destroyed/u);

    store.destroy();

    await Promise.all([first, second]);
    await expect(store.flush()).rejects.toThrow(/destroyed/u);
  });

  it("rejects a mutation before exceeding the configured pending limit", async () => {
    const { store, transport } = await hydratedStore({ maxPendingMutations: 2 });
    store.setState({ counter: 1 });
    store.setState({ counter: 2 });

    expect(() => store.setState({ theme: "light" })).toThrow(/pending mutation limit of 2/u);
    expect(store.getState()).toEqual({ counter: 2, theme: "dark" });
    expect(store.getSyncState().pendingMutations).toBe(2);
    expect(transport.mutationRequests).toHaveLength(2);
  });

  it("validates configured synchronization limits", async () => {
    const transport = new FakeRendererTransport<AppState>();

    await expect(
      createRendererStore({ id: "app", transport, maxMutationAttempts: 0 }),
    ).rejects.toThrow(/positive integer/u);
    expect(transport.connectRequests).toHaveLength(0);
  });

  it("ignores late recovery completion after destroy", async () => {
    const { store, transport } = await hydratedStore();
    const stateListener = vi.fn();
    store.subscribe(stateListener);
    transport.deliverCommit({ type: "commit", protocolVersion: 99 });
    const flushing = expect(store.flush()).rejects.toThrow(/destroyed/u);

    store.destroy();
    transport.resolveResync(
      resyncResponse(snapshot(11, { counter: 11, theme: "light" })),
    );
    await settle();

    await flushing;
    expect(store.getSyncState().status).toBe("destroyed");
    expect(stateListener).not.toHaveBeenCalled();
    expect(transport.mutationRequests).toHaveLength(0);
  });

  it("exposes coherent state and metadata throughout snapshot recovery", async () => {
    const { store, transport } = await hydratedStore();
    store.setState({ counter: 5 });
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;
    const observations: string[] = [];
    store.subscribeSync((sync) => {
      observations.push(
        `${sync.status}:${sync.revision}:${sync.pendingMutations}:${store.getState().counter}:${store.getState().theme}`,
      );
    });

    transport.rejectMutation(request.mutationId, new Error("uncertain"));
    await settle();
    transport.resolveResync(
      resyncResponse(
        snapshot(11, { counter: 5, theme: "light" }),
        [request.mutationId],
      ),
    );
    await settle();

    expect(observations).toContain("resyncing:10:1:5:dark");
    expect(observations).toContain("resyncing:11:0:5:light");
    expect(observations).toContain("synced:11:0:5:light");
  });
});
