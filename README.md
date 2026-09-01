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

## Electron renderer store

Real fixed-channel Electron IPC is available through a narrow preload bridge.
Context isolation requires exposing that bridge from preload:

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

store.setState({ counter: 5 });
console.log(store.getState().counter); // 5 immediately.

store.setState((state) => ({ counter: state.counter + 1 }));

await store.flush();
// This renderer's synchronization work has settled.

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

Renderer `setState` is synchronous and optimistic. It evaluates functional
updaters once against the current visible state, validates the resulting
serializable patch, applies it locally, and then submits only that patch through
asynchronous IPC. A local visible no-op creates no mutation and performs no IPC.

The renderer keeps distinct confirmed and visible state:

```text
canonicalState + pending shallow patches in submission order = visibleState
```

Every canonical commit first updates `canonicalState`. The matching local
mutation, if present, is then removed, and all remaining pending patches are
replayed in their original order to rebuild `visibleState`. This preserves
unrelated optimistic fields and later same-key writes while main remains the
sole source of canonical revision ordering.

Commit responses and broadcasts use the same reconciliation path, so either
may arrive first without applying a transition twice. `MutationNoop` removes
the acknowledged pending mutation without advancing the renderer's canonical
revision. A definitive `MutationRejection` removes only the rejected mutation
and rebuilds visible state, while a transport failure retains the uncertain
mutation and starts snapshot recovery. Only exhausted or unrecoverable work
moves synchronization status to `error`.

## Recovery and synchronization barriers

A rejected mutation IPC Promise is treated as uncertain, not as a definitive
mutation rejection. The renderer keeps the optimistic patch and its original
`mutationId`, requests a snapshot containing every pending mutation ID, and
uses main's processed-outcome history to reconcile it:

- IDs in `appliedMutationIds` are already represented by the snapshot and are
  removed from the pending queue.
- IDs in `noopMutationIds` are removed without applying their patch or
  incrementing the canonical revision.
- Unknown IDs remain pending and are retried with the same ID and patch.

Snapshots replace the renderer's canonical state, revision, and `serverEpoch`.
Remaining pending patches are then replayed in local submission order. Commits
received during resync are buffered, discarded when already represented by the
snapshot, and otherwise applied only as a contiguous same-epoch revision
sequence. Gaps require another snapshot rather than unsafe incremental
application.

Recovery is bounded and coalesced. A renderer runs one resync at a time, allows
three mutation submission attempts and three resync attempts by default, holds
at most 1,000 pending mutations, and buffers at most 256 recovery commits.
These limits can be adjusted with `maxMutationAttempts`, `maxResyncAttempts`,
`maxPendingMutations`, and `maxBufferedCommits` when creating the renderer
store. Exhausted recovery enters `error` and exposes the terminal `Error`
through `getSyncState()`.

`flush()` resolves when this renderer is synced, has no pending mutations, and
has no recovery in flight. Multiple callers share the same underlying work.
It rejects if the store reaches terminal error or is destroyed. It is a store
synchronization barrier—not a UI rendering barrier, cross-machine durability
guarantee, or exactly-once persistence guarantee.

If main restarts, its new store lifetime has a new epoch and cannot know the
previous lifetime's in-memory mutation history. Unresolved renderer patches
are treated as local intent and retried into the new epoch with the same
mutation IDs and patches, but with the new epoch and its current canonical
revision. This MVP does not claim exactly-once durability across main-process
restarts.

## Synchronization semantics

Functional updater callbacks will run only in the process calling `setState`.
Only the resulting shallow patch will cross IPC. Consequently, functional
renderer updates are not atomic across processes. If two renderers calculate
`counter + 1` from the same visible value, both can submit the same resulting
value, and the canonical result can reflect only one increment. Same-key
conflicts use last-commit-wins ordering as assigned by the main process.

The shared protocol and all transport-boundary validators are available from
`@electron-sync-store/core`. React integration, a polished Electron demo,
durable persistence, and release hardening remain deferred.
