import type { RendererStore } from "@electron-sync-store/renderer";
import { useElectronStore } from "@electron-sync-store/react";

import type { DemoWindowRole } from "../shared/demo-bridge.js";
import type { DemoState } from "../shared/demo-state.js";
import { StatusBar } from "./components/StatusBar.js";
import { SyncError } from "./components/SyncError.js";
import { Controller } from "./windows/Controller.js";
import { Inspector } from "./windows/Inspector.js";
import { Observer } from "./windows/Observer.js";

export function App({
  role,
  store,
}: {
  role: DemoWindowRole;
  store: RendererStore<DemoState>;
}) {
  const theme = useElectronStore(store, (state) => state.theme);

  return (
    <main className="app-shell" data-theme={theme} data-testid={`${role}-root`}>
      <StatusBar role={role} store={store} />
      <SyncError store={store} />
      {role === "controller" && <Controller store={store} />}
      {role === "observer" && <Observer store={store} />}
      {role === "inspector" && <Inspector store={store} />}
    </main>
  );
}
