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
        <strong data-testid="window-role">{role.toUpperCase()}</strong>
      </div>
      <div className="status-metrics">
        <span className={`status-chip status-${sync.status}`} data-testid="sync-status">
          <span className="status-dot" />
          {sync.status}
        </span>
        <span data-testid="sync-revision"><b>Rev</b> {sync.revision ?? "—"}</span>
        <span data-testid="sync-pending"><b>Pending</b> {sync.pendingMutations}</span>
      </div>
      <div className="identity-metrics mono">
        <span data-testid="sync-client" data-client-id={sync.clientId}>
          client {shortenIdentifier(sync.clientId)}
        </span>
        <span data-testid="sync-epoch" data-server-epoch={sync.serverEpoch ?? ""}>
          epoch {shortenIdentifier(sync.serverEpoch)}
        </span>
      </div>
    </header>
  );
}
