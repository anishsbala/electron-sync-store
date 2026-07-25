import {
  COMMIT_CHANNEL,
  CONNECT_CHANNEL,
  MUTATE_CHANNEL,
  RESYNC_CHANNEL,
} from "@electron-sync-store/core";

import type { ElectronSyncStoreBridge } from "../bridge.js";

export interface PreloadIpcRendererLike {
  invoke(channel: string, request: unknown): Promise<unknown>;
  on(
    channel: string,
    listener: (event: unknown, message: unknown) => void,
  ): this;
  removeListener(
    channel: string,
    listener: (event: unknown, message: unknown) => void,
  ): this;
}

export function createPreloadBridge(
  ipcRenderer: PreloadIpcRendererLike,
): ElectronSyncStoreBridge {
  return {
    connect: (request) => ipcRenderer.invoke(CONNECT_CHANNEL, request),
    submitMutation: (request) => ipcRenderer.invoke(MUTATE_CHANNEL, request),
    requestResync: (request) => ipcRenderer.invoke(RESYNC_CHANNEL, request),
    onCommit(listener) {
      const wrappedListener = (_event: unknown, message: unknown) => {
        listener(message);
      };
      ipcRenderer.on(COMMIT_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(COMMIT_CHANNEL, wrappedListener);
      };
    },
  };
}
