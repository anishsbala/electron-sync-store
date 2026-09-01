# @electron-sync-store/main

Canonical main-process stores and Electron IPC installation for
electron-sync-store.

```ts
import { createElectronSyncMain } from "@electron-sync-store/main";

const sync = createElectronSyncMain();
const store = sync.createStore("app", { counter: 0 });
sync.installElectron();
```

Electron is a peer dependency. See the
[repository documentation](https://github.com/anishsbala/electron-sync-store#readme)
for security, lifecycle, and protocol details.
