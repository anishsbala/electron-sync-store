import {
  PROTOCOL_VERSION,
  applyShallowPatch,
  assertCommit,
  assertResyncResult,
  assertSnapshot,
  hasShallowChanges,
  type Commit,
  type ConnectRequest,
  type ResyncRequest,
  type Snapshot,
  type StateListener,
  type Unsubscribe,
} from "@electron-sync-store/core";

import {
  createPreloadRendererTransport,
  type RendererTransport,
} from "./transport.js";

export type RendererSyncStatus =
  | "connecting"
  | "synced"
  | "resyncing"
  | "error"
  | "destroyed";

export interface RendererSyncState {
  readonly clientId: string;
  readonly serverEpoch: string | null;
  readonly revision: number | null;
  readonly pendingMutations: 0;
  readonly status: RendererSyncStatus;
  readonly error: Error | null;
}

export type RendererSyncListener = (
  state: Readonly<RendererSyncState>,
  previousState: Readonly<RendererSyncState>,
) => void;

export interface RendererStore<State extends object> {
  getState(): Readonly<State>;
  subscribe(listener: StateListener<State>): Unsubscribe;
  getSyncState(): Readonly<RendererSyncState>;
  subscribeSync(listener: RendererSyncListener): Unsubscribe;
  destroy(): void;
}

export interface CreateRendererStoreOptions<State extends object> {
  id: string;
  transport?: RendererTransport<State>;
  signal?: AbortSignal;
}

function createAbortError(): Error {
  const error = new Error("Renderer store initialization was aborted");
  error.name = "AbortError";
  return error;
}

function createClientId(): string {
  if (globalThis.crypto?.randomUUID === undefined) {
    throw new Error("crypto.randomUUID() is required to create a renderer store");
  }
  return globalThis.crypto.randomUUID();
}

