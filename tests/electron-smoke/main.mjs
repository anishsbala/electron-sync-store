import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

import { createElectronSyncMain } from "../../packages/main/dist/index.js";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

async function runSmokeTest() {
  const sync = createElectronSyncMain();
  const store = sync.createStore("app", { counter: 0 });
  const installation = sync.installElectron();
  const createWindow = () =>
    new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(fixtureDirectory, "preload.mjs"),
        sandbox: false,
      },
    });
  const firstWindow = createWindow();
  const secondWindow = createWindow();

  try {
    await Promise.all([
      firstWindow.loadFile(path.join(fixtureDirectory, "renderer.html")),
      secondWindow.loadFile(path.join(fixtureDirectory, "renderer.html")),
    ]);
    const snapshots = await Promise.all([
      firstWindow.webContents.executeJavaScript(
        "window.startElectronSyncStoreSmoke()",
      ),
      secondWindow.webContents.executeJavaScript(
        "window.startElectronSyncStoreSmoke()",
      ),
    ]);
    if (
      snapshots.some(
        (snapshot) => snapshot.sync.revision !== 0 || snapshot.state.counter !== 0,
      )
    ) {
      throw new Error(`Unexpected initial snapshots: ${JSON.stringify(snapshots)}`);
    }

    await Promise.all([
      firstWindow.webContents.executeJavaScript(
        "window.armElectronSyncStoreCommitWait(1, 1)",
      ),
      secondWindow.webContents.executeJavaScript(
        "window.armElectronSyncStoreCommitWait(1, 1)",
      ),
    ]);
    const optimistic = await firstWindow.webContents.executeJavaScript(
      "window.performElectronSyncStoreMutation(1)",
    );
    if (
      optimistic.state.counter !== 1 ||
      optimistic.sync.revision !== 0 ||
      optimistic.sync.pendingMutations !== 1
    ) {
      throw new Error(`Renderer update was not immediately optimistic: ${JSON.stringify(optimistic)}`);
    }
    const rendererUpdates = await Promise.all([
      firstWindow.webContents.executeJavaScript(
        "window.waitForElectronSyncStoreCommit()",
      ),
      secondWindow.webContents.executeJavaScript(
        "window.waitForElectronSyncStoreCommit()",
      ),
    ]);
    if (
      store.getState().counter !== 1 ||
      rendererUpdates.some(
        (update) =>
          update.sync.revision !== 1 ||
          update.sync.pendingMutations !== 0 ||
          update.state.counter !== 1,
      )
    ) {
      throw new Error(`Unexpected canonical renderer updates: ${JSON.stringify(rendererUpdates)}`);
    }

    await Promise.all([
      firstWindow.webContents.executeJavaScript(
        "window.armElectronSyncStoreCommitWait(2, 2)",
      ),
      secondWindow.webContents.executeJavaScript(
        "window.armElectronSyncStoreCommitWait(2, 2)",
      ),
    ]);
    store.setState({ counter: 2 });
    const mainUpdates = await Promise.all([
      firstWindow.webContents.executeJavaScript(
        "window.waitForElectronSyncStoreCommit()",
      ),
      secondWindow.webContents.executeJavaScript(
        "window.waitForElectronSyncStoreCommit()",
      ),
    ]);

    console.log(
      `Electron smoke passed: optimistic renderer mutation converged across two renderers; main Commit reached revision ${mainUpdates[0].sync.revision}`,
    );
  } finally {
    installation.uninstall();
    firstWindow.destroy();
    secondWindow.destroy();
  }
}

const timeout = setTimeout(() => {
  console.error("Electron smoke timed out");
  app.exit(1);
}, 20_000);

app.whenReady()
  .then(runSmokeTest)
  .then(() => {
    clearTimeout(timeout);
    app.exit(0);
  })
  .catch((error) => {
    clearTimeout(timeout);
    console.error(error);
    app.exit(1);
  });
