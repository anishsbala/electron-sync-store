import type { SerializableRecord, SerializableValue } from "./types.js";

function formatPropertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function findSerializationProblem(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? undefined
      : `${path} must be a finite number`;
  }

  if (typeof value !== "object") {
    return `${path} contains unsupported value type ${typeof value}`;
  }

  if (ancestors.has(value)) {
    return `${path} contains a circular reference`;
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          return `${path}[${index}] is a sparse array entry`;
        }

        const problem = findSerializationProblem(
          value[index],
          `${path}[${index}]`,
          ancestors,
        );

        if (problem !== undefined) {
          return problem;
        }
      }

      return undefined;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return `${path} must be a plain object`;
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        return `${path} contains a symbol key`;
      }

      const propertyPath = formatPropertyPath(path, key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (descriptor === undefined) {
        return `${propertyPath} could not be inspected`;
      }

      if (!descriptor.enumerable) {
        return `${propertyPath} must be enumerable`;
      }

      if (!("value" in descriptor)) {
        return `${propertyPath} must be a data property`;
      }

      const problem = findSerializationProblem(
        descriptor.value,
        propertyPath,
        ancestors,
      );

      if (problem !== undefined) {
        return problem;
      }
    }

    return undefined;
  } catch {
    return `${path} could not be safely inspected`;
  } finally {
    ancestors.delete(value);
  }
}

export function isSerializable(value: unknown): value is SerializableValue {
  return findSerializationProblem(value, "value", new WeakSet()) === undefined;
}

export function assertSerializable(
  value: unknown,
  label = "value",
): asserts value is SerializableValue {
  const problem = findSerializationProblem(value, label, new WeakSet());

  if (problem !== undefined) {
    throw new TypeError(`Expected an IPC-safe serializable value: ${problem}`);
  }
}

export function isSerializableRecord(
  value: unknown,
): value is SerializableRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return isSerializable(value);
}

export function assertSerializableRecord(
  value: unknown,
  label = "value",
): asserts value is SerializableRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      `Expected an IPC-safe serializable record: ${label} must be a plain object`,
    );
  }

  const problem = findSerializationProblem(value, label, new WeakSet());

  if (problem !== undefined) {
    throw new TypeError(`Expected an IPC-safe serializable record: ${problem}`);
  }
}
