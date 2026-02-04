import type { StatePatch } from "./types.js";

export const PROTOCOL_VERSION = 1 as const;

export interface ConnectRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  storeId: string;
  clientId: string;
}

export interface Snapshot<State extends object> {
  protocolVersion: typeof PROTOCOL_VERSION;
  storeId: string;
  serverEpoch: string;
  revision: number;
  state: State;
}

export interface MutationRequest<State extends object> {
  protocolVersion: typeof PROTOCOL_VERSION;
  storeId: string;
  serverEpoch: string;
  clientId: string;
  mutationId: string;
  baseRevision: number;
  patch: StatePatch<State>;
}

export interface Commit<State extends object> {
  type: "commit";
  protocolVersion: typeof PROTOCOL_VERSION;
  storeId: string;
  serverEpoch: string;
  sourceClientId: string;
  mutationId: string;
  revision: number;
  patch: StatePatch<State>;
}

export interface MutationNoop {
  type: "noop";
  protocolVersion: typeof PROTOCOL_VERSION;
  storeId: string;
  serverEpoch: string;
  clientId: string;
  mutationId: string;
  /** Current canonical revision. This mutation did not consume a revision. */
  revision: number;
}

export type MutationRejectionCode =
  | "invalid-mutation"
  | "unknown-store"
  | "unauthorized"
  | "stale-server-epoch"
  | "store-destroyed"
  | "internal-error";

export interface MutationRejection {
  type: "rejected";
  protocolVersion: typeof PROTOCOL_VERSION;
  storeId: string;
  serverEpoch: string | null;
  clientId: string;
  mutationId: string;
  revision: number | null;
  code: MutationRejectionCode;
  message: string;
  retryable: boolean;
}

export type MutationResult<State extends object> =
  | Commit<State>
  | MutationNoop
  | MutationRejection;

export interface ResyncRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  storeId: string;
  clientId: string;
  serverEpoch: string;
  knownRevision: number;
  pendingMutationIds: string[];
}

export interface ResyncResponse<State extends object> {
  snapshot: Snapshot<State>;
  appliedMutationIds: string[];
  noopMutationIds: string[];
}
