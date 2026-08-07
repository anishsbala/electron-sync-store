import type {
  Commit,
  ConnectRequest,
  MutationRequest,
  MutationResult,
  ResyncRequest,
  ResyncResult,
  Snapshot,
} from "@electron-sync-store/core";

import type { RendererTransport } from "../src/index.js";

export class FakeRendererTransport<State extends object>
  implements RendererTransport<State>
{
  readonly connectRequests: ConnectRequest[] = [];
  readonly mutationRequests: MutationRequest<State>[] = [];
  readonly resyncRequests: ResyncRequest[] = [];
  disconnectCount = 0;
  resyncResult: ResyncResult<State> | undefined;
  mutationResult: MutationResult<State> | undefined;

  private commitListener: ((message: unknown) => void) | undefined;
  private resolveConnection: ((snapshot: Snapshot<State>) => void) | undefined;
  private rejectConnection: ((error: unknown) => void) | undefined;

  connect(
    request: ConnectRequest,
    onCommit: (message: unknown) => void,
  ): Promise<Snapshot<State>> {
    this.connectRequests.push(request);
    this.commitListener = onCommit;
    return new Promise<Snapshot<State>>((resolve, reject) => {
      this.resolveConnection = resolve;
      this.rejectConnection = reject;
    });
  }

  resolveConnect(snapshot: Snapshot<State>): void {
    if (this.resolveConnection === undefined) {
      throw new Error("connect() has not been called");
    }
    this.resolveConnection(snapshot);
  }

  rejectConnect(error: unknown): void {
    if (this.rejectConnection === undefined) {
      throw new Error("connect() has not been called");
    }
    this.rejectConnection(error);
  }

  deliverCommit(message: Commit<State> | unknown): void {
    if (this.commitListener === undefined) {
      throw new Error("connect() has not installed a commit listener");
    }
    this.commitListener(message);
  }

  async mutate(request: MutationRequest<State>): Promise<MutationResult<State>> {
    this.mutationRequests.push(request);
    if (this.mutationResult === undefined) {
      throw new Error("No fake mutation result configured");
    }
    return this.mutationResult;
  }

  async resync(request: ResyncRequest): Promise<ResyncResult<State>> {
    this.resyncRequests.push(request);
    if (this.resyncResult === undefined) {
      throw new Error("No fake resync result configured");
    }
    return this.resyncResult;
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }
}