export async function createRendererStore<State extends object>(
  options: CreateRendererStoreOptions<State>,
): Promise<RendererStore<State>> {
  if (typeof options.id !== "string" || options.id.trim().length === 0) {
    throw new TypeError("Renderer store id must be a non-empty string");
  }

  const transport =
    options.transport ?? createPreloadRendererTransport<State>();
  const clientId = createClientId();
  const stateListeners = new Set<StateListener<State>>();
  const syncListeners = new Set<RendererSyncListener>();
  const bufferedCommits: Commit<State>[] = [];
  let canonicalState: State | undefined;
  let syncState: RendererSyncState = {
    clientId,
    serverEpoch: null,
    revision: null,
    pendingMutations: 0,
    status: "connecting",
    error: null,
  };
  let initializing = true;
  let destroyed = false;
  let initializationError: Error | undefined;

  function assertActive(operation: string): void {
    if (destroyed) {
      throw new Error(`Cannot ${operation}: renderer store "${options.id}" is destroyed`);
    }
  }

  function updateSyncState(
    update: Partial<Omit<RendererSyncState, "clientId" | "pendingMutations">>,
  ): void {
    const nextState: RendererSyncState = { ...syncState, ...update };
    if (
      nextState.serverEpoch === syncState.serverEpoch &&
      nextState.revision === syncState.revision &&
      nextState.status === syncState.status &&
      nextState.error === syncState.error
    ) {
      return;
    }
    const previousState = syncState;
    syncState = nextState;
    for (const listener of [...syncListeners]) {
      listener(syncState, previousState);
    }
  }

  function toError(error: unknown, fallback: string): Error {
    return error instanceof Error ? error : new Error(fallback);
  }

  function transitionToError(error: unknown): void {
    updateSyncState({
      status: "error",
      error: toError(error, "Renderer synchronization failed"),
    });
  }

  function validateSnapshot(snapshot: unknown): asserts snapshot is Snapshot<State> {
    assertSnapshot<State>(snapshot);
    if (snapshot.storeId !== options.id) {
      throw new Error(
        `Snapshot store ID "${snapshot.storeId}" does not match "${options.id}"`,
      );
    }
  }

  function establishSnapshot(snapshot: Snapshot<State>): void {
    canonicalState = { ...snapshot.state } as State;
    updateSyncState({
      serverEpoch: snapshot.serverEpoch,
      revision: snapshot.revision,
      error: null,
    });
  }

  function applyCommit(commit: Commit<State>): void {
    if (canonicalState === undefined || syncState.revision === null) {
      throw new Error("Cannot apply a commit before renderer hydration");
    }

    const previousState = canonicalState;
    const stateChanged = hasShallowChanges<State>(canonicalState, commit.patch);
    if (stateChanged) {
      canonicalState = applyShallowPatch<State>(canonicalState, commit.patch);
    }
    updateSyncState({ revision: commit.revision });
    if (stateChanged) {
      for (const listener of [...stateListeners]) {
        listener(canonicalState, previousState);
      }
    }
  }

  function validateCommit(message: unknown): Commit<State> {
    assertCommit<State>(message);
    if (message.storeId !== options.id) {
      throw new Error(
        `Commit store ID "${message.storeId}" does not match "${options.id}"`,
      );
    }
    return message;
  }

  function handleLiveCommit(commit: Commit<State>): void {
    if (syncState.serverEpoch !== commit.serverEpoch) {
      transitionToError(new Error("Commit server epoch does not match renderer epoch"));
      return;
    }
    if (syncState.revision === null) {
      transitionToError(new Error("Renderer canonical revision is unavailable"));
      return;
    }
    if (commit.revision <= syncState.revision) {
      return;
    }
    if (commit.revision !== syncState.revision + 1) {
      transitionToError(
        new Error(
          `Commit revision gap: expected ${syncState.revision + 1}, received ${commit.revision}`,
        ),
      );
      return;
    }
    applyCommit(commit);
  }

  function receiveCommit(message: unknown): void {
    if (destroyed) {
      return;
    }
    try {
      const commit = validateCommit(message);
      if (initializing) {
        bufferedCommits.push(commit);
      } else {
        handleLiveCommit(commit);
      }
    } catch (error) {
      if (initializing) {
        initializationError = toError(error, "Invalid initialization commit");
      } else {
        transitionToError(error);
      }
    }
  }

  function needsInitialResync(batch: Commit<State>[]): boolean {
    if (syncState.serverEpoch === null || syncState.revision === null) {
      return true;
    }
    if (batch.some((commit) => commit.serverEpoch !== syncState.serverEpoch)) {
      return true;
    }

    batch.sort((left, right) => left.revision - right.revision);
    for (const commit of batch) {
      if (commit.revision <= syncState.revision) {
        continue;
      }
      if (commit.revision !== syncState.revision + 1) {
        return true;
      }
      applyCommit(commit);
    }
    return false;
  }

  async function reconcileInitializationBuffer(): Promise<void> {
    while (true) {
      if (destroyed) {
        throw createAbortError();
      }
      if (initializationError !== undefined) {
        throw initializationError;
      }

      const batch = bufferedCommits.splice(0);
      if (!needsInitialResync(batch)) {
        if (bufferedCommits.length === 0) {
          return;
        }
        continue;
      }

      updateSyncState({ status: "resyncing", error: null });
      const request: ResyncRequest = {
        protocolVersion: PROTOCOL_VERSION,
        storeId: options.id,
        clientId,
        serverEpoch: syncState.serverEpoch ?? "unknown",
        knownRevision: syncState.revision ?? 0,
        pendingMutationIds: [],
      };
      const result = await transport.resync(request);
      if (destroyed) {
        throw createAbortError();
      }
      assertResyncResult<State>(result);
      if ("type" in result) {
        throw new Error(`Initial resync rejected: ${result.code}: ${result.message}`);
      }
      validateSnapshot(result.snapshot);
      establishSnapshot(result.snapshot);
    }
  }

  function getState(): Readonly<State> {
    assertActive("get state");
    if (canonicalState === undefined) {
      throw new Error(`Renderer store "${options.id}" is not hydrated`);
    }
    return canonicalState;
  }

  function subscribe(listener: StateListener<State>): Unsubscribe {
    assertActive("subscribe");
    stateListeners.add(listener);
    return () => {
      stateListeners.delete(listener);
    };
  }

  function getSyncState(): Readonly<RendererSyncState> {
    return syncState;
  }

  function subscribeSync(listener: RendererSyncListener): Unsubscribe {
    assertActive("subscribe to synchronization state");
    syncListeners.add(listener);
    return () => {
      syncListeners.delete(listener);
    };
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    initializing = false;
    bufferedCommits.length = 0;
    options.signal?.removeEventListener("abort", destroy);
    transport.disconnect();
    updateSyncState({ status: "destroyed", error: null });
    stateListeners.clear();
    syncListeners.clear();
  }

  const store: RendererStore<State> = {
    getState,
    subscribe,
    getSyncState,
    subscribeSync,
    destroy,
  };

  if (options.signal?.aborted === true) {
    destroy();
    throw createAbortError();
  }
  options.signal?.addEventListener("abort", destroy, { once: true });

  const connectRequest: ConnectRequest = {
    protocolVersion: PROTOCOL_VERSION,
    storeId: options.id,
    clientId,
  };

  try {
    const snapshot = await transport.connect(connectRequest, receiveCommit);
    if (destroyed) {
      throw createAbortError();
    }
    validateSnapshot(snapshot);
    establishSnapshot(snapshot);
    await reconcileInitializationBuffer();
    if (destroyed) {
      throw createAbortError();
    }
    initializing = false;
    updateSyncState({ status: "synced", error: null });
    return store;
  } catch (error) {
    if (!destroyed) {
      initializing = false;
      bufferedCommits.length = 0;
      transport.disconnect();
      transitionToError(error);
    }
    throw error;
  }
}
