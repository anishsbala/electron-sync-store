import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "electron-sync-store-pack-"));
const packDirectory = join(temporaryRoot, "packs");
const consumerDirectory = join(temporaryRoot, "consumer");
const pathEntries = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
const windowsPnpmEntry = pathEntries
  .map((entry) => join(entry, "node_modules", "pnpm", "bin", "pnpm.cjs"))
  .find((entry) => existsSync(entry));
const pnpmCommand =
  process.platform === "win32"
    ? {
        executable: process.execPath,
        prefix:
          windowsPnpmEntry === undefined
            ? (() => {
                throw new Error("Could not locate pnpm.cjs from PATH");
              })()
            : [windowsPnpmEntry],
      }
    : { executable: "pnpm", prefix: [] };

const packages = [
  { name: "@electron-sync-store/core", directory: "packages/core", file: "core.tgz" },
  { name: "@electron-sync-store/main", directory: "packages/main", file: "main.tgz" },
  { name: "@electron-sync-store/renderer", directory: "packages/renderer", file: "renderer.tgz" },
  { name: "@electron-sync-store/react", directory: "packages/react", file: "react.tgz" },
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
}

function runPnpm(args, options = {}) {
  return run(
    pnpmCommand.executable,
    [...pnpmCommand.prefix, ...args],
    options,
  );
}

try {
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(join(consumerDirectory, "src"), { recursive: true });

  const tarballs = new Map();
  for (const packageDefinition of packages) {
    const output = join(packDirectory, packageDefinition.file);
    const packed = JSON.parse(
      runPnpm([
        "--dir",
        packageDefinition.directory,
        "pack",
        "--json",
        "--out",
        output,
      ]),
    );
    if (packed.name !== packageDefinition.name || packed.version !== "0.1.0") {
      throw new Error(
        `Unexpected package identity: ${packed.name}@${packed.version}`,
      );
    }

    for (const entry of packed.files) {
      const allowed =
        entry.path === "package.json" ||
        entry.path === "README.md" ||
        entry.path === "LICENSE" ||
        entry.path.startsWith("dist/");
      if (
        !allowed ||
        /(^|\/)(src|test|coverage|node_modules)(\/|$)/.test(entry.path) ||
        entry.path.endsWith(".tsbuildinfo")
      ) {
        throw new Error(
          `Unexpected file in ${packageDefinition.name}: ${entry.path}`,
        );
      }
    }
    tarballs.set(packageDefinition.name, output);
    console.log(
      `Packed ${packageDefinition.name}@0.1.0 (${packed.files.length} files)`,
    );
  }

  const consumerPackage = {
    name: "electron-sync-store-packed-consumer",
    private: true,
    type: "module",
    dependencies: {
      "@electron-sync-store/core": `file:${tarballs.get("@electron-sync-store/core")}`,
      "@electron-sync-store/main": `file:${tarballs.get("@electron-sync-store/main")}`,
      "@electron-sync-store/renderer": `file:${tarballs.get("@electron-sync-store/renderer")}`,
      "@electron-sync-store/react": `file:${tarballs.get("@electron-sync-store/react")}`,
      electron: "44.1.0",
      react: "19.2.8",
    },
    devDependencies: {
      "@types/react": "19.2.18",
      typescript: "5.9.3",
    },
    pnpm: {
      overrides: {
        "@electron-sync-store/core": `file:${tarballs.get("@electron-sync-store/core")}`,
        "@electron-sync-store/main": `file:${tarballs.get("@electron-sync-store/main")}`,
        "@electron-sync-store/renderer": `file:${tarballs.get("@electron-sync-store/renderer")}`,
        "@electron-sync-store/react": `file:${tarballs.get("@electron-sync-store/react")}`,
      },
    },
  };
  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify(consumerPackage, null, 2),
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          target: "ES2022",
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(consumerDirectory, "src/index.ts"),
    `import { createStore } from "@electron-sync-store/core";
import { createElectronSyncMain } from "@electron-sync-store/main";
import {
  createRendererStore,
  type RendererStore,
} from "@electron-sync-store/renderer";
import { exposeElectronSyncStore } from "@electron-sync-store/renderer/preload";
import {
  useElectronStore,
  useElectronSyncState,
} from "@electron-sync-store/react";

interface AppState {
  counter: number;
  profile: { name: string };
}

const local = createStore<AppState>({
  counter: 0,
  profile: { name: "Anish" },
});
local.setState((state) => ({ counter: state.counter + 1 }));

const sync = createElectronSyncMain();
sync.createStore<AppState>("app", local.getState());

const rendererPromise: Promise<RendererStore<AppState>> =
  createRendererStore<AppState>({ id: "app" });

function useConsumer(store: RendererStore<AppState>) {
  const counter: number = useElectronStore(store, (state) => state.counter);
  const metadata = useElectronSyncState(store);
  return { counter, status: metadata.status };
}

void exposeElectronSyncStore;
void rendererPromise;
void useConsumer;
`,
  );

  runPnpm(
    ["install", "--offline", "--ignore-scripts"],
    { cwd: consumerDirectory, stdio: "inherit" },
  );
  runPnpm(
    ["exec", "tsc", "--project", "tsconfig.json"],
    { cwd: consumerDirectory, stdio: "inherit" },
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'await Promise.all([import("@electron-sync-store/core"), import("@electron-sync-store/main"), import("@electron-sync-store/renderer"), import("@electron-sync-store/react")]);',
    ],
    { cwd: consumerDirectory, stdio: "inherit" },
  );
  console.log("Packed consumer TypeScript and runtime import verification passed");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
