export interface DemoState {
  counter: number;
  profile: {
    name: string;
    status: "online" | "away" | "offline";
  };
  theme: "light" | "dark";
  lastUpdatedBy: "controller" | "main" | null;
}

export const initialDemoState: DemoState = {
  counter: 0,
  profile: {
    name: "Anish",
    status: "online",
  },
  theme: "dark",
  lastUpdatedBy: null,
};
