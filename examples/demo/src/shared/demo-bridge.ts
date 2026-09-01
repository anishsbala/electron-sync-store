export const DEMO_INCREMENT_FROM_MAIN_CHANNEL =
  "demo:increment-from-main" as const;
export const DEMO_REOPEN_OBSERVER_CHANNEL = "demo:reopen-observer" as const;
export const DEMO_REOPEN_INSPECTOR_CHANNEL = "demo:reopen-inspector" as const;

export interface DemoActionsBridge {
  incrementFromMain(): Promise<void>;
  reopenObserver(): Promise<void>;
  reopenInspector(): Promise<void>;
}

declare global {
  interface Window {
    demoActions: DemoActionsBridge;
    demoSmokeReady(): Promise<DemoSmokeSnapshot>;
    demoSmokeSetCounter(counter: number): Promise<DemoSmokeSnapshot>;
    demoSmokeWaitForCounter(counter: number): Promise<DemoSmokeSnapshot>;
    demoSmokeSetTheme(theme: DemoTheme): Promise<DemoSmokeSnapshot>;
    demoSmokeWaitForTheme(theme: DemoTheme): Promise<DemoSmokeSnapshot>;
  }
}

export interface DemoSmokeSnapshot {
  role: DemoWindowRole;
  clientId: string;
  serverEpoch: string | null;
  revision: number | null;
  pendingMutations: number;
  status: string;
  counter: number;
  theme: DemoTheme;
}

export type DemoWindowRole = "controller" | "observer" | "inspector";
export type DemoTheme = "light" | "dark";
