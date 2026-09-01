import type { RendererStore } from "@electron-sync-store/renderer";
import { useElectronSyncState } from "@electron-sync-store/react";

import type { DemoState } from "../../shared/demo-state.js";

export function SyncError({ store }: { store: RendererStore<DemoState> }) {
  const sync = useElectronSyncState(store);
  if (sync.status !== "error") {
    return null;
  }
  return (
    <div className="error-panel" role="alert">
      <strong>Synchronization error</strong>
      <span>{sync.error?.message ?? "The renderer replica could not recover."}</span>
    </div>
  );
}
