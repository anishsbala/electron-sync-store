import {
  PROTOCOL_VERSION,
  type Commit,
  type MutationNoop,
  type MutationRejection,
  type MutationRequest,
  type ResyncResponse,
  type Snapshot,
} from "@electron-sync-store/core";
import {
  createRendererStore,
  type CreateRendererStoreOptions,
  type RendererStore,
} from "@electron-sync-store/renderer";

import { FakeRendererTransport } from "../../renderer/test/fake-transport.js";

export interface AppState {
  counter: number;
  theme: string;
  profile: {
    name: string;
    status: string;
  };
}

export function snapshot(
  storeId = "app",
  revision = 10,
  state: AppState = {
    counter: 0,
    theme: "dark",
    profile: { name: "Ada", status: "online" },
  },
  serverEpoch = "epoch-a",
): Snapshot<AppState> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    storeId,
    serverEpoch,
    revision,
    state,
  };
}

export async function hydratedStore(
  storeId = "app",
  initialSnapshot = snapshot(storeId),
  options: Omit<
    CreateRendererStoreOptions<AppState>,
    "id" | "transport"
  > = {},
): Promise<{
  store: RendererStore<AppState>;
  transport: FakeRendererTransport<AppState>;
}> {
  const transport = new FakeRendererTransport<AppState>();
  const creating = createRendererStore<AppState>({
    id: storeId,
    transport,
    ...options,
  });
  transport.resolveConnect(initialSnapshot);
  return { store: await creating, transport };
}

export function commitFor(
  request: MutationRequest<AppState>,
  revision: number,
): Commit<AppState> {
  return {
    type: "commit",
    protocolVersion: PROTOCOL_VERSION,
    storeId: request.storeId,
    serverEpoch: request.serverEpoch,
    sourceClientId: request.clientId,
    mutationId: request.mutationId,
    revision,
    patch: request.patch,
  };
}

export function remoteCommit(
  revision: number,
  patch: Partial<AppState>,
): Commit<AppState> {
  return {
    type: "commit",
    protocolVersion: PROTOCOL_VERSION,
    storeId: "app",
    serverEpoch: "epoch-a",
    sourceClientId: "remote",
    mutationId: `remote-${revision}`,
    revision,
    patch,
  };
}

export function noopFor(
  request: MutationRequest<AppState>,
): MutationNoop {
  return {
    type: "noop",
    protocolVersion: PROTOCOL_VERSION,
    storeId: request.storeId,
    serverEpoch: request.serverEpoch,
    clientId: request.clientId,
    mutationId: request.mutationId,
    revision: request.baseRevision,
  };
}

export function rejectionFor(
  request: MutationRequest<AppState>,
): MutationRejection {
  return {
    type: "rejected",
    protocolVersion: PROTOCOL_VERSION,
    storeId: request.storeId,
    serverEpoch: request.serverEpoch,
    clientId: request.clientId,
    mutationId: request.mutationId,
    revision: request.baseRevision,
    code: "unauthorized",
    message: "not allowed",
    retryable: false,
  };
}

export function resyncResponse(
  nextSnapshot: Snapshot<AppState>,
  appliedMutationIds: string[] = [],
  noopMutationIds: string[] = [],
): ResyncResponse<AppState> {
  return { snapshot: nextSnapshot, appliedMutationIds, noopMutationIds };
}

export async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}
