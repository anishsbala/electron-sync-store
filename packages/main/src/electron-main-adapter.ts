import { createRequire } from "node:module";

import {
  COMMIT_CHANNEL,
  CONNECT_CHANNEL,
  MUTATE_CHANNEL,
  PROTOCOL_VERSION,
  RESYNC_CHANNEL,
  assertConnectRequest,
  assertResyncRequest,
  type Commit,
  type MutationRejection,
  type MutationResult,
  type ResyncResult,
  type Snapshot,
} from "@electron-sync-store/core";

import type { MainStore, MainStoreRegistry } from "./index.js";

export interface ElectronFrameLike {
  readonly url: string;
}

export interface ElectronWebContentsLike {
  readonly id: number;
  readonly mainFrame?: ElectronFrameLike;
  isDestroyed(): boolean;
  send(channel: string, message: unknown): void;
  once(event: string, listener: (...args: unknown[]) => void): this;
  removeListener?(event: string, listener: (...args: unknown[]) => void): this;
}

export interface ElectronInvokeEventLike {
  readonly sender: ElectronWebContentsLike;
  readonly senderFrame?: ElectronFrameLike | null;
}

export type ElectronIpcHandler = (
  event: ElectronInvokeEventLike,
  request: unknown,
) => unknown | Promise<unknown>;

export interface ElectronIpcMainLike {
  handle(channel: string, listener: ElectronIpcHandler): void;
  removeHandler(channel: string): void;
}

export interface RendererAuthorizationContext {
  webContentsId: number;
  frameUrl: string;
  storeId: string;
}

export interface ElectronMainInstallOptions {
  authorizeRenderer?: (context: RendererAuthorizationContext) => boolean;
  /** Primarily useful for deterministic adapter tests. */
  ipcMain?: ElectronIpcMainLike;
}

export interface ElectronMainInstallation {
  uninstall(): void;
}

interface ConnectedWebContents {
  webContents: ElectronWebContentsLike;
  stores: Map<string, string>;
  cleanup: () => void;
}

interface MutationIdentity {
  storeId: string;
  clientId: string;
  mutationId: string;
}

function loadIpcMain(): ElectronIpcMainLike {
  const require = createRequire(import.meta.url);
  const electron = require("electron") as unknown;
  if (
    electron === null ||
    typeof electron !== "object" ||
    !("ipcMain" in electron)
  ) {
    throw new Error(
      "Electron ipcMain is unavailable. installElectron() must run in the Electron main process.",
    );
  }
  return (electron as { ipcMain: ElectronIpcMainLike }).ipcMain;
}

function readMutationIdentity(request: unknown): MutationIdentity {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("mutation request must be an object");
  }
  const value = request as Record<string, unknown>;
  for (const field of ["storeId", "clientId", "mutationId"] as const) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      throw new TypeError(`mutationRequest.${field} must be a non-empty string`);
    }
  }
  return {
    storeId: value.storeId as string,
    clientId: value.clientId as string,
    mutationId: value.mutationId as string,
  };
}

function storePosition(store: MainStore<object> | undefined): {
  serverEpoch: string | null;
  revision: number | null;
} {
  return store === undefined
    ? { serverEpoch: null, revision: null }
    : {
        serverEpoch: store.getServerEpoch(),
        revision: store.getRevision(),
      };
}

