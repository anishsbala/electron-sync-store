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
  type ResyncRequest,
  type ResyncResponse,
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

const DEFAULT_MAX_MUTATION_ATTEMPTS = 3;
const DEFAULT_MAX_RESYNC_ATTEMPTS = 3;
const DEFAULT_MAX_PENDING_MUTATIONS = 1_000;
const DEFAULT_MAX_BUFFERED_COMMITS = 256;

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
  flush(): Promise<void>;
  destroy(): void;
}

export interface CreateRendererStoreOptions<State extends object> {
  id: string;
  transport?: RendererTransport<State>;
  signal?: AbortSignal;
  maxMutationAttempts?: number;
  maxResyncAttempts?: number;
  maxPendingMutations?: number;
  maxBufferedCommits?: number;
}

type MutationSubmissionState = "queued" | "in-flight" | "uncertain";

interface PendingMutation<State extends object> {
  readonly mutationId: string;
  readonly patch: StatePatch<State>;
  baseRevision: number;
  serverEpoch: string;
  submissionAttempts: number;
  submissionState: MutationSubmissionState;
}

interface SyncTransition {
  readonly previousState: RendererSyncState;
  readonly changed: boolean;
}

interface FlushWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

type CommitDisposition = "applied" | "stale" | "gap" | "epoch-mismatch";

class MutationAttemptsExhaustedError extends Error {
  override readonly name = "MutationAttemptsExhaustedError";
}

function createAbortError(): Error {
  const error = new Error("Renderer store initialization was aborted");
  error.name = "AbortError";
  return error;
}

function createDestroyedError(storeId: string): Error {
  return new Error(`Renderer store "${storeId}" was destroyed before synchronization settled`);
}

function createUuid(label: string): string {
  if (globalThis.crypto?.randomUUID === undefined) {
    throw new Error(`crypto.randomUUID() is required to create ${label}`);
  }
  return globalThis.crypto.randomUUID();
}

function readLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return limit;
}

