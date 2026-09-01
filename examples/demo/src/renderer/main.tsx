import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type { RendererStore } from "@electron-sync-store/renderer";

import type { DemoSmokeSnapshot, DemoTheme } from "../shared/demo-bridge.js";
import type { DemoState } from "../shared/demo-state.js";
import { App } from "./App.js";
import { readWindowRole } from "./role.js";
import { initializeDemoStore } from "./store.js";
import "./styles.css";

const role = readWindowRole(window.location.search);
const rootElement = document.querySelector<HTMLDivElement>("#root");
if (rootElement === null) {
  throw new Error("Demo root element is missing");
}
const root = createRoot(rootElement);
let activeStore: RendererStore<DemoState> | undefined;

function readSmokeSnapshot(): DemoSmokeSnapshot {
  if (activeStore === undefined) {
    throw new Error("Demo renderer store is not ready");
  }
  const sync = activeStore.getSyncState();
  return {
    role,
    clientId: sync.clientId,
    serverEpoch: sync.serverEpoch,
    revision: sync.revision,
    pendingMutations: sync.pendingMutations,
    status: sync.status,
    counter: activeStore.getState().counter,
    theme: activeStore.getState().theme,
  };
}

const ready = initializeDemoStore().then((store) => {
  activeStore = store;
  root.render(
    <StrictMode>
      <App role={role} store={store} />
    </StrictMode>,
  );
  return store;
});

window.demoSmokeReady = async () => {
  await ready;
  return readSmokeSnapshot();
};
window.demoSmokeSetCounter = async (counter) => {
  const store = await ready;
  store.setState({ counter, lastUpdatedBy: "controller" });
  await store.flush();
  return readSmokeSnapshot();
};
window.demoSmokeWaitForCounter = async (counter) => {
  const store = await ready;
  if (store.getState().counter === counter) {
    return readSmokeSnapshot();
  }
  return new Promise<DemoSmokeSnapshot>((resolve) => {
    const unsubscribe = store.subscribe((state) => {
      if (state.counter === counter) {
        unsubscribe();
        resolve(readSmokeSnapshot());
      }
    });
  });
};
window.demoSmokeSetTheme = async (theme: DemoTheme) => {
  const store = await ready;
  store.setState({ theme, lastUpdatedBy: "controller" });
  await store.flush();
  return readSmokeSnapshot();
};
window.demoSmokeWaitForTheme = async (theme: DemoTheme) => {
  const store = await ready;
  if (store.getState().theme === theme) {
    return readSmokeSnapshot();
  }
  return new Promise<DemoSmokeSnapshot>((resolve) => {
    const unsubscribe = store.subscribe((state) => {
      if (state.theme === theme) {
        unsubscribe();
        resolve(readSmokeSnapshot());
      }
    });
  });
};

ready.catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown initialization error";
  root.render(
    <main className="boot-shell boot-error">
      <strong>Could not connect to the shared store</strong>
      <span>{message}</span>
    </main>,
  );
});

window.addEventListener("beforeunload", () => {
  root.unmount();
  activeStore?.destroy();
});
