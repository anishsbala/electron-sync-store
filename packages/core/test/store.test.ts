import { describe, expect, it, vi } from "vitest";

import { createStore } from "../src/index.js";

interface CounterState {
  counter: number;
  label: string;
  nested: {
    enabled: boolean;
  };
}

function createCounterStore() {
  return createStore<CounterState>({
    counter: 0,
    label: "initial",
    nested: { enabled: true },
  });
}

describe("createStore", () => {
  it("returns the current state synchronously", () => {
    const initialState: CounterState = {
      counter: 1,
      label: "ready",
      nested: { enabled: true },
    };
    const store = createStore(initialState);

    expect(store.getState()).toEqual(initialState);
    expect(store.getState()).not.toBe(initialState);
  });

  it("applies object patches shallowly", () => {
    const store = createCounterStore();
    const nested = store.getState().nested;

    store.setState({ counter: 5 });

    expect(store.getState()).toEqual({
      counter: 5,
      label: "initial",
      nested: { enabled: true },
    });
    expect(store.getState().nested).toBe(nested);
  });

  it("evaluates a functional updater once against the visible state", () => {
    const store = createCounterStore();
    const updater = vi.fn((state: Readonly<CounterState>) => ({
      counter: state.counter + 1,
    }));

    store.setState({ counter: 5 });
    store.setState(updater);

    expect(updater).toHaveBeenCalledOnce();
    expect(updater).toHaveBeenCalledWith({
      counter: 5,
      label: "initial",
      nested: store.getState().nested,
    });
    expect(store.getState().counter).toBe(6);
  });

  it("notifies subscribers synchronously with current and previous state", () => {
    const store = createCounterStore();
    const events: string[] = [];

    store.subscribe((state, previousState) => {
      events.push(`${previousState.counter}->${state.counter}`);
    });

    events.push("before");
    store.setState({ counter: 2 });
    events.push("after");

    expect(events).toEqual(["before", "0->2", "after"]);
  });

  it("supports idempotent unsubscription", () => {
    const store = createCounterStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setState({ counter: 1 });
    unsubscribe();
    unsubscribe();
    store.setState({ counter: 2 });

    expect(listener).toHaveBeenCalledOnce();
  });

  it("uses a stable listener snapshot during notification", () => {
    const store = createCounterStore();
    const calls: string[] = [];
    const third = () => calls.push("third");
    let unsubscribeSecond: () => void = () => undefined;

    store.subscribe(() => {
      calls.push("first");
      unsubscribeSecond();
      store.subscribe(third);
    });
    unsubscribeSecond = store.subscribe(() => calls.push("second"));

    store.setState({ counter: 1 });
    store.setState({ counter: 2 });

    expect(calls).toEqual(["first", "second", "first", "third"]);
  });

  it("does not replace state or notify for shallow Object.is no-ops", () => {
    const store = createCounterStore();
    const listener = vi.fn();
    const before = store.getState();
    store.subscribe(listener);

    store.setState({});
    store.setState({ counter: 0, nested: before.nested });

    expect(store.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("treats positive and negative zero as different with Object.is", () => {
    const store = createStore({ value: 0 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.setState({ value: -0 });

    expect(Object.is(store.getState().value, -0)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("leaves state unchanged when an updater throws", () => {
    const store = createCounterStore();
    const before = store.getState();

    expect(() =>
      store.setState(() => {
        throw new Error("updater failed");
      }),
    ).toThrow("updater failed");
    expect(store.getState()).toBe(before);
  });

  it("rejects a non-serializable patch before changing state", () => {
    const store = createCounterStore();
    const before = store.getState();
    const listener = vi.fn();
    store.subscribe(listener);

    expect(() =>
      store.setState({ label: undefined } as unknown as Partial<CounterState>),
    ).toThrow(/patch\.label contains unsupported value type undefined/u);
    expect(store.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });
});
