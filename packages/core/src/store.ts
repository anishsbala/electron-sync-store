import { assertSerializableRecord } from "./serializable.js";
import type {
  SerializableShape,
  SetStateAction,
  StateListener,
  StatePatch,
  Store,
} from "./types.js";

function hasShallowChange<State extends object>(
  state: State,
  patch: StatePatch<State>,
): boolean {
  const current = state as Record<PropertyKey, unknown>;
  const candidate = patch as Record<PropertyKey, unknown>;

  return Object.keys(patch).some(
    (key) => !Object.is(current[key], candidate[key]),
  );
}

export function createStore<State extends object>(
  initialState: State & SerializableShape<State>,
): Store<State> {
  assertSerializableRecord(initialState, "initialState");

  let state = { ...initialState } as State;
  const listeners = new Set<StateListener<State>>();

  function getState(): Readonly<State> {
    return state;
  }

  function setState(action: SetStateAction<State>): void {
    const patch =
      typeof action === "function" ? action(state) : action;

    assertSerializableRecord(patch, "patch");

    if (!hasShallowChange(state, patch)) {
      return;
    }

    const previousState = state;
    state = { ...state, ...patch };

    for (const listener of [...listeners]) {
      listener(state, previousState);
    }
  }

  function subscribe(listener: StateListener<State>): () => void {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  return {
    getState,
    setState,
    subscribe,
  };
}
