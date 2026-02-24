import { PROTOCOL_VERSION, type MutationRequest } from "@electron-sync-store/core";
import { describe, expect, it } from "vitest";

import { createElectronSyncMain, createMainStore } from "../src/index.js";

interface AppState {
  counter: number;
  profile: {
    name: string;
  };
}

function createRequest(
  serverEpoch: string,
  patch: Partial<AppState> = { counter: 1 },
): MutationRequest<AppState> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    storeId: "app",
    serverEpoch,
    clientId: "renderer-a",
    mutationId: "mutation-1",
    baseRevision: 0,
    patch,
  };
}

describe("createElectronSyncMain", () => {
  it("creates and retrieves a typed named store", () => {
    const sync = createElectronSyncMain();
    const created = sync.createStore<AppState>("app", {
      counter: 0,
      profile: { name: "Ada" },
    });

    expect(sync.getStore<AppState>("app")).toBe(created);
    expect(sync.getStore("missing")).toBeUndefined();
  });

  it("registers an existing main store", () => {
    const sync = createElectronSyncMain();
    const store = createMainStore<AppState>("app", {
      counter: 0,
      profile: { name: "Ada" },
    });

    expect(sync.registerStore(store)).toBe(store);
    expect(sync.getStore("app")).toBe(store);
  });

  it("rejects duplicate store IDs", () => {
    const sync = createElectronSyncMain();
    sync.createStore("app", { counter: 0 });

    expect(() => sync.createStore("app", { counter: 1 })).toThrow(
      /already registered/u,
    );
  });

  it("rejects registration of a destroyed store", () => {
    const sync = createElectronSyncMain();
    const store = createMainStore("app", { counter: 0 });
    store.destroy();

    expect(() => sync.registerStore(store)).toThrow(/destroyed/u);
  });

  it("routes mutations to the named canonical store", () => {
    const sync = createElectronSyncMain();
    const store = sync.createStore<AppState>("app", {
      counter: 0,
      profile: { name: "Ada" },
    });

    const result = sync.handleMutation<AppState>(
      createRequest(store.getServerEpoch()),
    );

    expect(result).toMatchObject({ type: "commit", revision: 1 });
    expect(store.getState().counter).toBe(1);
  });

  it("routes resync requests to the named canonical store", () => {
    const sync = createElectronSyncMain();
    const store = sync.createStore<AppState>("app", {
      counter: 0,
      profile: { name: "Ada" },
    });
    sync.handleMutation(createRequest(store.getServerEpoch()));

    const result = sync.handleResync<AppState>({
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      clientId: "renderer-a",
      serverEpoch: "stale-epoch",
      knownRevision: 0,
      pendingMutationIds: ["mutation-1"],
    });

    expect(result).toMatchObject({
      snapshot: {
        storeId: "app",
        serverEpoch: store.getServerEpoch(),
        revision: 1,
        state: { counter: 1 },
      },
      appliedMutationIds: ["mutation-1"],
    });
  });

  it("returns an honest unknown-store mutation rejection", () => {
    const sync = createElectronSyncMain();
    const request = {
      ...createRequest("renderer-epoch"),
      storeId: "missing",
    };

    expect(sync.handleMutation(request)).toEqual({
      type: "rejected",
      protocolVersion: PROTOCOL_VERSION,
      storeId: "missing",
      serverEpoch: null,
      clientId: "renderer-a",
      mutationId: "mutation-1",
      revision: null,
      code: "unknown-store",
      message: 'Store "missing" is not registered',
      retryable: false,
    });
  });

  it("returns invalid-mutation before unknown-store for a bad payload", () => {
    const sync = createElectronSyncMain();
    const request = {
      ...createRequest("renderer-epoch"),
      storeId: "missing",
      patch: { counter: undefined },
    };

    expect(sync.handleMutation(request)).toMatchObject({
      type: "rejected",
      storeId: "missing",
      serverEpoch: null,
      revision: null,
      code: "invalid-mutation",
    });
  });

  it("returns an honest unknown-store resync rejection", () => {
    const sync = createElectronSyncMain();

    expect(
      sync.handleResync({
        protocolVersion: PROTOCOL_VERSION,
        storeId: "missing",
        clientId: "renderer-a",
        serverEpoch: "renderer-epoch",
        knownRevision: 4,
        pendingMutationIds: [],
      }),
    ).toEqual({
      type: "rejected",
      protocolVersion: PROTOCOL_VERSION,
      storeId: "missing",
      serverEpoch: null,
      clientId: "renderer-a",
      mutationId: null,
      revision: null,
      code: "unknown-store",
      message: 'Store "missing" is not registered',
      retryable: false,
    });
  });
});
