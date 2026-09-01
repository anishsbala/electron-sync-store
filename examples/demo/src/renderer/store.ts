import { createRendererStore, type RendererStore } from "@electron-sync-store/renderer";

import type { DemoState } from "../shared/demo-state.js";

let storePromise: Promise<RendererStore<DemoState>> | undefined;

export function initializeDemoStore(): Promise<RendererStore<DemoState>> {
  storePromise ??= createRendererStore<DemoState>({ id: "demo" });
  return storePromise;
}
