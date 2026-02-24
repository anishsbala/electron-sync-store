import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  assertCommit,
  assertConnectRequest,
  assertMutationNoop,
  assertMutationRejection,
  assertMutationRequest,
  assertMutationResult,
  assertResyncRequest,
  assertResyncResponse,
  assertSnapshot,
  isConnectRequest,
  isMutationRequest,
  isResyncRequest,
} from "../src/index.js";

const validConnectRequest = {
  protocolVersion: PROTOCOL_VERSION,
  storeId: "app",
  clientId: "client-1",
};

const validMutationRequest = {
  protocolVersion: PROTOCOL_VERSION,
  storeId: "app",
  serverEpoch: "epoch-1",
  clientId: "client-1",
  mutationId: "mutation-1",
  baseRevision: 0,
  patch: { counter: 1 },
};

const validResyncRequest = {
  protocolVersion: PROTOCOL_VERSION,
  storeId: "app",
  clientId: "client-1",
  serverEpoch: "epoch-1",
  knownRevision: 0,
  pendingMutationIds: ["mutation-1"],
};

describe("protocol validation", () => {
  it("accepts a valid ConnectRequest", () => {
    expect(() => assertConnectRequest(validConnectRequest)).not.toThrow();
    expect(isConnectRequest(validConnectRequest)).toBe(true);
  });

  it("rejects unsupported protocol versions", () => {
    const request = { ...validConnectRequest, protocolVersion: 2 };

    expect(() => assertConnectRequest(request)).toThrow(/protocolVersion must be 1/u);
    expect(isConnectRequest(request)).toBe(false);
  });

  it.each([
    ["storeId", { ...validConnectRequest, storeId: "" }],
    ["clientId", { ...validConnectRequest, clientId: "   " }],
  ])("rejects an empty %s", (_field, request) => {
    expect(() => assertConnectRequest(request)).toThrow(/non-empty string/u);
  });

  it("accepts a valid MutationRequest", () => {
    expect(() => assertMutationRequest(validMutationRequest)).not.toThrow();
    expect(isMutationRequest(validMutationRequest)).toBe(true);
  });

  it.each([
    ["mutationId", { ...validMutationRequest, mutationId: "" }],
    ["serverEpoch", { ...validMutationRequest, serverEpoch: " " }],
    ["clientId", { ...validMutationRequest, clientId: "" }],
  ])("rejects an empty mutation %s", (_field, request) => {
    expect(() => assertMutationRequest(request)).toThrow(/non-empty string/u);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
  ])("rejects a %s base revision", (_name, baseRevision) => {
    const request = { ...validMutationRequest, baseRevision };

    expect(() => assertMutationRequest(request)).toThrow(/nonnegative integer/u);
  });

  it("rejects a non-record patch", () => {
    const request = { ...validMutationRequest, patch: [1, 2] };

    expect(() => assertMutationRequest(request)).toThrow(/plain object/u);
  });

  it("rejects a nonserializable patch", () => {
    const request = { ...validMutationRequest, patch: { counter: undefined } };

    expect(() => assertMutationRequest(request)).toThrow(/unsupported value type undefined/u);
    expect(isMutationRequest(request)).toBe(false);
  });

  it("validates snapshots and their state", () => {
    const snapshot = {
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      serverEpoch: "epoch-1",
      revision: 2,
      state: { counter: 2 },
    };

    expect(() => assertSnapshot(snapshot)).not.toThrow();
    expect(() => assertSnapshot({ ...snapshot, state: { value: 1n } })).toThrow(
      /unsupported value type bigint/u,
    );
  });

  it.each([
    ["negative", -1],
    ["fractional", 2.5],
    ["NaN", Number.NaN],
  ])("rejects a %s snapshot revision", (_name, revision) => {
    expect(() =>
      assertSnapshot({
        protocolVersion: PROTOCOL_VERSION,
        storeId: "app",
        serverEpoch: "epoch-1",
        revision,
        state: {},
      }),
    ).toThrow(/nonnegative integer/u);
  });

  it("accepts valid resync requests", () => {
    expect(() => assertResyncRequest(validResyncRequest)).not.toThrow();
    expect(isResyncRequest(validResyncRequest)).toBe(true);
  });

  it.each([
    ["not an array", "mutation-1"],
    ["contains an empty ID", ["mutation-1", ""]],
    ["contains a non-string", ["mutation-1", 2]],
  ])("rejects pendingMutationIds that are %s", (_name, pendingMutationIds) => {
    const request = { ...validResyncRequest, pendingMutationIds };

    expect(() => assertResyncRequest(request)).toThrow();
    expect(isResyncRequest(request)).toBe(false);
  });

  it("validates all mutation result variants", () => {
    const commit = {
      type: "commit",
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      serverEpoch: "epoch-1",
      sourceClientId: "client-1",
      mutationId: "mutation-1",
      revision: 1,
      patch: { counter: 1 },
    };
    const noop = {
      type: "noop",
      protocolVersion: PROTOCOL_VERSION,
      storeId: "app",
      serverEpoch: "epoch-1",
      clientId: "client-1",
      mutationId: "mutation-2",
      revision: 1,
    };
    const rejection = {
      type: "rejected",
      protocolVersion: PROTOCOL_VERSION,
      storeId: "missing",
      serverEpoch: null,
      clientId: "client-1",
      mutationId: null,
      revision: null,
      code: "unknown-store",
      message: "Store is not registered",
      retryable: false,
    };

    expect(() => assertCommit(commit)).not.toThrow();
    expect(() => assertMutationNoop(noop)).not.toThrow();
    expect(() => assertMutationRejection(rejection)).not.toThrow();
    expect(() => assertMutationResult(commit)).not.toThrow();
    expect(() => assertMutationResult(noop)).not.toThrow();
    expect(() => assertMutationResult(rejection)).not.toThrow();
  });

  it("validates resync responses", () => {
    const response = {
      snapshot: {
        protocolVersion: PROTOCOL_VERSION,
        storeId: "app",
        serverEpoch: "epoch-1",
        revision: 1,
        state: { counter: 1 },
      },
      appliedMutationIds: ["mutation-1"],
      noopMutationIds: ["mutation-2"],
    };

    expect(() => assertResyncResponse(response)).not.toThrow();
  });
});
