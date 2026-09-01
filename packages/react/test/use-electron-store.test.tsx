// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { MutationRequest } from "@electron-sync-store/core";
import { afterEach, describe, expect, it } from "vitest";

import { useElectronStore } from "../src/index.js";
import {
  type AppState,
  commitFor,
  hydratedStore,
  rejectionFor,
  remoteCommit,
  settle,
} from "./test-store.js";

afterEach(cleanup);

async function settleReact(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await settle();
  });
}

describe("useElectronStore", () => {
  it("infers and renders an initial primitive selection", async () => {
    const { store } = await hydratedStore();

    function Counter() {
      const counter: number = useElectronStore(
        store,
        (state) => state.counter,
      );
      return <output>{counter}</output>;
    }

    render(<Counter />);

    expect(screen.getByRole("status").textContent).toBe("0");
  });

  it("renders optimistic object and functional updates immediately", async () => {
    const { store } = await hydratedStore();
    function Counter() {
      return <output>{useElectronStore(store, (state) => state.counter)}</output>;
    }
    render(<Counter />);

    await settleReact(() => store.setState({ counter: 1 }));
    expect(screen.getByRole("status").textContent).toBe("1");

    await settleReact(() =>
      store.setState((state) => ({ counter: state.counter + 1 })),
    );
    expect(screen.getByRole("status").textContent).toBe("2");
  });

  it("does not rerender a stable selection for an own canonical acknowledgment", async () => {
    const { store, transport } = await hydratedStore();
    let renders = 0;
    function Counter() {
      renders += 1;
      return <output>{useElectronStore(store, (state) => state.counter)}</output>;
    }
    render(<Counter />);
    await settleReact(() => store.setState({ counter: 1 }));
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;
    expect(renders).toBe(2);

    await settleReact(() => {
      transport.resolveMutation(request.mutationId, commitFor(request, 11));
    });

    expect(screen.getByRole("status").textContent).toBe("1");
    expect(renders).toBe(2);
    expect(store.getSyncState()).toMatchObject({ revision: 11, pendingMutations: 0 });
  });

  it("rerenders only components whose primitive selection changed", async () => {
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
    render(<><Counter /><Theme /></>);

    await settleReact(() => {
      transport.deliverCommit(remoteCommit(11, { counter: 4 }));
    });

    expect(screen.getByTestId("counter").textContent).toBe("4");
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(counterRenders).toBe(2);
    expect(themeRenders).toBe(1);
  });

  it("uses a custom equality function for object selections", async () => {
    const { store, transport } = await hydratedStore();
    let renders = 0;
    const equalProfile = (
      left: { name: string; status: string },
      right: { name: string; status: string },
    ) => left.name === right.name && left.status === right.status;
    function Profile() {
      renders += 1;
      const profile = useElectronStore(
        store,
        (state) => ({
          name: state.profile.name,
          status: state.profile.status,
        }),
        equalProfile,
      );
      return <output>{`${profile.name}:${profile.status}`}</output>;
    }
    render(<Profile />);

    await settleReact(() => {
      transport.deliverCommit(remoteCommit(11, { theme: "light" }));
    });
    expect(renders).toBe(1);

    await settleReact(() => {
      transport.deliverCommit(
        remoteCommit(12, {
          profile: { name: "Ada", status: "away" },
        }),
      );
    });
    expect(screen.getByRole("status").textContent).toBe("Ada:away");
    expect(renders).toBe(2);
  });

  it("keeps multiple renderer stores independent", async () => {
    const first = await hydratedStore("first");
    const second = await hydratedStore(
      "second",
      {
        ...snapshotForSecond(),
      },
    );
    function Values() {
      const firstCount = useElectronStore(first.store, (state) => state.counter);
      const secondCount = useElectronStore(second.store, (state) => state.counter);
      return <output>{`${firstCount}:${secondCount}`}</output>;
    }
    render(<Values />);

    await settleReact(() => first.store.setState({ counter: 3 }));

    expect(screen.getByRole("status").textContent).toBe("3:7");
  });

  it("rerenders after a definitive rejection rolls optimistic state back", async () => {
    const { store, transport } = await hydratedStore();
    function Counter() {
      return <output>{useElectronStore(store, (state) => state.counter)}</output>;
    }
    render(<Counter />);
    await settleReact(() => store.setState({ counter: 5 }));
    expect(screen.getByRole("status").textContent).toBe("5");
    const request = transport.mutationRequests[0] as MutationRequest<AppState>;

    await settleReact(() => {
      transport.resolveMutation(request.mutationId, rejectionFor(request));
    });

    expect(screen.getByRole("status").textContent).toBe("0");
  });

  it("tolerates StrictMode subscription cycling and unmount", async () => {
    const { store } = await hydratedStore();
    let activeSubscriptions = 0;
    const originalSubscribe = store.subscribe;
    const trackedStore = {
      ...store,
      subscribe(listener: Parameters<typeof store.subscribe>[0]) {
        activeSubscriptions += 1;
        const unsubscribe = originalSubscribe(listener);
        let active = true;
        return () => {
          if (active) {
            active = false;
            activeSubscriptions -= 1;
          }
          unsubscribe();
        };
      },
    };
    function Counter() {
      return <output>{useElectronStore(trackedStore, (state) => state.counter)}</output>;
    }

    const rendered = render(<StrictMode><Counter /></StrictMode>);
    expect(screen.getByRole("status").textContent).toBe("0");
    expect(activeSubscriptions).toBe(1);

    rendered.unmount();
    expect(activeSubscriptions).toBe(0);
  });
});

function snapshotForSecond() {
  return {
    protocolVersion: 1 as const,
    storeId: "second",
    serverEpoch: "epoch-second",
    revision: 0,
    state: {
      counter: 7,
      theme: "light",
      profile: { name: "Grace", status: "offline" },
    },
  };
}
