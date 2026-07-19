export { createMainStore } from "./main-store.js";
export type {
  CommitListener,
  MainStore,
  MainStoreOptions,
} from "./main-store.js";
export { createElectronSyncMain } from "./store-registry.js";
export type { MainStoreRegistry } from "./store-registry.js";
export type {
  ElectronFrameLike,
  ElectronInvokeEventLike,
  ElectronIpcHandler,
  ElectronIpcMainLike,
  ElectronMainInstallation,
  ElectronMainInstallOptions,
  ElectronWebContentsLike,
  RendererAuthorizationContext,
} from "./electron-main-adapter.js";
