import type { StatePatch } from "./types.js";

export function hasShallowChanges<State extends object>(
  state: Readonly<State>,
  patch: StatePatch<State>,
): boolean {
  const current = state as Record<PropertyKey, unknown>;
  const candidate = patch as Record<PropertyKey, unknown>;

  return Object.keys(patch).some(
    (key) => !Object.is(current[key], candidate[key]),
  );
}

export function applyShallowPatch<State extends object>(
  state: Readonly<State>,
  patch: StatePatch<State>,
): State {
  return { ...state, ...patch } as State;
}
