export type SerializablePrimitive = string | number | boolean | null;

export type SerializableValue =
  | SerializablePrimitive
  | SerializableValue[]
  | { [key: string]: SerializableValue };

export type SerializableRecord = {
  [key: string]: SerializableValue;
};

export type SerializableShape<Value> =
  Value extends SerializablePrimitive
    ? Value
    : Value extends readonly (infer Item)[]
      ? SerializableShape<Item>[]
      : Value extends object
        ? { [Key in keyof Value]: SerializableShape<Value[Key]> }
        : never;

export type StatePatch<State extends object> = Partial<State>;

export type StateUpdater<State extends object> = (
  state: Readonly<State>,
) => StatePatch<State>;

export type SetStateAction<State extends object> =
  | StatePatch<State>
  | StateUpdater<State>;

export type StateListener<State extends object> = (
  state: Readonly<State>,
  previousState: Readonly<State>,
) => void;

export type Unsubscribe = () => void;

export interface Store<State extends object> {
  getState(): Readonly<State>;

  setState(patch: StatePatch<State>): void;
  setState(updater: StateUpdater<State>): void;

  subscribe(listener: StateListener<State>): Unsubscribe;
}
