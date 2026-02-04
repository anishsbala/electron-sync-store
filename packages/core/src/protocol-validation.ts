import {
  PROTOCOL_VERSION,
  type Commit,
  type ConnectRequest,
  type MutationNoop,
  type MutationRejection,
  type MutationRejectionCode,
  type MutationRequest,
  type MutationResult,
  type ResyncRequest,
  type ResyncResponse,
  type Snapshot,
} from "./protocol.js";
import { assertSerializableRecord } from "./serializable.js";

type UnknownRecord = Record<string, unknown>;

const rejectionCodes = new Set<MutationRejectionCode>([
  "invalid-mutation",
  "unknown-store",
  "unauthorized",
  "stale-server-epoch",
  "store-destroyed",
  "internal-error",
]);

function assertRecord(value: unknown, label: string): asserts value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertProtocolVersion(value: unknown, label: string): void {
  if (value !== PROTOCOL_VERSION) {
    throw new TypeError(`${label} must be ${PROTOCOL_VERSION}`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertRevision(value: unknown, label: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`${label} must be a finite nonnegative integer`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }

  value.forEach((entry, index) => {
    assertNonEmptyString(entry, `${label}[${index}]`);
  });
}

function assertBaseEnvelope(value: UnknownRecord, label: string): void {
  assertProtocolVersion(value.protocolVersion, `${label}.protocolVersion`);
  assertNonEmptyString(value.storeId, `${label}.storeId`);
}

export function assertConnectRequest(
  value: unknown,
): asserts value is ConnectRequest {
  assertRecord(value, "connectRequest");
  assertBaseEnvelope(value, "connectRequest");
  assertNonEmptyString(value.clientId, "connectRequest.clientId");
}

export function isConnectRequest(value: unknown): value is ConnectRequest {
  try {
    assertConnectRequest(value);
    return true;
  } catch {
    return false;
  }
}

export function assertSnapshot<State extends object>(
  value: unknown,
): asserts value is Snapshot<State> {
  assertRecord(value, "snapshot");
  assertBaseEnvelope(value, "snapshot");
  assertNonEmptyString(value.serverEpoch, "snapshot.serverEpoch");
  assertRevision(value.revision, "snapshot.revision");
  assertSerializableRecord(value.state, "snapshot.state");
}

export function assertMutationRequest<State extends object>(
  value: unknown,
): asserts value is MutationRequest<State> {
  assertRecord(value, "mutationRequest");
  assertBaseEnvelope(value, "mutationRequest");
  assertNonEmptyString(value.serverEpoch, "mutationRequest.serverEpoch");
  assertNonEmptyString(value.clientId, "mutationRequest.clientId");
  assertNonEmptyString(value.mutationId, "mutationRequest.mutationId");
  assertRevision(value.baseRevision, "mutationRequest.baseRevision");
  assertSerializableRecord(value.patch, "mutationRequest.patch");
}

export function isMutationRequest<State extends object>(
  value: unknown,
): value is MutationRequest<State> {
  try {
    assertMutationRequest<State>(value);
    return true;
  } catch {
    return false;
  }
}

export function assertCommit<State extends object>(
  value: unknown,
): asserts value is Commit<State> {
  assertRecord(value, "commit");
  if (value.type !== "commit") {
    throw new TypeError('commit.type must be "commit"');
  }
  assertBaseEnvelope(value, "commit");
  assertNonEmptyString(value.serverEpoch, "commit.serverEpoch");
  assertNonEmptyString(value.sourceClientId, "commit.sourceClientId");
  assertNonEmptyString(value.mutationId, "commit.mutationId");
  assertRevision(value.revision, "commit.revision");
  assertSerializableRecord(value.patch, "commit.patch");
}

export function assertMutationNoop(
  value: unknown,
): asserts value is MutationNoop {
  assertRecord(value, "mutationNoop");
  if (value.type !== "noop") {
    throw new TypeError('mutationNoop.type must be "noop"');
  }
  assertBaseEnvelope(value, "mutationNoop");
  assertNonEmptyString(value.serverEpoch, "mutationNoop.serverEpoch");
  assertNonEmptyString(value.clientId, "mutationNoop.clientId");
  assertNonEmptyString(value.mutationId, "mutationNoop.mutationId");
  assertRevision(value.revision, "mutationNoop.revision");
}

export function assertMutationRejection(
  value: unknown,
): asserts value is MutationRejection {
  assertRecord(value, "mutationRejection");
  if (value.type !== "rejected") {
    throw new TypeError('mutationRejection.type must be "rejected"');
  }
  assertBaseEnvelope(value, "mutationRejection");
  if (value.serverEpoch !== null) {
    assertNonEmptyString(value.serverEpoch, "mutationRejection.serverEpoch");
  }
  assertNonEmptyString(value.clientId, "mutationRejection.clientId");
  assertNonEmptyString(value.mutationId, "mutationRejection.mutationId");
  if (value.revision !== null) {
    assertRevision(value.revision, "mutationRejection.revision");
  }
  if (!rejectionCodes.has(value.code as MutationRejectionCode)) {
    throw new TypeError("mutationRejection.code is not supported");
  }
  assertNonEmptyString(value.message, "mutationRejection.message");
  if (typeof value.retryable !== "boolean") {
    throw new TypeError("mutationRejection.retryable must be a boolean");
  }
}

export function assertMutationResult<State extends object>(
  value: unknown,
): asserts value is MutationResult<State> {
  assertRecord(value, "mutationResult");
  switch (value.type) {
    case "commit":
      assertCommit<State>(value);
      break;
    case "noop":
      assertMutationNoop(value);
      break;
    case "rejected":
      assertMutationRejection(value);
      break;
    default:
      throw new TypeError("mutationResult.type is not supported");
  }
}

export function assertResyncRequest(
  value: unknown,
): asserts value is ResyncRequest {
  assertRecord(value, "resyncRequest");
  assertBaseEnvelope(value, "resyncRequest");
  assertNonEmptyString(value.clientId, "resyncRequest.clientId");
  assertNonEmptyString(value.serverEpoch, "resyncRequest.serverEpoch");
  assertRevision(value.knownRevision, "resyncRequest.knownRevision");
  assertStringArray(value.pendingMutationIds, "resyncRequest.pendingMutationIds");
}

export function isResyncRequest(value: unknown): value is ResyncRequest {
  try {
    assertResyncRequest(value);
    return true;
  } catch {
    return false;
  }
}

export function assertResyncResponse<State extends object>(
  value: unknown,
): asserts value is ResyncResponse<State> {
  assertRecord(value, "resyncResponse");
  assertSnapshot<State>(value.snapshot);
  assertStringArray(value.appliedMutationIds, "resyncResponse.appliedMutationIds");
  assertStringArray(value.noopMutationIds, "resyncResponse.noopMutationIds");
}
