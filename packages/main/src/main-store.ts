import { randomUUID } from "node:crypto";

import {
  PROTOCOL_VERSION,
  applyShallowPatch,
  assertMutationRequest,
  assertResyncRequest,
  assertSerializableRecord,
  hasShallowChanges,
  type Commit,
  type MutationNoop,
  type MutationRejection,
  type MutationRequest,
  type MutationResult,
  type ResyncRequest,
  type ResyncResponse,
  type SerializableShape,
  type SetStateAction,
  type Snapshot,
  type StateListener,
  type StatePatch,
  type Store,
  type Unsubscribe,
} from "@electron-sync-store/core";

export type CommitListener<State extends object> = (
  commit: Commit<State>,
) => void;

export interface MainStoreOptions<State extends object> {
  onCommit?: CommitListener<State>;
}

export interface MainStore<State extends object> extends Store<State> {
  readonly storeId: string;
  getRevision(): number;
  getServerEpoch(): string;
  getSnapshot(): Snapshot<State>;
  handleMutation(request: unknown): MutationResult<State>;
  handleResync(request: unknown): ResyncResponse<State>;
  subscribeCommits(listener: CommitListener<State>): Unsubscribe;
  isDestroyed(): boolean;
  destroy(): void;
}

interface MutationIdentity {
  storeId: string;
  clientId: string;
  mutationId: string;
}

function assertStoreId(storeId: string): void {
  if (storeId.trim().length === 0) {
    throw new TypeError("storeId must be a non-empty string");
  }
}

function readMutationIdentity(
  request: unknown,
  fallbackStoreId: string,
): MutationIdentity {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("mutation request must be an object");
  }

  const candidate = request as Record<string, unknown>;
  if (typeof candidate.clientId !== "string" || candidate.clientId.trim() === "") {
    throw new TypeError("mutation request must contain a non-empty clientId");
  }
  if (
    typeof candidate.mutationId !== "string" ||
    candidate.mutationId.trim() === ""
  ) {
    throw new TypeError("mutation request must contain a non-empty mutationId");
  }

  return {
    storeId:
      typeof candidate.storeId === "string" && candidate.storeId.trim() !== ""
        ? candidate.storeId
        : fallbackStoreId,
    clientId: candidate.clientId,
    mutationId: candidate.mutationId,
  };
}

