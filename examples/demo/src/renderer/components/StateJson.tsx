import type { DemoState } from "../../shared/demo-state.js";

export function StateJson({
  state,
  testId,
}: {
  state: Readonly<DemoState>;
  testId?: string;
}) {
  return <pre className="state-json" data-testid={testId}>{JSON.stringify(state, null, 2)}</pre>;
}
