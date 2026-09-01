import {
  PROTOCOL_VERSION,
  applyShallowPatch,
  assertCommit,
  assertMutationResult,
  assertResyncResult,
  assertSerializableRecord,
  assertSnapshot,
  hasShallowChanges,
  type Commit,
  type ConnectRequest,
  type MutationNoop,
  type MutationRejection,
  type MutationRequest,
  type MutationResult,
  type ResyncRequest,
  type SetStateAction,
  type Snapshot,
  type StateListener,
  type StatePatch,
  type StateUpdater,
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
  readonly pendingMutations: number;
  readonly status: RendererSyncStatus;
  readonly error: Error | null;
}

export type RendererSyncListener = (
  state: Readonly<RendererSyncState>,
  previousState: Readonly<RendererSyncState>,
) => void;

export interface RendererStore<State extends object> {
  getState(): Readonly<State>;
  setState(patch: StatePatch<State>): void;
  setState(updater: StateUpdater<State>): void;
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

interface PendingMutation<State extends object> {
  readonly mutationId: string;
  readonly patch: StatePatch<State>;
  readonly baseRevision: number;
}

interface SyncTransition {
  readonly previousState: RendererSyncState;
  readonly changed: boolean;
}

function createAbortError(): Error {
  const error = new Error("Renderer store initialization was aborted");
  error.name = "AbortError";
  return error;
}

function createUuid(label: string): string {
  if (globalThis.crypto?.randomUUID === undefined) {
    throw new Error(`crypto.randomUUID() is required to create ${label}`);
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
  const clientId = createUuid("a renderer store");
  const stateListeners = new Set<StateListener<State>>();
  const syncListeners = new Set<RendererSyncListener>();
  const bufferedCommits: Commit<State>[] = [];
  const pendingMutations: PendingMutation<State>[] = [];
  const submissionQueue: MutationRequest<State>[] = [];
  let canonicalState: State | undefined;
  let visibleState: State | undefined;
  let syncState: RendererSyncState = {
    clientId,
    serverEpoch: null,
    revision: null,
    pendingMutations: 0,
    status: "connecting",
    error: null,
  };
  let localSetDepth = 0;
  let drainingSubmissions = false;
  let initializing = true;
  let destroyed = false;
  let initializationError: Error | undefined;

  function assertActive(operation: string): void {
    if (destroyed) {
      throw new Error(`Cannot ${operation}: renderer store "${options.id}" is destroyed`);
    }
  }

  function replaceSyncState(
    update: Partial<Omit<RendererSyncState, "clientId">>,
  ): SyncTransition {
    const previousState = syncState;
    const nextState: RendererSyncState = { ...syncState, ...update };
    const changed =
      nextState.serverEpoch !== previousState.serverEpoch ||
      nextState.revision !== previousState.revision ||
      nextState.pendingMutations !== previousState.pendingMutations ||
      nextState.status !== previousState.status ||
      nextState.error !== previousState.error;
    if (changed) {
      syncState = nextState;
    }
    return { previousState, changed };
  }

  function notifySync(transition: SyncTransition): void {
    if (!transition.changed) {
      return;
    }
    for (const listener of [...syncListeners]) {
      listener(syncState, transition.previousState);
    }
  }

  function updateSyncState(
    update: Partial<Omit<RendererSyncState, "clientId">>,
  ): void {
    notifySync(replaceSyncState(update));
  }

  function notifyState(nextState: State, previousState: State): void {
    for (const listener of [...stateListeners]) {
      listener(nextState, previousState);
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
    visibleState = canonicalState;
    updateSyncState({
      serverEpoch: snapshot.serverEpoch,
      revision: snapshot.revision,
      pendingMutations: pendingMutations.length,
      error: null,
    });
  }

  function rebuildVisibleState(): State {
    if (canonicalState === undefined) {
      throw new Error("Cannot rebuild visible state before renderer hydration");
    }

    let nextState = canonicalState;
    for (const pendingMutation of pendingMutations) {
      nextState = applyShallowPatch(nextState, pendingMutation.patch);
    }
    return nextState;
  }

  function removePendingMutation(mutationId: string): boolean {
    const index = pendingMutations.findIndex(
      (pendingMutation) => pendingMutation.mutationId === mutationId,
    );
    if (index === -1) {
      return false;
    }
    pendingMutations.splice(index, 1);
    return true;
  }

  function finishReconciliation(
    previousVisibleState: State,
    syncUpdate: Partial<Omit<RendererSyncState, "clientId">>,
  ): void {
    const rebuiltState = rebuildVisibleState();
    const stateChanged = hasShallowChanges(previousVisibleState, rebuiltState);
    if (stateChanged) {
      visibleState = rebuiltState;
    }
    const syncTransition = replaceSyncState({
      ...syncUpdate,
      pendingMutations: pendingMutations.length,
    });

    // Both state replicas and synchronization metadata are complete before
    // either user callback observes the transition.
    notifySync(syncTransition);
    if (stateChanged) {
      notifyState(visibleState as State, previousVisibleState);
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

  function processCanonicalCommit(commit: Commit<State>): void {
    if (canonicalState === undefined || visibleState === undefined) {
      throw new Error("Cannot apply a commit before renderer hydration");
    }
    if (syncState.serverEpoch !== commit.serverEpoch) {
      transitionToError(new Error("Commit server epoch does not match renderer epoch"));
      return;
    }
    if (syncState.revision === null) {
      transitionToError(new Error("Renderer canonical revision is unavailable"));
      return;
    }

    if (commit.revision <= syncState.revision) {
      if (removePendingMutation(commit.mutationId)) {
        finishReconciliation(visibleState, {});
      }
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

    const previousVisibleState = visibleState;
    canonicalState = applyShallowPatch(canonicalState, commit.patch);
    removePendingMutation(commit.mutationId);
    finishReconciliation(previousVisibleState, { revision: commit.revision });
  }

  function assertResultIdentity(
    result: MutationNoop | MutationRejection,
    mutationId: string,
  ): void {
    if (result.storeId !== options.id) {
      throw new Error(
        `Mutation result store ID "${result.storeId}" does not match "${options.id}"`,
      );
    }
    if (result.clientId !== clientId) {
      throw new Error("Mutation result client ID does not match renderer client ID");
    }
    if (result.mutationId !== mutationId) {
      throw new Error("Mutation result ID does not match the submitted mutation");
    }
  }

  function processNoop(result: MutationNoop, mutationId: string): void {
    assertResultIdentity(result, mutationId);
    if (result.serverEpoch !== syncState.serverEpoch) {
      throw new Error("Mutation no-op server epoch does not match renderer epoch");
    }
    if (visibleState === undefined || !removePendingMutation(mutationId)) {
      return;
    }
    finishReconciliation(visibleState, {});
  }

  function processRejection(
    result: MutationRejection,
    mutationId: string,
  ): void {
    assertResultIdentity(result, mutationId);
    if (
      result.code !== "stale-server-epoch" &&
      result.serverEpoch !== null &&
      result.serverEpoch !== syncState.serverEpoch
    ) {
      throw new Error("Mutation rejection server epoch does not match renderer epoch");
    }
    if (visibleState !== undefined && removePendingMutation(mutationId)) {
      finishReconciliation(visibleState, {});
    }
    if (result.code === "stale-server-epoch") {
      transitionToError(
        new Error(`Mutation rejected because the server epoch is stale: ${result.message}`),
      );
    }
  }

  function processMutationResult(
    result: unknown,
    mutationId: string,
  ): void {
    if (destroyed) {
      return;
    }
    assertMutationResult<State>(result);
    switch (result.type) {
      case "commit":
        if (result.mutationId !== mutationId) {
          throw new Error("Commit mutation ID does not match the submitted mutation");
        }
        processCanonicalCommit(validateCommit(result));
        break;
      case "noop":
        processNoop(result, mutationId);
        break;
      case "rejected":
        processRejection(result, mutationId);
        break;
    }
  }

  function handleMutationFailure(error: unknown, mutationId: string): void {
    if (
      destroyed ||
      !pendingMutations.some(
        (pendingMutation) => pendingMutation.mutationId === mutationId,
      )
    ) {
      return;
    }
    transitionToError(
      toError(error, `Mutation "${mutationId}" transport request failed`),
    );
  }

  function submit(request: MutationRequest<State>): void {
    try {
      void transport.mutate(request).then(
        (result) => {
          try {
            processMutationResult(result, request.mutationId);
          } catch (error) {
            if (!destroyed) {
              transitionToError(error);
            }
          }
        },
        (error) => {
          handleMutationFailure(error, request.mutationId);
        },
      );
    } catch (error) {
      handleMutationFailure(error, request.mutationId);
    }
  }

  function drainSubmissionQueue(): void {
    if (drainingSubmissions || localSetDepth !== 0 || destroyed) {
      return;
    }
    drainingSubmissions = true;
    try {
      while (submissionQueue.length > 0 && !destroyed) {
        const request = submissionQueue.shift();
        if (request !== undefined) {
          submit(request);
        }
      }
    } finally {
      drainingSubmissions = false;
    }
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
        processCanonicalCommit(commit);
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
      processCanonicalCommit(commit);
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
    if (visibleState === undefined) {
      throw new Error(`Renderer store "${options.id}" is not hydrated`);
    }
    return visibleState;
  }

  function setState(patch: StatePatch<State>): void;
  function setState(updater: StateUpdater<State>): void;
  function setState(action: SetStateAction<State>): void {
    assertActive("set state");
    if (syncState.status !== "synced") {
      throw new Error(
        `Cannot set state while renderer store "${options.id}" is ${syncState.status}`,
      );
    }
    if (
      visibleState === undefined ||
      syncState.serverEpoch === null ||
      syncState.revision === null
    ) {
      throw new Error(`Renderer store "${options.id}" is not hydrated`);
    }

    const candidatePatch =
      typeof action === "function" ? action(visibleState) : action;
    assertSerializableRecord(candidatePatch, "renderer state patch");
    const patch = { ...candidatePatch } as StatePatch<State>;
    if (!hasShallowChanges(visibleState, patch)) {
      return;
    }

    const mutationId = createUuid("a renderer mutation");
    const baseRevision = syncState.revision;
    const pendingMutation: PendingMutation<State> = {
      mutationId,
      patch,
      baseRevision,
    };
    const request: MutationRequest<State> = {
      protocolVersion: PROTOCOL_VERSION,
      storeId: options.id,
      serverEpoch: syncState.serverEpoch,
      clientId,
      mutationId,
      baseRevision,
      patch,
    };

    const previousVisibleState = visibleState;
    pendingMutations.push(pendingMutation);
    submissionQueue.push(request);
    visibleState = applyShallowPatch(visibleState, patch);
    const syncTransition = replaceSyncState({
      pendingMutations: pendingMutations.length,
    });

    localSetDepth += 1;
    try {
      notifySync(syncTransition);
      notifyState(visibleState, previousVisibleState);
    } finally {
      localSetDepth -= 1;
      drainSubmissionQueue();
    }
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
    pendingMutations.length = 0;
    submissionQueue.length = 0;
    options.signal?.removeEventListener("abort", destroy);
    transport.disconnect();
    updateSyncState({
      pendingMutations: 0,
      status: "destroyed",
      error: null,
    });
    stateListeners.clear();
    syncListeners.clear();
  }

  const store: RendererStore<State> = {
    getState,
    setState,
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
