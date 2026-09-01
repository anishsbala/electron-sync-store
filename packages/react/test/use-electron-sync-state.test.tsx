// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import type { MutationRequest } from "@electron-sync-store/core";
import { afterEach, describe, expect, it } from "vitest";

import { useElectronStore, useElectronSyncState } from "../src/index.js";
import {
  type AppState,
  commitFor,
  hydratedStore,
  noopFor,
  resyncResponse,
  settle,
  snapshot,
} from "./test-store.js";

afterEach(cleanup);

async function settleReact(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await settle();
  });
}

describe("useElectronSyncState", () => {
  it("observes pending and canonical revision transitions", async () => {
    const { store, transport } = await hydratedStore();
    function SyncStatus() {
      const sync = useElectronSyncState(store);
      return <output>{`${sync.status}:${sync.revision}:${sync.pendingMutations}`}</output>;
    }
    render(<SyncStatus />);
    expect(screen.getByRole("status").textContent).toBe("synced:10:0");

    await settleReact(() => store.setState({ counter: 1 }));
    expect(screen.getByRole("status").textContent).toBe("synced:10:1");
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;

    await settleReact(() => {
      transport.resolveMutation(request.mutationId, commitFor(request, 11));
    });
    expect(screen.getByRole("status").textContent).toBe("synced:11:0");
  });

  it("separates no-op metadata rendering from stable application selection", async () => {
    const { store, transport } = await hydratedStore();
    let stateRenders = 0;
    let syncRenders = 0;
    function Counter() {
      stateRenders += 1;
      return <output data-testid="counter">{useElectronStore(store, (state) => state.counter)}</output>;
    }
    function SyncStatus() {
      syncRenders += 1;
      const sync = useElectronSyncState(store);
      return <output data-testid="sync">{sync.pendingMutations}</output>;
    }
    render(<><Counter /><SyncStatus /></>);
    await settleReact(() => {
      store.setState({ counter: 1 });
      store.setState({ counter: 2 });
    });
    const first = transport.mutationRequests[0] as MutationRequest<AppState>;
    const rendersBeforeNoop = { state: stateRenders, sync: syncRenders };

    await settleReact(() => {
      transport.resolveMutation(first.mutationId, noopFor(first));
    });

    expect(screen.getByTestId("counter").textContent).toBe("2");
    expect(screen.getByTestId("sync").textContent).toBe("1");
    expect(stateRenders).toBe(rendersBeforeNoop.state);
    expect(syncRenders).toBe(rendersBeforeNoop.sync + 1);
  });

  it("reflects recovery while optimistic state survives snapshot rebasing", async () => {
    const { store, transport } = await hydratedStore();
    let counterRenders = 0;
    let themeRenders = 0;
    function Counter() {
      counterRenders += 1;
      return <output data-testid="counter">{useElectronStore(store, (state) => state.counter)}</output>;
    }
    function Theme() {
      themeRenders += 1;
      return <output data-testid="theme">{useElectronStore(store, (state) => state.theme)}</output>;
    }
    function SyncStatus() {
      const sync = useElectronSyncState(store);
      return <output data-testid="sync">{`${sync.status}:${sync.pendingMutations}`}</output>;
    }
    render(<><Counter /><Theme /><SyncStatus /></>);
    await settleReact(() => store.setState({ counter: 5 }));
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;
    const counterBeforeRecovery = counterRenders;
    const themeBeforeRecovery = themeRenders;

    await settleReact(() => {
      transport.rejectMutation(request.mutationId, new Error("response lost"));
    });
    expect(screen.getByTestId("sync").textContent).toBe("resyncing:1");
    expect(screen.getByTestId("counter").textContent).toBe("5");

    await settleReact(() => {
      transport.resolveResync(
        resyncResponse(
          snapshot(
            "app",
            11,
            {
              counter: 0,
              theme: "light",
              profile: { name: "Ada", status: "online" },
            },
          ),
        ),
      );
    });

    expect(screen.getByTestId("counter").textContent).toBe("5");
    expect(screen.getByTestId("theme").textContent).toBe("light");
    expect(screen.getByTestId("sync").textContent).toBe("synced:1");
    expect(counterRenders).toBe(counterBeforeRecovery);
    expect(themeRenders).toBe(themeBeforeRecovery + 1);

    const retry = transport.mutationRequests[1] as MutationRequest<AppState>;
    await settleReact(() => {
      transport.resolveMutation(retry.mutationId, commitFor(retry, 12));
    });
    expect(screen.getByTestId("sync").textContent).toBe("synced:0");
  });

  it("observes a terminal synchronization error", async () => {
    const { store, transport } = await hydratedStore(
      "app",
      snapshot(),
      { maxMutationAttempts: 1 },
    );
    function SyncStatus() {
      const sync = useElectronSyncState(store);
      return <output>{sync.status}</output>;
    }
    render(<SyncStatus />);
    await settleReact(() => store.setState({ counter: 5 }));
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;
    await settleReact(() => {
      transport.rejectMutation(request.mutationId, new Error("uncertain"));
    });

    await settleReact(() => {
      transport.resolveResync(resyncResponse(snapshot()));
    });

    expect(screen.getByRole("status").textContent).toBe("error");
  });

  it("keeps state and synchronization snapshot references stable", async () => {
    const { store } = await hydratedStore();

    expect(store.getState()).toBe(store.getState());
    expect(store.getSyncState()).toBe(store.getSyncState());
  });

  it("unsubscribes sync observation without destroying the store", async () => {
    const { store } = await hydratedStore();
    let activeSubscriptions = 0;
    const originalSubscribeSync = store.subscribeSync;
    const trackedStore = {
      ...store,
      subscribeSync(listener: Parameters<typeof store.subscribeSync>[0]) {
        activeSubscriptions += 1;
        const unsubscribe = originalSubscribeSync(listener);
        return () => {
          if (activeSubscriptions > 0) {
            activeSubscriptions -= 1;
          }
          unsubscribe();
        };
      },
    };
    function SyncStatus() {
      return <output>{useElectronSyncState(trackedStore).status}</output>;
    }

    const rendered = render(<SyncStatus />);
    expect(activeSubscriptions).toBe(1);
    rendered.unmount();

    expect(activeSubscriptions).toBe(0);
    expect(store.getSyncState().status).toBe("synced");
  });
});