export function installElectronMainAdapter(
  registry: MainStoreRegistry,
  options: ElectronMainInstallOptions = {},
): ElectronMainInstallation {
  const ipcMain = options.ipcMain ?? loadIpcMain();
  const connected = new Map<number, ConnectedWebContents>();
  const commitSubscriptions = new Map<string, () => void>();
  const installedChannels: string[] = [];
  let uninstalled = false;

  function removeConnectedWebContents(webContentsId: number): void {
    const entry = connected.get(webContentsId);
    if (entry === undefined) {
      return;
    }
    connected.delete(webContentsId);
    entry.webContents.removeListener?.("destroyed", entry.cleanup);
    entry.webContents.removeListener?.("did-start-navigation", entry.cleanup);
    entry.webContents.removeListener?.("render-process-gone", entry.cleanup);
  }

  function registerConnection(
    webContents: ElectronWebContentsLike,
    storeId: string,
    clientId: string,
  ): void {
    let entry = connected.get(webContents.id);
    if (entry === undefined) {
      const cleanup = () => removeConnectedWebContents(webContents.id);
      entry = {
        webContents,
        stores: new Map(),
        cleanup,
      };
      connected.set(webContents.id, entry);
      webContents.once("destroyed", cleanup);
      webContents.once("did-start-navigation", cleanup);
      webContents.once("render-process-gone", cleanup);
    }
    entry.stores.set(storeId, clientId);
  }

  function unregisterConnection(
    webContentsId: number,
    storeId: string,
    clientId: string,
  ): void {
    const entry = connected.get(webContentsId);
    if (entry?.stores.get(storeId) === clientId) {
      entry.stores.delete(storeId);
    }
    if (entry?.stores.size === 0) {
      removeConnectedWebContents(webContentsId);
    }
  }

  function broadcast(commit: Commit<object>): void {
    for (const [webContentsId, entry] of [...connected]) {
      if (!entry.stores.has(commit.storeId)) {
        continue;
      }
      if (entry.webContents.isDestroyed()) {
        removeConnectedWebContents(webContentsId);
        continue;
      }
      try {
        entry.webContents.send(COMMIT_CHANNEL, commit);
      } catch {
        removeConnectedWebContents(webContentsId);
      }
    }
  }

  function observeStore(store: MainStore<object>): void {
    if (commitSubscriptions.has(store.storeId)) {
      return;
    }
    commitSubscriptions.set(
      store.storeId,
      store.subscribeCommits((commit) => broadcast(commit)),
    );
  }

  function isAuthorized(
    event: ElectronInvokeEventLike,
    storeId: string,
  ): boolean {
    const senderFrame = event.senderFrame;
    if (
      senderFrame === null ||
      senderFrame === undefined ||
      event.sender.mainFrame === undefined ||
      senderFrame !== event.sender.mainFrame
    ) {
      return false;
    }
    return (
      options.authorizeRenderer?.({
        webContentsId: event.sender.id,
        frameUrl: senderFrame.url,
        storeId,
      }) ?? true
    );
  }

  function isConnected(
    event: ElectronInvokeEventLike,
    storeId: string,
    clientId: string,
  ): boolean {
    return connected.get(event.sender.id)?.stores.get(storeId) === clientId;
  }

  function rejection(
    storeId: string,
    clientId: string,
    mutationId: string | null,
    code: "unauthorized" | "internal-error",
    message: string,
    retryable: boolean,
  ): MutationRejection {
    const position = storePosition(registry.getStore(storeId));
    return {
      type: "rejected",
      protocolVersion: PROTOCOL_VERSION,
      storeId,
      serverEpoch: position.serverEpoch,
      clientId,
      mutationId,
      revision: position.revision,
      code,
      message,
      retryable,
    };
  }

  async function connectHandler(
    event: ElectronInvokeEventLike,
    request: unknown,
  ): Promise<Snapshot<object>> {
    assertConnectRequest(request);
    const store = registry.getStore(request.storeId);
    if (store === undefined) {
      throw new Error(`Store "${request.storeId}" is not registered`);
    }
    if (!isAuthorized(event, request.storeId)) {
      throw new Error(`Renderer is not authorized for store "${request.storeId}"`);
    }

    observeStore(store);
    registerConnection(event.sender, request.storeId, request.clientId);
    try {
      return store.getSnapshot();
    } catch (error) {
      unregisterConnection(event.sender.id, request.storeId, request.clientId);
      throw error;
    }
  }

  async function mutationHandler(
    event: ElectronInvokeEventLike,
    request: unknown,
  ): Promise<MutationResult<object>> {
    const identity = readMutationIdentity(request);
    if (
      !isAuthorized(event, identity.storeId) ||
      !isConnected(event, identity.storeId, identity.clientId)
    ) {
      return rejection(
        identity.storeId,
        identity.clientId,
        identity.mutationId,
        "unauthorized",
        "Renderer is not connected with this store and client ID",
        false,
      );
    }
    try {
      return registry.handleMutation(request);
    } catch (error) {
      return rejection(
        identity.storeId,
        identity.clientId,
        identity.mutationId,
        "internal-error",
        error instanceof Error ? error.message : "Unexpected mutation failure",
        true,
      );
    }
  }

  async function resyncHandler(
    event: ElectronInvokeEventLike,
    request: unknown,
  ): Promise<ResyncResult<object>> {
    assertResyncRequest(request);
    if (
      !isAuthorized(event, request.storeId) ||
      !isConnected(event, request.storeId, request.clientId)
    ) {
      return rejection(
        request.storeId,
        request.clientId,
        null,
        "unauthorized",
        "Renderer is not connected with this store and client ID",
        false,
      );
    }
    try {
      return registry.handleResync(request);
    } catch (error) {
      return rejection(
        request.storeId,
        request.clientId,
        null,
        "internal-error",
        error instanceof Error ? error.message : "Unexpected resync failure",
        true,
      );
    }
  }

  const handlers: ReadonlyArray<readonly [string, ElectronIpcHandler]> = [
    [CONNECT_CHANNEL, connectHandler],
    [MUTATE_CHANNEL, mutationHandler],
    [RESYNC_CHANNEL, resyncHandler],
  ];

  try {
    for (const [channel, handler] of handlers) {
      ipcMain.handle(channel, handler);
      installedChannels.push(channel);
    }
  } catch (error) {
    for (const channel of installedChannels) {
      ipcMain.removeHandler(channel);
    }
    throw error;
  }

  return {
    uninstall() {
      if (uninstalled) {
        return;
      }
      uninstalled = true;
      for (const channel of installedChannels) {
        ipcMain.removeHandler(channel);
      }
      for (const unsubscribe of commitSubscriptions.values()) {
        unsubscribe();
      }
      commitSubscriptions.clear();
      for (const webContentsId of [...connected.keys()]) {
        removeConnectedWebContents(webContentsId);
      }
    },
  };
}
