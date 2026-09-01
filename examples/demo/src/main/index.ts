import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";

import { app, ipcMain, type BrowserWindow } from "electron";
import { createElectronSyncMain } from "@electron-sync-store/main";

import type { DemoSmokeSnapshot, DemoWindowRole } from "../shared/demo-bridge.js";
import { initialDemoState, type DemoState } from "../shared/demo-state.js";
import { installDemoActions } from "./demo-actions.js";
import { createDemoWindowManager } from "./windows.js";

const smokeMode = process.env.ELECTRON_SYNC_STORE_DEMO_SMOKE === "1";
const sync = createElectronSyncMain();
const demoStore = sync.createStore<DemoState>("demo", initialDemoState);
const installation = sync.installElectron();
const windows = createDemoWindowManager();
const uninstallDemoActions = installDemoActions(ipcMain, demoStore, windows);
let cleanedUp = false;

function cleanup(): void {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  uninstallDemoActions();
  installation.uninstall();
}

function requireWindow(role: DemoWindowRole): BrowserWindow {
  const window = windows.getWindow(role);
  if (window === undefined || window.isDestroyed()) {
    throw new Error(`Expected an open ${role} window`);
  }
  return window;
}

async function readReady(role: DemoWindowRole): Promise<DemoSmokeSnapshot> {
  return requireWindow(role).webContents.executeJavaScript(
    `new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        if (typeof window.demoSmokeReady === "function") {
          window.demoSmokeReady().then(resolve, reject);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error("Demo smoke API was not installed"));
          return;
        }
        setTimeout(check, 20);
      };
      check();
    })`,
  ) as Promise<DemoSmokeSnapshot>;
}

async function waitForCounter(
  role: DemoWindowRole,
  counter: number,
): Promise<DemoSmokeSnapshot> {
  return requireWindow(role).webContents.executeJavaScript(
    `window.demoSmokeWaitForCounter(${counter})`,
  ) as Promise<DemoSmokeSnapshot>;
}

async function waitForTheme(
  role: DemoWindowRole,
  theme: "light" | "dark",
): Promise<DemoSmokeSnapshot> {
  return requireWindow(role).webContents.executeJavaScript(
    `window.demoSmokeWaitForTheme("${theme}")`,
  ) as Promise<DemoSmokeSnapshot>;
}

async function captureWindows(): Promise<string[]> {
  const outputDirectory = join(
    app.getPath("temp"),
    "electron-sync-store-demo-smoke",
  );
  await mkdir(outputDirectory, { recursive: true });
  const paths: string[] = [];
  for (const role of ["controller", "observer", "inspector"] as const) {
    const path = join(outputDirectory, `${role}.png`);
    const image = await requireWindow(role).capturePage();
    await writeFile(path, image.toPNG());
    paths.push(path);
  }
  return paths;
}

