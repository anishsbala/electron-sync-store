import type {
  Commit,
  ConnectRequest,
  MutationRequest,
  MutationResult,
  ResyncRequest,
  ResyncResult,
  Snapshot,
} from "../packages/core/src/index.js";
import { createMainStore } from "../packages/main/src/index.js";
import {
  createRendererStore,
  type RendererStore,
  type RendererTransport,
} from "../packages/renderer/src/index.js";
import { describe, expect, it } from "vitest";

interface AppState {
  counter: number;
  theme: string;
}

interface QueuedMutation {
  readonly request: MutationRequest<AppState>;
  readonly resolve: (result: MutationResult<AppState>) => void;
}

class InMemoryCoordinator {
  readonly canonical = createMainStore("app", {
    counter: 0,
    theme: "dark",
  });

  private readonly listeners = new Map<
    string,
    (message: unknown) => void
  >();
  private readonly queuedMutations: QueuedMutation[] = [];

  constructor() {
    this.canonical.subscribeCommits((commit) => {
      for (const listener of [...this.listeners.values()]) {
        listener(commit);
      }
    });
  }

  createTransport(): RendererTransport<AppState> {
    let clientId: string | undefined;
    return {
      connect: async (
        request: ConnectRequest,
        onCommit: (message: unknown) => void,
      ): Promise<Snapshot<AppState>> => {
        clientId = request.clientId;
        this.listeners.set(request.clientId, onCommit);
        return this.canonical.getSnapshot();
      },
      mutate: (request: MutationRequest<AppState>) =>
        new Promise<MutationResult<AppState>>((resolve) => {
          this.queuedMutations.push({ request, resolve });
        }),
      resync: async (request: ResyncRequest): Promise<ResyncResult<AppState>> =>
        this.canonical.handleResync(request),
      disconnect: () => {
        if (clientId !== undefined) {
          this.listeners.delete(clientId);
        }
      },
    };
  }

  processMutationFrom(clientId: string): void {
    const index = this.queuedMutations.findIndex(
      (queued) => queued.request.clientId === clientId,
    );
    if (index === -1) {
      throw new Error(`No queued mutation for client "${clientId}"`);
    }
    const [queued] = this.queuedMutations.splice(index, 1);
    if (queued === undefined) {
      throw new Error("Queued mutation disappeared");
    }
    queued.resolve(this.canonical.handleMutation(queued.request));
  }
}

async function createPair(): Promise<{
  coordinator: InMemoryCoordinator;
  rendererA: RendererStore<AppState>;
  rendererB: RendererStore<AppState>;
}> {
  const coordinator = new InMemoryCoordinator();
  const [rendererA, rendererB] = await Promise.all([
    createRendererStore<AppState>({
      id: "app",
      transport: coordinator.createTransport(),
    }),
    createRendererStore<AppState>({
      id: "app",
      transport: coordinator.createTransport(),
    }),
  ]);
  return { coordinator, rendererA, rendererB };
}

async function settleMutations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("concurrent renderer convergence", () => {
  it("composes different-key writes through canonical ordering", async () => {
    const { coordinator, rendererA, rendererB } = await createPair();
    rendererA.setState({ counter: 5 });
    rendererB.setState({ theme: "light" });

    coordinator.processMutationFrom(rendererA.getSyncState().clientId);
    coordinator.processMutationFrom(rendererB.getSyncState().clientId);
    await settleMutations();

    const expected = { counter: 5, theme: "light" };
    expect(coordinator.canonical.getState()).toEqual(expected);
    expect(rendererA.getState()).toEqual(expected);
    expect(rendererB.getState()).toEqual(expected);
    expect(rendererA.getSyncState()).toMatchObject({ revision: 2, pendingMutations: 0 });
    expect(rendererB.getSyncState()).toMatchObject({ revision: 2, pendingMutations: 0 });
  });

  it("uses A-then-B main processing order for same-key conflicts", async () => {
    const { coordinator, rendererA, rendererB } = await createPair();
    rendererA.setState({ counter: 5 });
    rendererB.setState({ counter: 10 });

    coordinator.processMutationFrom(rendererA.getSyncState().clientId);
    coordinator.processMutationFrom(rendererB.getSyncState().clientId);
    await settleMutations();

    expect(coordinator.canonical.getState().counter).toBe(10);
    expect(rendererA.getState().counter).toBe(10);
    expect(rendererB.getState().counter).toBe(10);
  });

  it("uses B-then-A main processing order for same-key conflicts", async () => {
    const { coordinator, rendererA, rendererB } = await createPair();
    rendererA.setState({ counter: 5 });
    rendererB.setState({ counter: 10 });

    coordinator.processMutationFrom(rendererB.getSyncState().clientId);
    coordinator.processMutationFrom(rendererA.getSyncState().clientId);
    await settleMutations();

    expect(coordinator.canonical.getState().counter).toBe(5);
    expect(rendererA.getState().counter).toBe(5);
    expect(rendererB.getState().counter).toBe(5);
  });
});
