# @electron-sync-store/core

Framework-independent typed shallow stores, serializability validation, and
shared synchronization protocol for electron-sync-store.

```ts
import { createStore } from "@electron-sync-store/core";

const store = createStore({ counter: 0 });
store.setState((state) => ({ counter: state.counter + 1 }));
```

See the [repository documentation](https://github.com/anishsbala/electron-sync-store#readme)
for the complete Electron architecture and consistency model.
