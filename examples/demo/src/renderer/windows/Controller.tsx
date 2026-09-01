import { useEffect, useState } from "react";
import type { RendererStore } from "@electron-sync-store/renderer";
import { useElectronStore, useElectronSyncState } from "@electron-sync-store/react";

import type { DemoState } from "../../shared/demo-state.js";
import { Panel } from "../components/Panel.js";
import { StateJson } from "../components/StateJson.js";

export function Controller({ store }: { store: RendererStore<DemoState> }) {
  const state = useElectronStore(store, (current) => current);
  const sync = useElectronSyncState(store);
  const [nameDraft, setNameDraft] = useState(state.profile.name);
  const [flushLabel, setFlushLabel] = useState("Wait For Sync");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setNameDraft(state.profile.name);
  }, [state.profile.name]);

  function updateCounter(amount: number): void {
    store.setState((current) => ({
      counter: current.counter + amount,
      lastUpdatedBy: "controller",
    }));
  }

  function runRapidUpdates(): void {
    for (let index = 0; index < 10; index += 1) {
      updateCounter(1);
    }
  }

  async function runDemoAction(action: () => Promise<void>): Promise<void> {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Demo action failed");
    }
  }

  async function waitForSync(): Promise<void> {
    setFlushLabel("Synchronizing…");
    setActionError(null);
    try {
      await store.flush();
      setFlushLabel("Synchronized");
      window.setTimeout(() => setFlushLabel("Wait For Sync"), 1_200);
    } catch (error) {
      setFlushLabel("Wait For Sync");
      setActionError(error instanceof Error ? error.message : "Synchronization failed");
    }
  }

  return (
    <div className="window-content controller-layout">
      <Panel title="Shared Counter" className="counter-panel">
        <div className="counter-value mono" data-testid="controller-counter">{state.counter}</div>
        <div className="button-row counter-controls">
          <button onClick={() => updateCounter(-1)}>−1</button>
          <button className="primary" data-testid="increment-one" onClick={() => updateCounter(1)}>+1</button>
          <button onClick={() => updateCounter(10)}>+10</button>
          <button onClick={() => store.setState({ counter: 0, lastUpdatedBy: "controller" })}>
            Reset
          </button>
        </div>
        <button className="wide-button secondary" data-testid="burst-updates" onClick={runRapidUpdates}>
          Burst 10 Updates
        </button>
        <p className="hint">Visible state updates locally before canonical settlement.</p>
      </Panel>

      <Panel title="Shared Profile">
        <div className="form-grid">
          <label htmlFor="profile-name">Name</label>
          <div className="inline-control">
            <input
              id="profile-name"
              data-testid="profile-name"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  store.setState((current) => ({
                    profile: { ...current.profile, name: nameDraft.trim() || current.profile.name },
                    lastUpdatedBy: "controller",
                  }));
                }
              }}
            />
            <button
              data-testid="apply-profile-name"
              onClick={() =>
                store.setState((current) => ({
                  profile: { ...current.profile, name: nameDraft.trim() || current.profile.name },
                  lastUpdatedBy: "controller",
                }))
              }
            >
              Apply
            </button>
          </div>
          <label htmlFor="profile-status">Status</label>
          <select
            id="profile-status"
            data-testid="profile-status"
            value={state.profile.status}
            onChange={(event) =>
              store.setState((current) => ({
                profile: {
                  ...current.profile,
                  status: event.target.value as DemoState["profile"]["status"],
                },
                lastUpdatedBy: "controller",
              }))
            }
          >
            <option value="online">Online</option>
            <option value="away">Away</option>
            <option value="offline">Offline</option>
          </select>
        </div>
      </Panel>

      <Panel title="Shared Theme">
        <div className="segmented-control">
          {(["dark", "light"] as const).map((theme) => (
            <button
              key={theme}
              className={state.theme === theme ? "selected" : ""}
              aria-pressed={state.theme === theme}
              data-testid={`theme-${theme}`}
              onClick={() => store.setState({ theme, lastUpdatedBy: "controller" })}
            >
              {theme === "dark" ? "Dark" : "Light"}
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Process & Lifecycle Actions">
        <div className="action-grid">
          <button
            data-testid="increment-from-main"
            onClick={() => void runDemoAction(() => window.demoActions.incrementFromMain())}
          >
            Increment From Main
          </button>
          <button
            data-testid="wait-for-sync"
            disabled={flushLabel === "Synchronizing…"}
            onClick={() => void waitForSync()}
          >
            {flushLabel}
          </button>
          <button data-testid="reopen-observer" onClick={() => void runDemoAction(() => window.demoActions.reopenObserver())}>
            Reopen Observer
          </button>
          <button onClick={() => void runDemoAction(() => window.demoActions.reopenInspector())}>
            Reopen Inspector
          </button>
        </div>
        {actionError !== null && <p className="inline-error">{actionError}</p>}
      </Panel>

      <Panel
        title="Visible Renderer State"
        action={<span className="panel-meta mono">rev {sync.revision} · pending {sync.pendingMutations}</span>}
      >
        <StateJson state={state} testId="controller-state" />
      </Panel>
    </div>
  );
}
