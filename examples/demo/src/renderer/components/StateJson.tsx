import type { DemoState } from "../../shared/demo-state.js";

export function StateJson({ state }: { state: Readonly<DemoState> }) {
  return <pre className="state-json">{JSON.stringify(state, null, 2)}</pre>;
}
