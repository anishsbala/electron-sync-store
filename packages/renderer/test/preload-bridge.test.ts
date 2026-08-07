import {
  COMMIT_CHANNEL,
  CONNECT_CHANNEL,
  MUTATE_CHANNEL,
  PROTOCOL_VERSION,
  RESYNC_CHANNEL,
} from "@electron-sync-store/core";
import { describe, expect, it, vi } from "vitest";

import type { ElectronSyncStoreBridge } from "../src/index.js";
import { createPreloadRendererTransport } from "../src/index.js";
import {
  createPreloadBridge,
  type PreloadIpcRendererLike,
} from "../src/preload/preload-bridge.js";

class FakeIpcRenderer implements PreloadIpcRendererLike {
  readonly invokes: Array<{ channel: string; request: unknown }> = [];
  readonly listeners = new Map<
    string,
    Set<(event: unknown, message: unknown) => void>
  >();

  async invoke(channel: string, request: unknown): Promise<unknown> {
    this.invokes.push({ channel, request });
    return { channel };
  }

  on(
    channel: string,
    listener: (event: unknown, message: unknown) => void,
  ): this {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
    return this;
  }

  removeListener(
    channel: string,
    listener: (event: unknown, message: unknown) => void,
  ): this {
    this.listeners.get(channel)?.delete(listener);
    return this;
  }

  emit(channel: string, message: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      listener({ secretElectronEvent: true }, message);
    }
  }
}

describe("preload bridge", () => {
  it("uses only the fixed protocol channels", async () => {
    const ipcRenderer = new FakeIpcRenderer();
    const bridge = createPreloadBridge(ipcRenderer);
    const request = { storeId: "app" };

    await bridge.connect(request);
    await bridge.submitMutation(request);
    await bridge.requestResync(request);

    expect(ipcRenderer.invokes).toEqual([
      { channel: CONNECT_CHANNEL, request },
      { channel: MUTATE_CHANNEL, request },
      { channel: RESYNC_CHANNEL, request },
    ]);
  });

  it("forwards commit messages without exposing Electron events", () => {
    const ipcRenderer = new FakeIpcRenderer();
    const bridge = createPreloadBridge(ipcRenderer);
    const listener = vi.fn();
    const unsubscribe = bridge.onCommit(listener);

    ipcRenderer.emit(COMMIT_CHANNEL, { type: "commit" });
    unsubscribe();
    ipcRenderer.emit(COMMIT_CHANNEL, { type: "commit", revision: 2 });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ type: "commit" });
    expect(ipcRenderer.listeners.get(COMMIT_CHANNEL)?.size).toBe(0);
  });

  it("installs commit observation before invoking connect", async () => {
    const events: string[] = [];
    const bridge: ElectronSyncStoreBridge = {
      onCommit() {
        events.push("subscribe");
        return () => events.push("unsubscribe");
      },
      async connect() {
        events.push("connect");
        return {
          protocolVersion: PROTOCOL_VERSION,
          storeId: "app",
          serverEpoch: "epoch-1",
          revision: 0,
          state: { counter: 0 },
        };
      },
      async submitMutation() {
        throw new Error("not used");
      },
      async requestResync() {
        throw new Error("not used");
      },
    };
    const transport = createPreloadRendererTransport<{ counter: number }>(bridge);

    await transport.connect(
      { protocolVersion: PROTOCOL_VERSION, storeId: "app", clientId: "client" },
      () => undefined,
    );
    transport.disconnect();

    expect(events).toEqual(["subscribe", "connect", "unsubscribe"]);
  });
});
