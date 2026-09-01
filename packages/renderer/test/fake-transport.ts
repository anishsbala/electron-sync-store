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

interface DeferredMutation<State extends object> {
  readonly request: MutationRequest<State>;
  readonly resolve: (result: MutationResult<State>) => void;
  readonly reject: (error: unknown) => void;
}

interface DeferredResync<State extends object> {
  readonly request: ResyncRequest;
  readonly resolve: (result: ResyncResult<State>) => void;
  readonly reject: (error: unknown) => void;
}

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
  private readonly deferredMutations: DeferredMutation<State>[] = [];
  private readonly deferredResyncs: DeferredResync<State>[] = [];

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

  mutate(request: MutationRequest<State>): Promise<MutationResult<State>> {
    this.mutationRequests.push(request);
    if (this.mutationResult !== undefined) {
      return Promise.resolve(this.mutationResult);
    }
    return new Promise<MutationResult<State>>((resolve, reject) => {
      this.deferredMutations.push({ request, resolve, reject });
    });
  }

  resolveMutation(
    mutationId: string,
    result: MutationResult<State>,
  ): void {
    const deferred = this.takeDeferredMutation(mutationId);
    deferred.resolve(result);
  }

  rejectMutation(mutationId: string, error: unknown): void {
    const deferred = this.takeDeferredMutation(mutationId);
    deferred.reject(error);
  }

  get pendingMutationCount(): number {
    return this.deferredMutations.length;
  }

  private takeDeferredMutation(mutationId: string): DeferredMutation<State> {
    const index = this.deferredMutations.findIndex(
      (deferred) => deferred.request.mutationId === mutationId,
    );
    if (index === -1) {
      throw new Error(`No pending fake mutation "${mutationId}"`);
    }
    const [deferred] = this.deferredMutations.splice(index, 1);
    return deferred as DeferredMutation<State>;
  }

  resync(request: ResyncRequest): Promise<ResyncResult<State>> {
    this.resyncRequests.push(request);
    if (this.resyncResult !== undefined) {
      return Promise.resolve(this.resyncResult);
    }
    return new Promise<ResyncResult<State>>((resolve, reject) => {
      this.deferredResyncs.push({ request, resolve, reject });
    });
  }

  resolveResync(result: ResyncResult<State>, index = 0): void {
    const deferred = this.takeDeferredResync(index);
    deferred.resolve(result);
  }

  rejectResync(error: unknown, index = 0): void {
    const deferred = this.takeDeferredResync(index);
    deferred.reject(error);
  }

  get pendingResyncCount(): number {
    return this.deferredResyncs.length;
  }

  private takeDeferredResync(index: number): DeferredResync<State> {
    const [deferred] = this.deferredResyncs.splice(index, 1);
    if (deferred === undefined) {
      throw new Error(`No pending fake resync at index ${index}`);
    }
    return deferred;
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }
}
