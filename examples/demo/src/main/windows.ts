import { app, BrowserWindow, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DemoWindowRole } from "../shared/demo-bridge.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(moduleDirectory, "../preload/index.js");
const rendererPath = join(moduleDirectory, "../../renderer/index.html");

const windowSpecifications: Record<
  DemoWindowRole,
  { title: string; width: number; height: number }
> = {
  controller: {
    title: "Electron Sync Store - Controller",
    width: 520,
    height: 780,
  },
  observer: {
    title: "Electron Sync Store - Observer",
    width: 460,
    height: 680,
  },
  inspector: {
    title: "Electron Sync Store - Inspector",
    width: 620,
    height: 780,
  },
};

export interface DemoWindowManager {
  openInitialWindows(): Promise<void>;
  reopenObserver(): Promise<void>;
  reopenInspector(): Promise<void>;
  getWindow(role: DemoWindowRole): BrowserWindow | undefined;
  closeWindow(role: DemoWindowRole): void;
  closeAll(): void;
}

export function createDemoWindowManager(): DemoWindowManager {
  const windows = new Map<DemoWindowRole, BrowserWindow>();

  function positionFor(role: DemoWindowRole): { x: number; y: number } {
    const { x, y, width } = screen.getPrimaryDisplay().workArea;
    const index = (["controller", "observer", "inspector"] as const).indexOf(role);
    const horizontal = width >= 1_650;
    return {
      x: x + 24 + (horizontal ? index * 540 : index * 42),
      y: y + 24 + (horizontal ? 0 : index * 42),
    };
  }

  async function open(role: DemoWindowRole): Promise<BrowserWindow> {
    const existing = windows.get(role);
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return existing;
    }

    const specification = windowSpecifications[role];
    const window = new BrowserWindow({
      ...specification,
      ...positionFor(role),
      minWidth: 400,
      minHeight: 560,
      backgroundColor: "#111318",
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: preloadPath,
      },
    });
    windows.set(role, window);
    window.webContents.on("preload-error", (_event, path, error) => {
      console.error(`[${role}] preload error in ${path}`, error);
    });
    window.webContents.on("console-message", (details) => {
      if (details.level === "warning" || details.level === "error") {
        console.error(
          `[${role}] renderer console (${details.level}): ${details.message}`,
        );
      }
    });
    window.webContents.on("did-fail-load", (_event, code, description) => {
      console.error(`[${role}] failed to load (${code}): ${description}`);
    });
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      windows.delete(role);
      if (role === "controller") {
        app.quit();
      }
    });
    await window.loadFile(rendererPath, { query: { view: role } });
    window.setTitle(specification.title);
    return window;
  }

  return {
    async openInitialWindows() {
      await Promise.all([
        open("controller"),
        open("observer"),
        open("inspector"),
      ]);
    },
    reopenObserver: async () => void (await open("observer")),
    reopenInspector: async () => void (await open("inspector")),
    getWindow: (role) => windows.get(role),
    closeWindow(role) {
      windows.get(role)?.close();
    },
    closeAll() {
      for (const window of [...windows.values()]) {
        window.destroy();
      }
      windows.clear();
    },
  };
}
