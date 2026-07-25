import {
  assertMutationResult,
  assertResyncResult,
  assertSnapshot,
  type Commit,
  type ConnectRequest,
  type MutationRequest,
  type MutationResult,
  type ResyncRequest,
  type ResyncResult,
  type Snapshot,
} from "@electron-sync-store/core";

import type { ElectronSyncStoreBridge } from "./bridge.js";

export interface RendererTransport<State extends object> {
  connect(
    request: ConnectRequest,
    onCommit: (message: unknown) => void,
  ): Promise<Snapshot<State>>;
  mutate(request: MutationRequest<State>): Promise<MutationResult<State>>;
  resync(request: ResyncRequest): Promise<ResyncResult<State>>;
  disconnect(): void;
}

function getDefaultBridge(): ElectronSyncStoreBridge {
  if (
    typeof window === "undefined" ||
    window.electronSyncStore === undefined
  ) {
    throw new Error(
      "electron-sync-store preload bridge is missing. Call exposeElectronSyncStore() from the preload script.",
    );
  }
  return window.electronSyncStore;
}

export function createPreloadRendererTransport<State extends object>(
  bridge: ElectronSyncStoreBridge = getDefaultBridge(),
): RendererTransport<State> {
  let unsubscribeCommit: (() => void) | undefined;

  return {
    async connect(request, onCommit) {
      if (unsubscribeCommit !== undefined) {
        throw new Error("Renderer transport is already connected");
      }

      unsubscribeCommit = bridge.onCommit(onCommit);
      try {
        const snapshot = await bridge.connect(request);
        assertSnapshot<State>(snapshot);
        return snapshot;
      } catch (error) {
        unsubscribeCommit();
        unsubscribeCommit = undefined;
        throw error;
      }
    },

    async mutate(request) {
      const result = await bridge.submitMutation(request);
      assertMutationResult<State>(result);
      return result;
    },

    async resync(request) {
      const result = await bridge.requestResync(request);
      assertResyncResult<State>(result);
      return result;
    },

    disconnect() {
      unsubscribeCommit?.();
      unsubscribeCommit = undefined;
    },
  };
}
