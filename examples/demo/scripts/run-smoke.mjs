import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";

const demoDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(electron, [demoDirectory], {
  env: {
    ...process.env,
    ELECTRON_SYNC_STORE_DEMO_SMOKE: "1",
  },
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`Demo smoke terminated by signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