async function runSmoke(): Promise<void> {
  const initial = await Promise.all([
    readReady("controller"),
    readReady("observer"),
    readReady("inspector"),
  ]);
  const clientIds = new Set(initial.map((entry) => entry.clientId));
  if (
    clientIds.size !== 3 ||
    initial.some(
      (entry) =>
        entry.revision !== 0 ||
        entry.counter !== 0 ||
        entry.status !== "synced",
    )
  ) {
    throw new Error(`Unexpected initial demo hydration: ${JSON.stringify(initial)}`);
  }
  const expectedTitles = [
    "Electron Sync Store - Controller",
    "Electron Sync Store - Observer",
    "Electron Sync Store - Inspector",
  ];
  const actualTitles = (["controller", "observer", "inspector"] as const).map(
    (role) => requireWindow(role).getTitle(),
  );
  if (JSON.stringify(actualTitles) !== JSON.stringify(expectedTitles)) {
    throw new Error(`Unexpected demo window titles: ${JSON.stringify(actualTitles)}`);
  }

  const observerWait = waitForCounter("observer", 1);
  const inspectorWait = waitForCounter("inspector", 1);
  const controllerUpdate = requireWindow("controller").webContents.executeJavaScript(
    "window.demoSmokeSetCounter(1)",
  ) as Promise<DemoSmokeSnapshot>;
  const synchronized = await Promise.all([
    controllerUpdate,
    observerWait,
    inspectorWait,
  ]);
  if (
    demoStore.getState().counter !== 1 ||
    synchronized.some(
      (entry) =>
        entry.counter !== 1 ||
        entry.revision !== 1 ||
        entry.pendingMutations !== 0,
    )
  ) {
    throw new Error(`Demo renderers did not converge: ${JSON.stringify(synchronized)}`);
  }

  const observerLight = waitForTheme("observer", "light");
  const inspectorLight = waitForTheme("inspector", "light");
  const controllerLight = requireWindow("controller").webContents.executeJavaScript(
    'window.demoSmokeSetTheme("light")',
  ) as Promise<DemoSmokeSnapshot>;
  const lightTheme = await Promise.all([
    controllerLight,
    observerLight,
    inspectorLight,
  ]);
  const renderedThemes = await Promise.all(
    (["controller", "observer", "inspector"] as const).map(
      (role) =>
        requireWindow(role).webContents.executeJavaScript(
          'document.querySelector(".app-shell")?.dataset.theme',
        ) as Promise<string | undefined>,
    ),
  );
  if (
    lightTheme.some((entry) => entry.theme !== "light") ||
    renderedThemes.some((theme) => theme !== "light")
  ) {
    throw new Error(`Shared light theme did not converge: ${JSON.stringify(lightTheme)}`);
  }

  const observerDark = waitForTheme("observer", "dark");
  const inspectorDark = waitForTheme("inspector", "dark");
  const controllerDark = requireWindow("controller").webContents.executeJavaScript(
    'window.demoSmokeSetTheme("dark")',
  ) as Promise<DemoSmokeSnapshot>;
  await Promise.all([controllerDark, observerDark, inspectorDark]);

  const oldObserver = requireWindow("observer");
  const oldObserverClientId = synchronized[1]?.clientId;
  const observerClosed = once(oldObserver, "closed");
  windows.closeWindow("observer");
  await observerClosed;
  demoStore.setState({ counter: 25, lastUpdatedBy: "main" });
  await Promise.all([
    waitForCounter("controller", 25),
    waitForCounter("inspector", 25),
  ]);
  await windows.reopenObserver();
  const reopenedObserver = await readReady("observer");
  if (
    reopenedObserver.clientId === oldObserverClientId ||
    reopenedObserver.counter !== 25 ||
    reopenedObserver.revision !== demoStore.getRevision() ||
    reopenedObserver.status !== "synced"
  ) {
    throw new Error(
      `Reopened Observer did not hydrate current state: ${JSON.stringify(reopenedObserver)}`,
    );
  }

  const screenshots = await captureWindows();
  console.log(
    `Demo smoke passed: three clients converged and Observer rehydrated at revision ${reopenedObserver.revision}`,
  );
  for (const screenshot of screenshots) {
    console.log(`Demo screenshot: ${screenshot}`);
  }
}

const timeout = smokeMode
  ? setTimeout(() => {
      console.error("Demo smoke timed out");
      cleanup();
      app.exit(1);
    }, 30_000)
  : undefined;

app.on("before-quit", cleanup);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("activate", () => {
  if (windows.getWindow("controller") === undefined) {
    void windows.openInitialWindows();
  }
});

app.whenReady()
  .then(async () => {
    await windows.openInitialWindows();
    if (smokeMode) {
      await runSmoke();
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      cleanup();
      windows.closeAll();
      app.exit(0);
    }
  })
  .catch((error: unknown) => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    console.error(error);
    cleanup();
    windows.closeAll();
    app.exit(1);
  });
