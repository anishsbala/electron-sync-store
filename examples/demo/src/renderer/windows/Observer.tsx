import { useEffect, useState } from "react";
import type { RendererStore } from "@electron-sync-store/renderer";
import { useElectronStore } from "@electron-sync-store/react";

import type { DemoState } from "../../shared/demo-state.js";
import { formatClock } from "../components/format.js";
import { Panel } from "../components/Panel.js";

export function Observer({ store }: { store: RendererStore<DemoState> }) {
  const state = useElectronStore(store, (current) => current);
  const [lastObserved, setLastObserved] = useState(() => formatClock());

  useEffect(() => {
    setLastObserved(formatClock());
  }, [state]);

  return (
    <div className="window-content observer-layout">
      <Panel title="Shared State" action={<span className="read-only-chip">READ ONLY</span>}>
        <div className="observer-counter mono">{state.counter}</div>
        <span className="metric-label centered">COUNTER</span>
      </Panel>

      <div className="summary-grid">
        <Panel title="Profile">
          <strong className="summary-value">{state.profile.name}</strong>
          <span className={`presence presence-${state.profile.status}`}>
            <span /> {state.profile.status}
          </span>
        </Panel>
        <Panel title="Theme">
          <strong className="summary-value capitalize">{state.theme}</strong>
          <span className="muted">Shared across all windows</span>
        </Panel>
        <Panel title="Last Updated By">
          <strong className="summary-value capitalize">
            {state.lastUpdatedBy ?? "No mutations yet"}
          </strong>
          <span className="muted">Canonical shared field</span>
        </Panel>
        <Panel title="Last Observed Change">
          <strong className="summary-value mono">{lastObserved}</strong>
          <span className="muted">Local observer timestamp</span>
        </Panel>
      </div>

      <div className="observer-note">
        Close this window, mutate from Controller, then reopen it. The new replica
        hydrates directly at the current canonical revision.
      </div>
    </div>
  );
}
