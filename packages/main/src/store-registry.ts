import {
  PROTOCOL_VERSION,
  assertMutationRequest,
  assertResyncRequest,
  type MutationRejection,
  type MutationResult,
  type ResyncResult,
  type SerializableShape,
} from "@electron-sync-store/core";

import {
  createMainStore,
  type MainStore,
  type MainStoreOptions,
} from "./main-store.js";

type ErasedMainStore = MainStore<object>;

interface RoutingIdentity {
  storeId: string;
  clientId: string;
  mutationId: string;
}

export interface MainStoreRegistry {
  createStore<State extends object>(
    storeId: string,
    initialState: State & SerializableShape<State>,
    options?: MainStoreOptions<State>,
  ): MainStore<State>;
  registerStore<State extends object>(store: MainStore<State>): MainStore<State>;
  getStore<State extends object = object>(
    storeId: string,
  ): MainStore<State> | undefined;
  handleMutation<State extends object>(request: unknown): MutationResult<State>;
  handleResync<State extends object>(request: unknown): ResyncResult<State>;
}

function requireRoutingString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function readMutationRoutingIdentity(request: unknown): RoutingIdentity {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("mutation request must be an object");
  }

  const candidate = request as Record<string, unknown>;
  requireRoutingString(candidate.storeId, "mutationRequest.storeId");
  requireRoutingString(candidate.clientId, "mutationRequest.clientId");
  requireRoutingString(candidate.mutationId, "mutationRequest.mutationId");

  return {
    storeId: candidate.storeId,
    clientId: candidate.clientId,
    mutationId: candidate.mutationId,
  };
}

function createRoutingRejection(
  identity: RoutingIdentity,
  code: "invalid-mutation" | "unknown-store",
  message: string,
): MutationRejection {
  return {
    type: "rejected",
    protocolVersion: PROTOCOL_VERSION,
    storeId: identity.storeId,
    serverEpoch: null,
    clientId: identity.clientId,
    mutationId: identity.mutationId,
    revision: null,
    code,
    message,
    retryable: false,
  };
}

export function createElectronSyncMain(): MainStoreRegistry {
  const stores = new Map<string, ErasedMainStore>();

  function registerStore<State extends object>(
    store: MainStore<State>,
  ): MainStore<State> {
    if (store.isDestroyed()) {
      throw new Error(`Cannot register destroyed store "${store.storeId}"`);
    }
    if (stores.has(store.storeId)) {
      throw new Error(`Store "${store.storeId}" is already registered`);
    }

    stores.set(store.storeId, store as unknown as ErasedMainStore);
    return store;
  }

  function createStore<State extends object>(
    storeId: string,
    initialState: State & SerializableShape<State>,
    options?: MainStoreOptions<State>,
  ): MainStore<State> {
    if (stores.has(storeId)) {
      throw new Error(`Store "${storeId}" is already registered`);
    }

    return registerStore(createMainStore<State>(storeId, initialState, options));
  }

  function getStore<State extends object = object>(
    storeId: string,
  ): MainStore<State> | undefined {
    return stores.get(storeId) as unknown as MainStore<State> | undefined;
  }

  function handleMutation<State extends object>(
    request: unknown,
  ): MutationResult<State> {
    const identity = readMutationRoutingIdentity(request);
    const store = stores.get(identity.storeId);

    if (store !== undefined) {
      return store.handleMutation(request) as MutationResult<State>;
    }

    try {
      assertMutationRequest<State>(request);
    } catch (error) {
      return createRoutingRejection(
        identity,
        "invalid-mutation",
        error instanceof Error ? error.message : "Invalid mutation request",
      );
    }

    return createRoutingRejection(
      identity,
      "unknown-store",
      `Store "${identity.storeId}" is not registered`,
    );
  }

  function handleResync<State extends object>(request: unknown): ResyncResult<State> {
    assertResyncRequest(request);
    const store = stores.get(request.storeId);

    if (store !== undefined) {
      return store.handleResync(request) as ResyncResult<State>;
    }

    return {
      type: "rejected",
      protocolVersion: PROTOCOL_VERSION,
      storeId: request.storeId,
      serverEpoch: null,
      clientId: request.clientId,
      mutationId: null,
      revision: null,
      code: "unknown-store",
      message: `Store "${request.storeId}" is not registered`,
      retryable: false,
    };
  }

  return {
    createStore,
    registerStore,
    getStore,
    handleMutation,
    handleResync,
  };
}
