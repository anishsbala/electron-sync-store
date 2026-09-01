# @electron-sync-store/renderer

Optimistic Electron renderer replicas and the narrow context-isolated preload
bridge for electron-sync-store.

```ts
import { createRendererStore } from "@electron-sync-store/renderer";

const store = await createRendererStore<{ counter: number }>({ id: "app" });
store.setState({ counter: 1 });
await store.flush();
```

Expose the bridge from preload with
`@electron-sync-store/renderer/preload`. Electron is a peer dependency.

[Full documentation](https://github.com/anishsbala/electron-sync-store#readme)
