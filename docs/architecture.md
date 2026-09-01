# Architecture

## Package boundaries

```text
@electron-sync-store/core
  state primitives, patch semantics, protocol types, validators, channels
        |
        +--> @electron-sync-store/main
        |      canonical stores, registry, Electron main adapter
        |
        +--> @electron-sync-store/renderer
               renderer state machine, transport abstraction, preload adapter
                         |
                         +--> @electron-sync-store/react
                                external-store selector hooks
```

The canonical store, registry, and renderer state machine do not import
Electron. Electron imports are isolated to the main adapter and
`@electron-sync-store/renderer/preload`. React is isolated to the React
package.

## Canonical main store

A named main store owns:

- canonical state;
- a random `serverEpoch` for that store lifetime;
- a revision beginning at zero;
- synchronous state and Commit subscribers;
- an in-memory map from mutation ID to successful Commit or MutationNoop.

Main applies one mutation at a time without asynchronous work inside state
application or revision assignment. A real shallow change increments revision
once and emits one Commit. An Object.is-equivalent patch returns MutationNoop
without replacing state, consuming a revision, or broadcasting.

A repeated successful mutation ID returns its original stored outcome without
another state transition. Stale `baseRevision` values remain informational;
main processing order is authoritative.

## Electron main adapter

The adapter registers fixed handlers for connect, mutate, and resync. It keeps
WebContents subscriptions separate from the canonical registry.

Connection ordering is deliberate:

```text
authorize sender
  -> register WebContents/store/client binding
  -> capture canonical snapshot
  -> return snapshot
```

Registering first prevents a snapshot/subscription race. A Commit occurring
during the handshake may arrive before the snapshot response, so renderer
initialization buffers it.

Mutation and resync calls must come from the sender's main frame and match the
WebContents/store/client binding established by connect. Destroyed, navigated,
or crashed WebContents registrations are removed. Broadcast failures also
remove stale registrations.

## Renderer state

A renderer owns four related values:

```text
canonicalState
canonicalRevision
pendingMutations[]
visibleState
```

Its public state is:

```text
visibleState = canonicalState + pending patches in local submission order
```

`getState()` reads the stored visible-state reference. It performs no IPC.

### Local mutation lifecycle

A renderer `setState()`:

1. evaluates a functional updater once against `visibleState`, if supplied;
2. validates the resulting shallow serializable patch;
3. ignores a local Object.is no-op;
4. creates a random mutation ID and records the current canonical revision;
5. appends the pending mutation;
6. updates `visibleState` and synchronization metadata;
7. synchronously notifies local subscribers;
8. starts asynchronous transport submission.

The updater function is never retained, replayed, or transmitted. Only its
resulting patch is replayed.

### Commit reconciliation

All Commits, whether received as a submission response or broadcast, use the
same processor:

```text
apply Commit.patch to canonicalState
  -> advance canonicalRevision
  -> remove matching pending mutation
  -> replay every remaining pending patch
  -> publish visibleState
```

A revision already applied is stale or duplicate. It does not transition
canonical state twice. If it acknowledges a still-pending mutation, that entry
can be removed conservatively and visible state rebuilt.

Commit revisions must be contiguous within the current epoch. A gap is never
applied directly.

### MutationNoop and MutationRejection

MutationNoop confirms successful processing without a canonical transition.
The renderer removes that pending mutation, retains the current revision, and
rebuilds visible state.

A definitive MutationRejection means main confirms the mutation was not
applied. The renderer removes only that mutation and rebuilds visible state,
preserving later pending work. A stale-epoch rejection triggers recovery
instead of ordinary rollback.

A rejected transport Promise is different: the result is unknown, so the
pending mutation remains visible.

## Recovery

Gap, epoch mismatch, stale-epoch rejection, or uncertain transport failure
enters one coalesced resync operation. Incoming valid Commits are buffered while
resyncing.

The ResyncRequest contains every unresolved mutation ID. Its response provides
a current snapshot plus mutation IDs already committed or acknowledged as
no-ops.

Snapshot installation:

1. replaces canonical state, epoch, and revision;
2. removes applied and no-op mutation IDs;
3. retains unknown pending mutations in original order;
4. rebuilds visible state from the snapshot plus retained patches;
5. discards buffered Commits already represented by the snapshot;
6. applies only a contiguous same-epoch buffered sequence;
7. starts another resync if a gap remains;
8. retries unresolved mutations with the same ID and patch.

After an epoch change, unresolved mutations use the new epoch and current
canonical revision as their next request base. Their functional updaters are
not rerun.

Attempts, resyncs, pending mutations, and recovery Commit buffering are bounded.
Exhaustion enters terminal error without silently deleting uncertain intent.

## flush

`flush()` resolves when:

- status is `synced`;
- no pending mutations remain;
- no mutation submission is uncertain;
- no resync is active.

Multiple callers wait on the same synchronization progress. Terminal error or
destroy rejects all waiters. It is not a UI render or persistence barrier.

## React adapter

`useElectronStore` adapts `RendererStore.subscribe` and `getState` to
React's external-store selector helper. It observes visible optimistic state and
uses Object.is equality by default.

`useElectronSyncState` observes the stored synchronization snapshot through
`subscribeSync`. State and sync snapshot references remain stable between
actual transitions, which is required by `useSyncExternalStore`.

React keeps no second application-state copy and does not own store lifecycle.

## IPC trust boundaries

Transport values enter as `unknown` and are runtime-validated. The preload
exposes protocol-specific operations, not raw `ipcRenderer` or generic channel
methods. Electron event objects never cross the context bridge.

Applications remain responsible for secure BrowserWindow settings, trusted
preload delivery, navigation policy, and any origin/store authorization policy
beyond the adapter's default main-frame and client-binding checks.
