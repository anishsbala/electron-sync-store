# @electron-sync-store/react

Concurrent-safe React selector hooks for an initialized electron-sync-store
renderer replica.

```tsx
import { useElectronStore } from "@electron-sync-store/react";

const counter = useElectronStore(store, (state) => state.counter);
```

React 18 or newer is a peer dependency. No Provider is required.