export async function createRendererStore<State extends object>(
  options: CreateRendererStoreOptions<State>,
): Promise<RendererStore<State>> {
  if (typeof options.id !== "string" || options.id.trim().length === 0) {
    throw new TypeError("Renderer store id must be a non-empty string");
  }

  const maxMutationAttempts = readLimit(
    options.maxMutationAttempts,
    DEFAULT_MAX_MUTATION_ATTEMPTS,
    "maxMutationAttempts",
  );
  const maxResyncAttempts = readLimit(
    options.maxResyncAttempts,
    DEFAULT_MAX_RESYNC_ATTEMPTS,
    "maxResyncAttempts",
  );
  const maxPendingMutations = readLimit(
    options.maxPendingMutations,
    DEFAULT_MAX_PENDING_MUTATIONS,
    "maxPendingMutations",
  );
  const maxBufferedCommits = readLimit(
    options.maxBufferedCommits,
    DEFAULT_MAX_BUFFERED_COMMITS,
    "maxBufferedCommits",
  );
  const transport = options.transport ?? createPreloadRendererTransport<State>();
  const clientId = createUuid("a renderer store");
  const stateListeners = new Set<StateListener<State>>();
  const syncListeners = new Set<RendererSyncListener>();
  const flushWaiters = new Set<FlushWaiter>();
  const bufferedCommits: Commit<State>[] = [];
  const pendingMutations: PendingMutation<State>[] = [];
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
  let commitBufferOverflowed = false;
  let recoveryPromise: Promise<void> | null = null;

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

  function rejectFlushWaiters(error: Error): void {
    for (const waiter of [...flushWaiters]) {
      waiter.reject(error);
    }
    flushWaiters.clear();
  }

  function isSettled(): boolean {
    return (
      !destroyed &&
      syncState.status === "synced" &&
      pendingMutations.length === 0 &&
      recoveryPromise === null
    );
  }

  function settleFlushWaiters(): void {
    if (!isSettled()) {
      return;
    }
    for (const waiter of [...flushWaiters]) {
      waiter.resolve();
    }
    flushWaiters.clear();
  }

  function transitionToError(error: unknown): void {
    if (destroyed) {
      return;
    }
    const terminalError = toError(error, "Renderer synchronization failed");
    updateSyncState({ status: "error", error: terminalError });
    rejectFlushWaiters(terminalError);
  }

  function validateSnapshot(snapshot: unknown): asserts snapshot is Snapshot<State> {
    assertSnapshot<State>(snapshot);
    if (snapshot.storeId !== options.id) {
      throw new Error(
        `Snapshot store ID "${snapshot.storeId}" does not match "${options.id}"`,
      );
    }
  }

  function establishInitialSnapshot(snapshot: Snapshot<State>): void {
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

  function findPendingMutation(mutationId: string): PendingMutation<State> | undefined {
    return pendingMutations.find(
      (pendingMutation) => pendingMutation.mutationId === mutationId,
    );
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

    notifySync(syncTransition);
    if (stateChanged) {
      notifyState(visibleState as State, previousVisibleState);
    }
    settleFlushWaiters();
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

  function applyCanonicalCommit(commit: Commit<State>): CommitDisposition {
    if (canonicalState === undefined || visibleState === undefined) {
      throw new Error("Cannot apply a commit before renderer hydration");
    }
    if (syncState.serverEpoch !== commit.serverEpoch) {
      return "epoch-mismatch";
    }
    if (syncState.revision === null) {
      throw new Error("Renderer canonical revision is unavailable");
    }
    if (commit.revision <= syncState.revision) {
      if (removePendingMutation(commit.mutationId)) {
        finishReconciliation(visibleState, {});
      }
      return "stale";
    }
    if (commit.revision !== syncState.revision + 1) {
      return "gap";
    }

    const previousVisibleState = visibleState;
    canonicalState = applyShallowPatch(canonicalState, commit.patch);
    removePendingMutation(commit.mutationId);
    finishReconciliation(previousVisibleState, { revision: commit.revision });
    return "applied";
  }

  function bufferCommit(commit: Commit<State>): void {
    if (commitBufferOverflowed) {
      return;
    }
    if (bufferedCommits.length >= maxBufferedCommits) {
      bufferedCommits.length = 0;
      commitBufferOverflowed = true;
      return;
    }
    bufferedCommits.push(commit);
  }

  function processLiveCommit(commit: Commit<State>): void {
    const disposition = applyCanonicalCommit(commit);
    if (disposition === "gap" || disposition === "epoch-mismatch") {
      const pendingMutation = findPendingMutation(commit.mutationId);
      if (pendingMutation !== undefined) {
        pendingMutation.submissionState = "uncertain";
      }
      bufferCommit(commit);
      beginRecovery(
        disposition === "gap"
          ? `Commit revision gap at ${commit.revision}`
          : `Commit uses server epoch "${commit.serverEpoch}"`,
      );
    }
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
      const pendingMutation = findPendingMutation(mutationId);
      if (pendingMutation !== undefined) {
        pendingMutation.submissionState = "uncertain";
      }
      beginRecovery("Mutation no-op uses a different server epoch");
      return;
    }
    if (visibleState === undefined || !removePendingMutation(mutationId)) {
      return;
    }
    finishReconciliation(visibleState, {});
  }

  function processRejection(result: MutationRejection, mutationId: string): void {
    assertResultIdentity(result, mutationId);
    const pendingMutation = findPendingMutation(mutationId);
    if (result.code === "stale-server-epoch") {
      if (pendingMutation !== undefined) {
        pendingMutation.submissionState = "uncertain";
      }
      beginRecovery(`Mutation server epoch is stale: ${result.message}`);
      return;
    }

    if (
      result.serverEpoch !== null &&
      result.serverEpoch !== syncState.serverEpoch
    ) {
      if (pendingMutation !== undefined) {
        pendingMutation.submissionState = "uncertain";
      }
      beginRecovery("Mutation rejection uses a different server epoch");
      return;
    }

    if (visibleState !== undefined && removePendingMutation(mutationId)) {
      finishReconciliation(visibleState, {});
    }
    if (result.code === "store-destroyed") {
      transitionToError(new Error(`Canonical store was destroyed: ${result.message}`));
    } else {
      settleFlushWaiters();
    }
  }

  function processMutationResult(result: unknown, mutationId: string): void {
    if (destroyed) {
      return;
    }
    assertMutationResult<State>(result);
    switch (result.type) {
      case "commit": {
        if (result.mutationId !== mutationId) {
          throw new Error("Commit mutation ID does not match the submitted mutation");
        }
        const commit = validateCommit(result);
        if (syncState.status === "resyncing") {
          const pendingMutation = findPendingMutation(commit.mutationId);
          if (pendingMutation !== undefined) {
            pendingMutation.submissionState = "uncertain";
          }
          bufferCommit(commit);
        } else {
          processLiveCommit(commit);
        }
        break;
      }
      case "noop":
        processNoop(result, mutationId);
        break;
      case "rejected":
        processRejection(result, mutationId);
        break;
    }
  }

  function handleMutationUncertainty(error: unknown, mutationId: string): void {
    if (destroyed) {
      return;
    }
    const pendingMutation = findPendingMutation(mutationId);
    if (pendingMutation === undefined) {
      return;
    }
    pendingMutation.submissionState = "uncertain";
    beginRecovery(
      toError(error, `Mutation "${mutationId}" transport request became uncertain`).message,
    );
  }

  function submitPendingMutation(pendingMutation: PendingMutation<State>): void {
    if (
      destroyed ||
      syncState.status !== "synced" ||
      syncState.serverEpoch === null ||
      syncState.revision === null ||
      pendingMutation.submissionState !== "queued"
    ) {
      return;
    }

    if (pendingMutation.serverEpoch !== syncState.serverEpoch) {
      pendingMutation.serverEpoch = syncState.serverEpoch;
      pendingMutation.baseRevision = syncState.revision;
    }
    pendingMutation.submissionState = "in-flight";
    pendingMutation.submissionAttempts += 1;
    const request: MutationRequest<State> = {
      protocolVersion: PROTOCOL_VERSION,
      storeId: options.id,
      serverEpoch: pendingMutation.serverEpoch,
      clientId,
      mutationId: pendingMutation.mutationId,
      baseRevision: pendingMutation.baseRevision,
      patch: pendingMutation.patch,
    };

    try {
      void transport.mutate(request).then(
        (result) => {
          try {
            processMutationResult(result, request.mutationId);
          } catch (error) {
            handleMutationUncertainty(error, request.mutationId);
          }
        },
        (error) => {
          handleMutationUncertainty(error, request.mutationId);
        },
      );
    } catch (error) {
      handleMutationUncertainty(error, request.mutationId);
    }
  }

  function drainSubmissionQueue(): void {
    if (
      drainingSubmissions ||
      localSetDepth !== 0 ||
      destroyed ||
      syncState.status !== "synced"
    ) {
      return;
    }
    drainingSubmissions = true;
    try {
      for (const pendingMutation of pendingMutations) {
        if (pendingMutation.submissionState === "queued") {
          submitPendingMutation(pendingMutation);
        }
      }
    } finally {
      drainingSubmissions = false;
    }
  }

  function createResyncRequest(): ResyncRequest {
    return {
      protocolVersion: PROTOCOL_VERSION,
      storeId: options.id,
      clientId,
      serverEpoch: syncState.serverEpoch ?? "unknown",
      knownRevision: syncState.revision ?? 0,
      pendingMutationIds: pendingMutations.map(
        (pendingMutation) => pendingMutation.mutationId,
      ),
    };
  }

  function installRecoverySnapshot(response: ResyncResponse<State>): string | null {
    validateSnapshot(response.snapshot);
    if (visibleState === undefined) {
      throw new Error("Cannot install a recovery snapshot before hydration");
    }

    const previousVisibleState = visibleState;
    const previousEpoch = syncState.serverEpoch;
    const appliedIds = new Set(response.appliedMutationIds);
    const noopIds = new Set(response.noopMutationIds);
    canonicalState = { ...response.snapshot.state } as State;

    for (let index = pendingMutations.length - 1; index >= 0; index -= 1) {
      const pendingMutation = pendingMutations[index];
      if (
        pendingMutation !== undefined &&
        (appliedIds.has(pendingMutation.mutationId) ||
          noopIds.has(pendingMutation.mutationId))
      ) {
        pendingMutations.splice(index, 1);
      }
    }

    const epochChanged = previousEpoch !== response.snapshot.serverEpoch;
    for (const pendingMutation of pendingMutations) {
      if (epochChanged || pendingMutation.submissionAttempts === 0) {
        pendingMutation.serverEpoch = response.snapshot.serverEpoch;
        pendingMutation.baseRevision = response.snapshot.revision;
      }
      if (pendingMutation.submissionState === "uncertain") {
        if (pendingMutation.submissionAttempts >= maxMutationAttempts) {
          throw new MutationAttemptsExhaustedError(
            `Mutation "${pendingMutation.mutationId}" remained unresolved after ${pendingMutation.submissionAttempts} attempts`,
          );
        }
        pendingMutation.submissionState = "queued";
      }
    }

    finishReconciliation(previousVisibleState, {
      serverEpoch: response.snapshot.serverEpoch,
      revision: response.snapshot.revision,
      status: "resyncing",
      error: null,
    });
    return previousEpoch;
  }

  function reconcileRecoveryBuffer(previousEpoch: string | null): boolean {
    if (commitBufferOverflowed) {
      commitBufferOverflowed = false;
      bufferedCommits.length = 0;
      return false;
    }
    if (syncState.serverEpoch === null || syncState.revision === null) {
      return false;
    }

    const batch = bufferedCommits.splice(0);
    const sameEpoch: Commit<State>[] = [];
    for (const commit of batch) {
      if (commit.serverEpoch === syncState.serverEpoch) {
        sameEpoch.push(commit);
      } else if (
        previousEpoch === syncState.serverEpoch ||
        commit.serverEpoch !== previousEpoch
      ) {
        bufferCommit(commit);
        return false;
      }
    }
    sameEpoch.sort((left, right) => left.revision - right.revision);
    const seenRevisions = new Map<number, string>();
    for (const commit of sameEpoch) {
      const seenMutationId = seenRevisions.get(commit.revision);
      if (seenMutationId !== undefined) {
        if (seenMutationId !== commit.mutationId) {
          return false;
        }
        continue;
      }
      seenRevisions.set(commit.revision, commit.mutationId);
      if (commit.revision <= syncState.revision) {
        if (visibleState !== undefined && removePendingMutation(commit.mutationId)) {
          finishReconciliation(visibleState, {});
        }
        continue;
      }
      if (commit.revision !== syncState.revision + 1) {
        bufferCommit(commit);
        return false;
      }
      applyCanonicalCommit(commit);
    }
    return true;
  }

  async function runRecovery(): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxResyncAttempts; attempt += 1) {
      if (destroyed) {
        throw createDestroyedError(options.id);
      }
      try {
        const result = await transport.resync(createResyncRequest());
        if (destroyed) {
          throw createDestroyedError(options.id);
        }
        assertResyncResult<State>(result);
        if ("type" in result) {
          throw new Error(`Resync rejected: ${result.code}: ${result.message}`);
        }
        const previousEpoch = installRecoverySnapshot(result);
        if (reconcileRecoveryBuffer(previousEpoch)) {
          return;
        }
        lastError = new Error("Recovery snapshot did not close the buffered commit gap");
      } catch (error) {
        if (destroyed) {
          throw createDestroyedError(options.id);
        }
        if (error instanceof MutationAttemptsExhaustedError) {
          throw error;
        }
        lastError = toError(error, "Renderer resync failed");
      }
    }
    throw new Error(
      `Renderer recovery exhausted ${maxResyncAttempts} resync attempts: ${lastError?.message ?? "unknown failure"}`,
    );
  }

  function beginRecovery(reason: string): void {
    if (destroyed || syncState.status === "error" || initializing) {
      return;
    }
    if (syncState.status !== "resyncing") {
      updateSyncState({ status: "resyncing", error: null });
    }
    if (recoveryPromise !== null) {
      return;
    }

    const recovery = runRecovery();
    recoveryPromise = recovery;
    void recovery.then(
      () => {
        if (destroyed || recoveryPromise !== recovery) {
          return;
        }
        recoveryPromise = null;
        updateSyncState({ status: "synced", error: null });
        drainSubmissionQueue();
        settleFlushWaiters();
      },
      (error) => {
        if (destroyed || recoveryPromise !== recovery) {
          return;
        }
        recoveryPromise = null;
        transitionToError(
          new Error(`Renderer recovery failed after "${reason}": ${toError(error, "unknown recovery failure").message}`),
        );
      },
    );
  }

  function receiveCommit(message: unknown): void {
    if (destroyed) {
      return;
    }
    try {
      const commit = validateCommit(message);
      if (initializing || syncState.status === "resyncing") {
        bufferCommit(commit);
      } else {
        processLiveCommit(commit);
      }
    } catch (error) {
      if (initializing) {
        initializationError = toError(error, "Invalid initialization commit");
      } else {
        beginRecovery(toError(error, "Invalid incoming commit").message);
      }
    }
  }

  function needsInitialResync(batch: Commit<State>[]): boolean {
    if (commitBufferOverflowed) {
      commitBufferOverflowed = false;
      return true;
    }
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
      applyCanonicalCommit(commit);
    }
    return false;
  }

  async function reconcileInitializationBuffer(): Promise<void> {
    let attempts = 0;
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
      attempts += 1;
      if (attempts > maxResyncAttempts) {
        throw new Error(
          `Renderer initialization exhausted ${maxResyncAttempts} resync attempts`,
        );
      }

      updateSyncState({ status: "resyncing", error: null });
      const result = await transport.resync(createResyncRequest());
      if (destroyed) {
        throw createAbortError();
      }
      assertResyncResult<State>(result);
      if ("type" in result) {
        throw new Error(`Initial resync rejected: ${result.code}: ${result.message}`);
      }
      validateSnapshot(result.snapshot);
      establishInitialSnapshot(result.snapshot);
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
    if (syncState.status === "error") {
      throw new Error(`Cannot set state while renderer store "${options.id}" is error`);
    }
    if (
      visibleState === undefined ||
      syncState.serverEpoch === null ||
      syncState.revision === null
    ) {
      throw new Error(`Renderer store "${options.id}" is not hydrated`);
    }

    const candidatePatch = typeof action === "function" ? action(visibleState) : action;
    assertSerializableRecord(candidatePatch, "renderer state patch");
    const patch = { ...candidatePatch } as StatePatch<State>;
    if (!hasShallowChanges(visibleState, patch)) {
      return;
    }
    if (pendingMutations.length >= maxPendingMutations) {
      throw new Error(
        `Renderer store "${options.id}" reached the pending mutation limit of ${maxPendingMutations}`,
      );
    }

    const pendingMutation: PendingMutation<State> = {
      mutationId: createUuid("a renderer mutation"),
      patch,
      baseRevision: syncState.revision,
      serverEpoch: syncState.serverEpoch,
      submissionAttempts: 0,
      submissionState: "queued",
    };
    const previousVisibleState = visibleState;
    pendingMutations.push(pendingMutation);
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

  function flush(): Promise<void> {
    if (destroyed) {
      return Promise.reject(createDestroyedError(options.id));
    }
    if (syncState.status === "error") {
      return Promise.reject(
        syncState.error ?? new Error(`Renderer store "${options.id}" is in an error state`),
      );
    }
    if (isSettled()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      flushWaiters.add({ resolve, reject });
    });
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    initializing = false;
    bufferedCommits.length = 0;
    pendingMutations.length = 0;
    recoveryPromise = null;
    options.signal?.removeEventListener("abort", destroy);
    transport.disconnect();
    updateSyncState({
      pendingMutations: 0,
      status: "destroyed",
      error: null,
    });
    rejectFlushWaiters(createDestroyedError(options.id));
    stateListeners.clear();
    syncListeners.clear();
  }

  const store: RendererStore<State> = {
    getState,
    setState,
    subscribe,
    getSyncState,
    subscribeSync,
    flush,
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
    establishInitialSnapshot(snapshot);
    await reconcileInitializationBuffer();
    if (destroyed) {
      throw createAbortError();
    }
    initializing = false;
    updateSyncState({ status: "synced", error: null });
    settleFlushWaiters();
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
