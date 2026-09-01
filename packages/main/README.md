# @electron-sync-store/main

Canonical main-process stores and Electron IPC installation for
electron-sync-store.

```ts
import { createElectronSyncMain } from "@electron-sync-store/main";

const sync = createElectronSyncMain();
const store = sync.createStore("app", { counter: 0 });
sync.installElectron();
```

Electron is a peer dependency. See the repository root documentation for
security, lifecycle, and protocol details.
