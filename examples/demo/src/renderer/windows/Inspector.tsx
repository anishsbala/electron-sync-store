import { useEffect, useRef, useState } from "react";
import type { RendererStore } from "@electron-sync-store/renderer";
import { useElectronStore, useElectronSyncState } from "@electron-sync-store/react";

import type { DemoState } from "../../shared/demo-state.js";
import { formatClock, shortenIdentifier } from "../components/format.js";
import { Panel } from "../components/Panel.js";
import { StateJson } from "../components/StateJson.js";
import {
  prependBoundedEvent,
  type DemoEvent,
} from "../event-log.js";

export function Inspector({ store }: { store: RendererStore<DemoState> }) {
  const state = useElectronStore(store, (current) => current);
  const sync = useElectronSyncState(store);
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const sequence = useRef(0);

  useEffect(() => {
    function record(type: DemoEvent["type"]): void {
      sequence.current += 1;
      const currentSync = store.getSyncState();
      const currentState = store.getState();
      setEvents((current) =>
        prependBoundedEvent(current, {
          sequence: sequence.current,
          type,
          timestamp: formatClock(),
          revision: currentSync.revision,
          pendingMutations: currentSync.pendingMutations,
          status: currentSync.status,
          state: {
            ...currentState,
            profile: { ...currentState.profile },
          },
        }),
      );
    }

    const unsubscribeState = store.subscribe(() => record("State change"));
    const unsubscribeSync = store.subscribeSync(() => record("Sync change"));
    return () => {
      unsubscribeState();
      unsubscribeSync();
    };
  }, [store]);

  return (
    <div className="window-content inspector-layout">
      <Panel title="Replica">
        <dl className="replica-grid mono">
          <div><dt>Client ID</dt><dd title={sync.clientId}>{shortenIdentifier(sync.clientId)}</dd></div>
          <div><dt>Server epoch</dt><dd title={sync.serverEpoch ?? undefined}>{shortenIdentifier(sync.serverEpoch)}</dd></div>
          <div><dt>Canonical revision</dt><dd>{sync.revision ?? "—"}</dd></div>
          <div><dt>Pending mutations</dt><dd>{sync.pendingMutations}</dd></div>
          <div><dt>Status</dt><dd className={`text-${sync.status}`}>{sync.status}</dd></div>
          <div><dt>Error</dt><dd>{sync.error?.message ?? "none"}</dd></div>
        </dl>
      </Panel>

      <Panel title="Visible State">
        <StateJson state={state} />
      </Panel>

      <Panel
        title="Synchronization Event Log"
        action={<button className="compact-button" onClick={() => setEvents([])}>Clear Log</button>}
      >
        <p className="hint log-hint">Renderer-local timeline from public state and sync subscriptions. Last 100 events.</p>
        <ol className="event-log">
          {events.length === 0 && (
            <li className="empty-log">Waiting for state or synchronization activity…</li>
          )}
          {events.map((event) => (
            <li key={event.sequence}>
              <div className="event-heading">
                <strong>#{event.sequence} {event.type}</strong>
                <time>{event.timestamp}</time>
              </div>
              <div className="event-meta mono">
                rev={event.revision ?? "—"} pending={event.pendingMutations} status={event.status}
              </div>
              <div className="event-state mono">
                counter={event.state.counter} theme={event.state.theme} by={event.state.lastUpdatedBy ?? "—"}
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
