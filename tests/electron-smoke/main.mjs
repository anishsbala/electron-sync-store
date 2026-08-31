import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

import { createElectronSyncMain } from "../../packages/main/dist/index.js";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

async function runSmokeTest() {
  const sync = createElectronSyncMain();
  const store = sync.createStore("app", { counter: 0 });
  const installation = sync.installElectron();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(fixtureDirectory, "preload.mjs"),
      sandbox: false,
    },
  });

  try {
    await window.loadFile(path.join(fixtureDirectory, "renderer.html"));
    const snapshot = await window.webContents.executeJavaScript(
      "window.startElectronSyncStoreSmoke()",
    );
    if (snapshot.sync.revision !== 0 || snapshot.state.counter !== 0) {
      throw new Error(`Unexpected initial snapshot: ${JSON.stringify(snapshot)}`);
    }

    await window.webContents.executeJavaScript(
      "window.armElectronSyncStoreCommitWait()",
    );
    store.setState({ counter: 1 });
    const update = await window.webContents.executeJavaScript(
      "window.waitForElectronSyncStoreCommit()",
    );
    if (
      update.sync.revision !== 1 ||
      update.state.counter !== 1
    ) {
      throw new Error(`Unexpected renderer update: ${JSON.stringify(update)}`);
    }

    console.log("Electron smoke passed: renderer received Commit revision 1");
  } finally {
    installation.uninstall();
    window.destroy();
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
