import type { RendererStore } from "@electron-sync-store/renderer";
import { useElectronSyncState } from "@electron-sync-store/react";

import type { DemoWindowRole } from "../../shared/demo-bridge.js";
import type { DemoState } from "../../shared/demo-state.js";
import { shortenIdentifier } from "./format.js";

export function StatusBar({
  role,
  store,
}: {
  role: DemoWindowRole;
  store: RendererStore<DemoState>;
}) {
  const sync = useElectronSyncState(store);

  return (
    <header className="status-bar">
      <div className="role-block">
        <span className="eyebrow">WINDOW ROLE</span>
        <strong>{role.toUpperCase()}</strong>
      </div>
      <div className="status-metrics">
        <span className={`status-chip status-${sync.status}`}>
          <span className="status-dot" />
          {sync.status}
        </span>
        <span><b>Rev</b> {sync.revision ?? "—"}</span>
        <span><b>Pending</b> {sync.pendingMutations}</span>
      </div>
      <div className="identity-metrics mono">
        <span>client {shortenIdentifier(sync.clientId)}</span>
        <span>epoch {shortenIdentifier(sync.serverEpoch)}</span>
      </div>
    </header>
  );
}
