import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { MainStore } from "@electron-sync-store/main";

import {
  DEMO_INCREMENT_FROM_MAIN_CHANNEL,
  DEMO_REOPEN_INSPECTOR_CHANNEL,
  DEMO_REOPEN_OBSERVER_CHANNEL,
} from "../shared/demo-bridge.js";
import type { DemoState } from "../shared/demo-state.js";

export interface DemoWindowActions {
  reopenObserver(): Promise<void>;
  reopenInspector(): Promise<void>;
}

function assertMainFrame(event: IpcMainInvokeEvent): void {
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Demo actions are available only to the sender's main frame");
  }
}

export function installDemoActions(
  ipcMain: IpcMain,
  store: MainStore<DemoState>,
  windows: DemoWindowActions,
): () => void {
  ipcMain.handle(DEMO_INCREMENT_FROM_MAIN_CHANNEL, (event) => {
    assertMainFrame(event);
    store.setState((state) => ({
      counter: state.counter + 1,
      lastUpdatedBy: "main",
    }));
  });
  ipcMain.handle(DEMO_REOPEN_OBSERVER_CHANNEL, async (event) => {
    assertMainFrame(event);
    await windows.reopenObserver();
  });
  ipcMain.handle(DEMO_REOPEN_INSPECTOR_CHANNEL, async (event) => {
    assertMainFrame(event);
    await windows.reopenInspector();
  });

  return () => {
    ipcMain.removeHandler(DEMO_INCREMENT_FROM_MAIN_CHANNEL);
    ipcMain.removeHandler(DEMO_REOPEN_OBSERVER_CHANNEL);
    ipcMain.removeHandler(DEMO_REOPEN_INSPECTOR_CHANNEL);
  };
}
