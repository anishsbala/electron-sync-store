import { describe, expect, it } from "vitest";

import {
  assertSerializable,
  assertSerializableRecord,
  isSerializable,
  isSerializableRecord,
} from "../src/index.js";

describe("serializability validation", () => {
  it("accepts supported primitives, arrays, and plain objects", () => {
    const shared = { enabled: true };
    const value = {
      array: [null, "text", 42, false],
      nested: shared,
      repeated: shared,
    };

    expect(isSerializable(value)).toBe(true);
    expect(isSerializableRecord(value)).toBe(true);
    expect(() => assertSerializable(value)).not.toThrow();
    expect(() => assertSerializableRecord(value)).not.toThrow();
  });

  it("accepts plain objects with a null prototype", () => {
    const value = Object.assign(Object.create(null) as object, { count: 1 });

    expect(isSerializable(value)).toBe(true);
    expect(isSerializableRecord(value)).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["bigint", 1n],
    ["function", () => undefined],
    ["symbol", Symbol("value")],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["Date", new Date(0)],
    ["Map", new Map()],
    ["Set", new Set()],
  ])("rejects %s values", (_name, value) => {
    expect(isSerializable(value)).toBe(false);
    expect(() => assertSerializable(value)).toThrow(TypeError);
  });

  it("rejects sparse arrays", () => {
    const value = new Array<unknown>(2);
    value[1] = "present";

    expect(isSerializable(value)).toBe(false);
    expect(() => assertSerializable(value)).toThrow(/sparse array entry/u);
  });

  it("rejects circular references but permits repeated references", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const repeated = { value: 1 };

    expect(isSerializable(circular)).toBe(false);
    expect(isSerializable({ first: repeated, second: repeated })).toBe(true);
  });

  it("rejects symbol keys and non-enumerable properties", () => {
    const symbolKeyed = { [Symbol("private")]: true };
    const hidden = {};
    Object.defineProperty(hidden, "private", {
      enumerable: false,
      value: true,
    });

    expect(isSerializable(symbolKeyed)).toBe(false);
    expect(isSerializable(hidden)).toBe(false);
  });

  it("rejects accessors without invoking them", () => {
    let invoked = false;
    const value = {};
    Object.defineProperty(value, "computed", {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });

    expect(isSerializable(value)).toBe(false);
    expect(invoked).toBe(false);
  });

  it("requires records to be non-array plain objects", () => {
    expect(isSerializableRecord([])).toBe(false);
    expect(isSerializableRecord(null)).toBe(false);
    expect(() => assertSerializableRecord([])).toThrow(/plain object/u);
  });

  it("reports the nested property path in assertion errors", () => {
    expect(() =>
      assertSerializable({ settings: { selected: undefined } }, "payload"),
    ).toThrow(/payload\.settings\.selected/u);
  });
});
