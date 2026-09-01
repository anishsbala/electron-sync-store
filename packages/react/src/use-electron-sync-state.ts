import { useCallback, useSyncExternalStore } from "react";

import type {
  RendererStore,
  RendererSyncState,
} from "@electron-sync-store/renderer";

export function useElectronSyncState<State extends object>(
  store: RendererStore<State>,
): Readonly<RendererSyncState> {
  const subscribe = useCallback(
    (notify: () => void) => store.subscribeSync(notify),
    [store],
  );
  const getSnapshot = useCallback(() => store.getSyncState(), [store]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
