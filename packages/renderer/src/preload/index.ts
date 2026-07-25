import { contextBridge, ipcRenderer } from "electron";
import { ELECTRON_SYNC_STORE_BRIDGE_KEY } from "@electron-sync-store/core";

import { createPreloadBridge } from "./preload-bridge.js";

export function exposeElectronSyncStore(): void {
  contextBridge.exposeInMainWorld(
    ELECTRON_SYNC_STORE_BRIDGE_KEY,
    createPreloadBridge(ipcRenderer),
  );
}
