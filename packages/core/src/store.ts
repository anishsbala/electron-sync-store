import { assertSerializableRecord } from "./serializable.js";
import { applyShallowPatch, hasShallowChanges } from "./patch.js";
import type {
  SerializableShape,
  SetStateAction,
  StateListener,
  Store,
} from "./types.js";

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

    if (!hasShallowChanges<State>(state, patch)) {
      return;
    }

    const previousState = state;
    state = applyShallowPatch<State>(state, patch);

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
