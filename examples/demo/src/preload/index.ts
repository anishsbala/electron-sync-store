import { contextBridge, ipcRenderer } from "electron";
import { exposeElectronSyncStore } from "@electron-sync-store/renderer/preload";

import {
  DEMO_INCREMENT_FROM_MAIN_CHANNEL,
  DEMO_REOPEN_INSPECTOR_CHANNEL,
  DEMO_REOPEN_OBSERVER_CHANNEL,
  type DemoActionsBridge,
} from "../shared/demo-bridge.js";

exposeElectronSyncStore();

const demoActions: DemoActionsBridge = {
  incrementFromMain: async () =>
    ipcRenderer.invoke(DEMO_INCREMENT_FROM_MAIN_CHANNEL),
  reopenObserver: async () => ipcRenderer.invoke(DEMO_REOPEN_OBSERVER_CHANNEL),
  reopenInspector: async () =>
    ipcRenderer.invoke(DEMO_REOPEN_INSPECTOR_CHANNEL),
};

contextBridge.exposeInMainWorld("demoActions", demoActions);
