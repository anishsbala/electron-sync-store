import { useCallback } from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector";

import type { RendererStore } from "@electron-sync-store/renderer";

export type ElectronStoreSelector<State extends object, Selection> = (
  state: Readonly<State>,
) => Selection;

export type ElectronStoreEquality<Selection> = (
  left: Selection,
  right: Selection,
) => boolean;

export function useElectronStore<State extends object, Selection>(
  store: RendererStore<State>,
  selector: ElectronStoreSelector<State, Selection>,
  equalityFn: ElectronStoreEquality<Selection> = Object.is,
): Selection {
  const subscribe = useCallback(
    (notify: () => void) => store.subscribe(notify),
    [store],
  );
  const getSnapshot = useCallback(() => store.getState(), [store]);

  return useSyncExternalStoreWithSelector(
    subscribe,
    getSnapshot,
    getSnapshot,
    selector,
    equalityFn,
  );
}
