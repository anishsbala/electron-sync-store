# @electron-sync-store/core

Framework-independent typed shallow stores, serializability validation, and
shared synchronization protocol for electron-sync-store.

```ts
import { createStore } from "@electron-sync-store/core";

const store = createStore({ counter: 0 });
store.setState((state) => ({ counter: state.counter + 1 }));
```

See the repository root documentation for the complete Electron architecture
and consistency model.
