import {
  COMMIT_CHANNEL,
  CONNECT_CHANNEL,
  MUTATE_CHANNEL,
  PROTOCOL_VERSION,
  RESYNC_CHANNEL,
} from "@electron-sync-store/core";
import { describe, expect, it, vi } from "vitest";

import {
  createElectronSyncMain,
  type ElectronFrameLike,
  type ElectronInvokeEventLike,
  type ElectronIpcHandler,
  type ElectronIpcMainLike,
  type ElectronWebContentsLike,
} from "../src/index.js";

class FakeIpcMain implements ElectronIpcMainLike {
  readonly handlers = new Map<string, ElectronIpcHandler>();

  handle(channel: string, listener: ElectronIpcHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Handler already registered for ${channel}`);
    }
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(
    channel: string,
    event: ElectronInvokeEventLike,
    request: unknown,
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}`);
    }
    return handler(event, request);
  }
}

class FakeWebContents implements ElectronWebContentsLike {
  readonly mainFrame: ElectronFrameLike;
  readonly sent: Array<{ channel: string; message: unknown }> = [];
  private readonly listeners = new Map<
    string,
    Set<(...args: unknown[]) => void>
  >();
  private destroyed = false;

  constructor(
    readonly id: number,
    frameUrl = "app://renderer/index.html",
  ) {
    this.mainFrame = { url: frameUrl };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, message: unknown): void {
    if (this.destroyed) {
      throw new Error("WebContents is destroyed");
    }
    this.sent.push({ channel, message });
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(wrapped);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

function eventFor(
  webContents: FakeWebContents,
  senderFrame: ElectronFrameLike = webContents.mainFrame,
): ElectronInvokeEventLike {
  return { sender: webContents, senderFrame };
}

function connectRequest(storeId = "app", clientId = "client-a") {
  return {
    protocolVersion: PROTOCOL_VERSION,
    storeId,
    clientId,
  };
}

describe("Electron main adapter", () => {
  it("registers fixed handlers and rejects duplicate installation", () => {
    const sync = createElectronSyncMain();
    const ipcMain = new FakeIpcMain();

    const installation = sync.installElectron({ ipcMain });

    expect([...ipcMain.handlers.keys()].sort()).toEqual(
      [CONNECT_CHANNEL, MUTATE_CHANNEL, RESYNC_CHANNEL].sort(),
    );
    expect(() => sync.installElectron({ ipcMain })).toThrow(/already installed/u);

    installation.uninstall();
    expect(ipcMain.handlers.size).toBe(0);
  });

  it("registers WebContents before snapshot acquisition", async () => {
    const sync = createElectronSyncMain();
    const store = sync.createStore("app", { counter: 0 });
    const ipcMain = new FakeIpcMain();
    sync.installElectron({ ipcMain });
    const webContents = new FakeWebContents(1);
    const originalGetSnapshot = store.getSnapshot;
    store.getSnapshot = () => {
      store.setState({ counter: 1 });
      return originalGetSnapshot();
    };

    const returned = await ipcMain.invoke(
      CONNECT_CHANNEL,
      eventFor(webContents),
      connectRequest(),
    );

    expect(webContents.sent).toHaveLength(1);
    expect(webContents.sent[0]).toMatchObject({
      channel: COMMIT_CHANNEL,
      message: { type: "commit", revision: 1 },
    });
    expect(returned).toMatchObject({ revision: 1, state: { counter: 1 } });
  });

  it("does not duplicate delivery for duplicate store connections", async () => {
    const sync = createElectronSyncMain();
    const store = sync.createStore("app", { counter: 0 });
    const ipcMain = new FakeIpcMain();
    sync.installElectron({ ipcMain });
    const webContents = new FakeWebContents(1);

    await ipcMain.invoke(CONNECT_CHANNEL, eventFor(webContents), connectRequest());
    await ipcMain.invoke(CONNECT_CHANNEL, eventFor(webContents), connectRequest());
    store.setState({ counter: 1 });

    expect(webContents.sent).toHaveLength(1);
  });

  it("supports multiple stores per WebContents and multiple WebContents per store", async () => {
    const sync = createElectronSyncMain();
    const app = sync.createStore("app", { counter: 0 });
    const settings = sync.createStore("settings", { dark: false });
    const ipcMain = new FakeIpcMain();
    sync.installElectron({ ipcMain });
    const first = new FakeWebContents(1);
    const second = new FakeWebContents(2);

    await ipcMain.invoke(CONNECT_CHANNEL, eventFor(first), connectRequest());
    await ipcMain.invoke(
      CONNECT_CHANNEL,
      eventFor(first),
      connectRequest("settings", "client-settings"),
    );
    await ipcMain.invoke(
      CONNECT_CHANNEL,
      eventFor(second),
      connectRequest("app", "client-b"),
    );
    app.setState({ counter: 1 });
    settings.setState({ dark: true });

    expect(first.sent).toHaveLength(2);
    expect(second.sent).toHaveLength(1);
  });

  it("routes mutations and broadcasts their Commit once", async () => {
    const sync = createElectronSyncMain();
    const store = sync.createStore("app", { counter: 0 });
    const ipcMain = new FakeIpcMain();
    sync.installElectron({ ipcMain });
    const webContents = new FakeWebContents(1);
    await ipcMain.invoke(CONNECT_CHANNEL, eventFor(webContents), connectRequest());

    const result = await ipcMain.invoke(MUTATE_CHANNEL, eventFor(webContents), {
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      serverEpoch: store.getServerEpoch(),
      clientId: "client-a",
      mutationId: "mutation-1",
      baseRevision: 0,
      patch: { counter: 1 },
    });

    expect(result).toMatchObject({ type: "commit", revision: 1 });
    expect(store.getState().counter).toBe(1);
    expect(webContents.sent).toHaveLength(1);
  });

  it("requires mutation client identity to match the connected sender", async () => {
    const sync = createElectronSyncMain();
    const store = sync.createStore("app", { counter: 0 });
    const ipcMain = new FakeIpcMain();
    sync.installElectron({ ipcMain });
    const webContents = new FakeWebContents(1);
    await ipcMain.invoke(CONNECT_CHANNEL, eventFor(webContents), connectRequest());

    const result = await ipcMain.invoke(MUTATE_CHANNEL, eventFor(webContents), {
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      serverEpoch: store.getServerEpoch(),
      clientId: "forged-client",
      mutationId: "mutation-1",
      baseRevision: 0,
      patch: { counter: 1 },
    });

    expect(result).toMatchObject({ type: "rejected", code: "unauthorized" });
    expect(store.getState().counter).toBe(0);
    expect(webContents.sent).toHaveLength(0);
  });

  it("returns MutationNoop without broadcasting it", async () => {
    const sync = createElectronSyncMain();
    const store = sync.createStore("app", { counter: 0 });
    const ipcMain = new FakeIpcMain();
    sync.installElectron({ ipcMain });
    const webContents = new FakeWebContents(1);
    await ipcMain.invoke(CONNECT_CHANNEL, eventFor(webContents), connectRequest());

    const result = await ipcMain.invoke(MUTATE_CHANNEL, eventFor(webContents), {
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      serverEpoch: store.getServerEpoch(),
      clientId: "client-a",
      mutationId: "mutation-1",
      baseRevision: 0,
      patch: { counter: 0 },
    });

    expect(result).toMatchObject({ type: "noop", revision: 0 });
    expect(webContents.sent).toHaveLength(0);
  });

  it("routes stale-epoch resync for the connected client", async () => {
    const sync = createElectronSyncMain();
    const store = sync.createStore("app", { counter: 0 });
    const ipcMain = new FakeIpcMain();
    sync.installElectron({ ipcMain });
    const webContents = new FakeWebContents(1);
    await ipcMain.invoke(CONNECT_CHANNEL, eventFor(webContents), connectRequest());
    store.setState({ counter: 1 });

    const result = await ipcMain.invoke(RESYNC_CHANNEL, eventFor(webContents), {
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      clientId: "client-a",
      serverEpoch: "old-epoch",
      knownRevision: 0,
      pendingMutationIds: [],
    });

    expect(result).toMatchObject({
      snapshot: {
        serverEpoch: store.getServerEpoch(),
        revision: 1,
        state: { counter: 1 },
      },
    });
  });

  it("removes destroyed and navigating WebContents registrations", async () => {
    const sync = createElectronSyncMain();
    const store = sync.createStore("app", { counter: 0 });
    const ipcMain = new FakeIpcMain();
    sync.installElectron({ ipcMain });
    const destroyed = new FakeWebContents(1);
    const navigating = new FakeWebContents(2);
    await ipcMain.invoke(CONNECT_CHANNEL, eventFor(destroyed), connectRequest());
    await ipcMain.invoke(
      CONNECT_CHANNEL,
      eventFor(navigating),
      connectRequest("app", "client-b"),
    );

    destroyed.destroy();
    navigating.emit("did-start-navigation");
    store.setState({ counter: 1 });

    expect(destroyed.sent).toHaveLength(0);
    expect(navigating.sent).toHaveLength(0);
  });

  it("rejects subframes and applies the optional authorization hook", async () => {
    const sync = createElectronSyncMain();
    sync.createStore("app", { counter: 0 });
    const ipcMain = new FakeIpcMain();
    const authorizeRenderer = vi.fn(() => false);
    sync.installElectron({ ipcMain, authorizeRenderer });
    const webContents = new FakeWebContents(1);

    await expect(
      ipcMain.invoke(
        CONNECT_CHANNEL,
        eventFor(webContents, { url: "app://renderer/frame.html" }),
        connectRequest(),
      ),
    ).rejects.toThrow(/not authorized/u);
    expect(authorizeRenderer).not.toHaveBeenCalled();

    await expect(
      ipcMain.invoke(CONNECT_CHANNEL, eventFor(webContents), connectRequest()),
    ).rejects.toThrow(/not authorized/u);
    expect(authorizeRenderer).toHaveBeenCalledWith({
      webContentsId: 1,
      frameUrl: "app://renderer/index.html",
      storeId: "app",
    });
  });
});
