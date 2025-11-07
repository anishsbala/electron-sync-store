# electron-sync-store

`electron-sync-store` is an in-progress TypeScript library for sharing a
Zustand-like state store between Electron's main process and isolated renderer
processes.

Phase 1 provides the framework-independent local store in
`@electron-sync-store/core`:

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

## Planned synchronization semantics

Functional updater callbacks will run only in the process calling `setState`.
Only the resulting shallow patch will cross IPC. Consequently, functional
renderer updates are not atomic across processes. If two renderers calculate
`counter + 1` from the same visible value, both can submit the same resulting
value, and the canonical result can reflect only one increment. Same-key
conflicts use last-commit-wins ordering as assigned by the main process.

Electron transports, renderer replication, the preload bridge, and React
integration are deferred to later phases.