export function createMainStore<State extends object>(
  storeId: string,
  initialState: State & SerializableShape<State>,
  options: MainStoreOptions<State> = {},
): MainStore<State> {
  assertStoreId(storeId);
  assertSerializableRecord(initialState, "initialState");

  const serverEpoch = randomUUID();
  let revision = 0;
  let state = { ...initialState } as State;
  let destroyed = false;
  const stateListeners = new Set<StateListener<State>>();
  const commitListeners = new Set<CommitListener<State>>();
  const processedOutcomes = new Map<string, Commit<State> | MutationNoop>();
  const commitQueue: Commit<State>[] = [];
  let notifyingStateListeners = 0;
  let flushingCommits = false;

  if (options.onCommit !== undefined) {
    commitListeners.add(options.onCommit);
  }

  function assertActive(operation: string): void {
    if (destroyed) {
      throw new Error(`Cannot ${operation}: store "${storeId}" is destroyed`);
    }
  }

  function emitCommit(commit: Commit<State>): void {
    for (const listener of [...commitListeners]) {
      listener(commit);
    }
  }

  function flushCommits(): void {
    if (notifyingStateListeners > 0 || flushingCommits) {
      return;
    }

    flushingCommits = true;
    try {
      while (commitQueue.length > 0) {
        emitCommit(commitQueue.shift() as Commit<State>);
      }
    } finally {
      flushingCommits = false;
    }
  }

  function applyCanonicalPatch(
    patch: StatePatch<State>,
    sourceClientId: string,
    mutationId: string,
    rememberOutcome = false,
  ): Commit<State> | undefined {
    if (!hasShallowChanges<State>(state, patch)) {
      return undefined;
    }

    const previousState = state;
    state = applyShallowPatch<State>(state, patch);
    revision += 1;

    const commit: Commit<State> = {
      type: "commit",
      protocolVersion: PROTOCOL_VERSION,
      storeId,
      serverEpoch,
      sourceClientId,
      mutationId,
      revision,
      patch: { ...patch },
    };

    if (rememberOutcome) {
      processedOutcomes.set(mutationId, commit);
    }
    commitQueue.push(commit);

    notifyingStateListeners += 1;
    try {
      for (const listener of [...stateListeners]) {
        listener(state, previousState);
      }
    } finally {
      notifyingStateListeners -= 1;
      flushCommits();
    }

    return commit;
  }

  function getState(): Readonly<State> {
    return state;
  }

  function setState(action: SetStateAction<State>): void {
    assertActive("set state");
    const patch = typeof action === "function" ? action(state) : action;
    assertSerializableRecord(patch, "patch");
    if (!hasShallowChanges<State>(state, patch)) {
      return;
    }
    applyCanonicalPatch(patch, "main", randomUUID());
  }

  function subscribe(listener: StateListener<State>): Unsubscribe {
    assertActive("subscribe");
    stateListeners.add(listener);
    return () => {
      stateListeners.delete(listener);
    };
  }

  function subscribeCommits(listener: CommitListener<State>): Unsubscribe {
    assertActive("subscribe to commits");
    commitListeners.add(listener);
    return () => {
      commitListeners.delete(listener);
    };
  }

  function reject(
    identity: MutationIdentity,
    code: MutationRejection["code"],
    message: string,
    retryable: boolean,
    includeStorePosition = true,
  ): MutationRejection {
    return {
      type: "rejected",
      protocolVersion: PROTOCOL_VERSION,
      storeId: identity.storeId,
      serverEpoch: includeStorePosition ? serverEpoch : null,
      clientId: identity.clientId,
      mutationId: identity.mutationId,
      revision: includeStorePosition ? revision : null,
      code,
      message,
      retryable,
    };
  }

  function handleMutation(request: unknown): MutationResult<State> {
    const identity = readMutationIdentity(request, storeId);

    try {
      assertMutationRequest<State>(request);
    } catch (error) {
      return reject(
        identity,
        "invalid-mutation",
        error instanceof Error ? error.message : "Invalid mutation request",
        false,
      );
    }

    if (request.storeId !== storeId) {
      return reject(
        identity,
        "unknown-store",
        `Store "${request.storeId}" is not registered here`,
        false,
        false,
      );
    }

    if (destroyed) {
      return reject(identity, "store-destroyed", `Store "${storeId}" is destroyed`, false);
    }

    if (request.serverEpoch !== serverEpoch) {
      return reject(
        identity,
        "stale-server-epoch",
        "Mutation targets a stale server epoch",
        true,
      );
    }

    const previousOutcome = processedOutcomes.get(request.mutationId);
    if (previousOutcome !== undefined) {
      return previousOutcome;
    }

    const commit = applyCanonicalPatch(
      request.patch,
      request.clientId,
      request.mutationId,
      true,
    );

    if (commit !== undefined) {
      return commit;
    }

    const noop: MutationNoop = {
      type: "noop",
      protocolVersion: PROTOCOL_VERSION,
      storeId,
      serverEpoch,
      clientId: request.clientId,
      mutationId: request.mutationId,
      revision,
    };
    processedOutcomes.set(request.mutationId, noop);
    return noop;
  }

  function getSnapshot(): Snapshot<State> {
    assertActive("get snapshot");
    return {
      protocolVersion: PROTOCOL_VERSION,
      storeId,
      serverEpoch,
      revision,
      state: { ...state },
    };
  }

  function handleResync(request: unknown): ResyncResponse<State> {
    assertActive("resync");
    assertResyncRequest(request);
    if (request.storeId !== storeId) {
      throw new Error(`Cannot resync unknown store "${request.storeId}"`);
    }

    const appliedMutationIds: string[] = [];
    const noopMutationIds: string[] = [];

    for (const mutationId of request.pendingMutationIds) {
      const outcome = processedOutcomes.get(mutationId);
      if (outcome?.type === "commit") {
        appliedMutationIds.push(mutationId);
      } else if (outcome?.type === "noop") {
        noopMutationIds.push(mutationId);
      }
    }

    return {
      snapshot: getSnapshot(),
      appliedMutationIds,
      noopMutationIds,
    };
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    stateListeners.clear();
    commitListeners.clear();
  }

  return {
    storeId,
    getState,
    setState,
    subscribe,
    getRevision: () => revision,
    getServerEpoch: () => serverEpoch,
    getSnapshot,
    handleMutation,
    handleResync,
    subscribeCommits,
    isDestroyed: () => destroyed,
    destroy,
  };
}
