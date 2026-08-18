# electron-sync-store

`electron-sync-store` is an in-progress TypeScript library for sharing a
Zustand-like state store between Electron's main process and isolated renderer
processes.

The framework-independent local store lives in `@electron-sync-store/core`:

```ts
import { createStore } from "@electron-sync-store/core";

const store = createStore({ counter: 0, label: "ready" });

store.setState({ counter: 5 });
store.setState((state) => ({ counter: state.counter + 1 }));

const unsubscribe = store.subscribe((state, previousState) => {
  console.log(previousState.counter, state.counter);
});
```

Updates are shallow patches. They are applied synchronously, and subscribers
are notified synchronously after a real top-level change. A patch is a no-op
when every supplied property is unchanged according to `Object.is`.

State and patches must contain only IPC-safe serializable values. The core
validator accepts finite numbers, strings, booleans, `null`, dense arrays, and
plain objects composed recursively from those values.

## Canonical main store

The Electron-independent canonical store and named registry live in
`@electron-sync-store/main`:

```ts
import { createElectronSyncMain } from "@electron-sync-store/main";

const sync = createElectronSyncMain();
const appStore = sync.createStore("app", { counter: 0 });
sync.installElectron();

appStore.setState((state) => ({ counter: state.counter + 1 }));
```

Each canonical store lifetime has a random `serverEpoch` and revisions starting
at zero. Real shallow changes consume one revision and emit one `Commit`.
Canonical no-ops consume no revision, notify no subscribers, and emit no
commit. Renderer-originated canonical no-ops return `MutationNoop` so a future
replica can remove its optimistic pending mutation.

Successful renderer outcomes (`Commit` and `MutationNoop`) are deduplicated by
`mutationId` for the store lifetime. Transient rejections such as
`stale-server-epoch` are not retained. Resync responses include the current
snapshot and identify pending mutation IDs already committed or acknowledged
as no-ops.

## Electron renderer bootstrap

Phase 3 provides real fixed-channel Electron IPC. Context isolation requires
the narrow preload bridge:

```ts
// preload.ts
import { exposeElectronSyncStore } from "@electron-sync-store/renderer/preload";

exposeElectronSyncStore();
```

Renderer initialization is asynchronous because it obtains the canonical
snapshot before returning:

```ts
import { createRendererStore } from "@electron-sync-store/renderer";

const store = await createRendererStore<{ counter: number }>({ id: "app" });

store.getState(); // Synchronous local-memory read after hydration.
store.subscribe((state, previousState) => {
  console.log(previousState.counter, state.counter);
});
```

The preload exposes only connect, mutation submission, resync, and commit
observation methods. It never exposes `ipcRenderer` or arbitrary channels.
The main adapter accepts only the sender's main frame by default and can apply
an additional `authorizeRenderer` hook.

Main registers a renderer for commit broadcasts before capturing its snapshot.
The renderer therefore buffers commits while `connect()` is unresolved,
discards revisions already represented by the snapshot, applies contiguous
commits, and requests an initialization resync for gaps or epoch changes.
Commit delivery remains asynchronous, while hydrated reads and subscriptions
are entirely local.

Renderer `setState` is intentionally absent in Phase 3. Optimistic patches and
pending-mutation reconciliation are reserved for Phase 4.

## Synchronization semantics

Functional updater callbacks will run only in the process calling `setState`.
Only the resulting shallow patch will cross IPC. Consequently, functional
renderer updates are not atomic across processes. If two renderers calculate
`counter + 1` from the same visible value, both can submit the same resulting
value, and the canonical result can reflect only one increment. Same-key
conflicts use last-commit-wins ordering as assigned by the main process.

The shared protocol and all transport-boundary validators are available from
`@electron-sync-store/core`. Optimistic renderer mutations, full ongoing gap
recovery, retry/flush behavior, and React integration remain deferred.
