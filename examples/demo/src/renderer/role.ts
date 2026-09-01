import type { DemoWindowRole } from "../shared/demo-bridge.js";

const roles = new Set<DemoWindowRole>([
  "controller",
  "observer",
  "inspector",
]);

export function readWindowRole(search: string): DemoWindowRole {
  const candidate = new URLSearchParams(search).get("view");
  if (roles.has(candidate as DemoWindowRole)) {
    return candidate as DemoWindowRole;
  }
  return "controller";
}
