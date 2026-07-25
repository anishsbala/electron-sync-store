export interface ElectronSyncStoreBridge {
  connect(request: unknown): Promise<unknown>;
  submitMutation(request: unknown): Promise<unknown>;
  requestResync(request: unknown): Promise<unknown>;
  onCommit(listener: (message: unknown) => void): () => void;
}

declare global {
  interface Window {
    electronSyncStore?: ElectronSyncStoreBridge;
  }
}
