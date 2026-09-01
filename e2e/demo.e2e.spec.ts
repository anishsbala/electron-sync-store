import { createRequire } from "node:module";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;
const repositoryRoot = resolve(import.meta.dirname, "..");

type DemoRole = "controller" | "observer" | "inspector";

async function findWindow(
  application: ElectronApplication,
  role: DemoRole,
): Promise<Page> {
  await expect
    .poll(() =>
      application
        .windows()
        .map((page) => new URL(page.url()).searchParams.get("view")),
    )
    .toContain(role);

  for (const page of application.windows()) {
    if (new URL(page.url()).searchParams.get("view") === role) {
      return page;
    }
  }
  throw new Error(`Electron window "${role}" was not found`);
}

async function launchDemo(): Promise<{
  application: ElectronApplication;
  controller: Page;
  observer: Page;
  inspector: Page;
}> {
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: ["examples/demo"],
    cwd: repositoryRoot,
    env: { ...process.env, ELECTRON_SYNC_STORE_DEMO_SMOKE: "0" },
  });

  const [controller, observer, inspector] = await Promise.all([
    findWindow(application, "controller"),
    findWindow(application, "observer"),
    findWindow(application, "inspector"),
  ]);
  await Promise.all([
    expect(controller.getByTestId("controller-root")).toBeVisible(),
    expect(observer.getByTestId("observer-root")).toBeVisible(),
    expect(inspector.getByTestId("inspector-root")).toBeVisible(),
  ]);
  return { application, controller, observer, inspector };
}

async function expectSettled(page: Page): Promise<void> {
  await expect(page.getByTestId("sync-status")).toContainText("synced");
  await expect(page.getByTestId("sync-pending")).toContainText("Pending 0");
}

test.describe("Electron React demo", () => {
  let application: ElectronApplication | undefined;

  test.afterEach(async () => {
    await application?.close().catch(() => undefined);
    application = undefined;
  });

  test("synchronizes the counter across all three windows", async () => {
    const demo = await launchDemo();
    application = demo.application;

    await expect(demo.controller.getByTestId("controller-counter")).toHaveText("0");
    await expect(demo.observer.getByTestId("observer-counter")).toHaveText("0");
    await demo.controller.getByTestId("increment-one").click();
    await expect(demo.controller.getByTestId("controller-counter")).toHaveText("1");
    await expect(demo.observer.getByTestId("observer-counter")).toHaveText("1");
    await expect(demo.inspector.getByTestId("inspector-state")).toContainText('"counter": 1');
    await expectSettled(demo.controller);
    await expect
      .poll(async () => Number((await demo.inspector.getByTestId("inspector-revision").textContent()) ?? 0))
      .toBeGreaterThan(0);
  });

  test("replicates profile and shared theme changes", async () => {
    const demo = await launchDemo();
    application = demo.application;

    await demo.controller.getByTestId("profile-name").fill("Ada");
    await demo.controller.getByTestId("apply-profile-name").click();
    await demo.controller.getByTestId("profile-status").selectOption("away");
    await demo.controller.getByTestId("theme-light").click();
    await demo.controller.getByTestId("wait-for-sync").click();

    await expect(demo.observer.getByTestId("observer-name")).toHaveText("Ada");
    await expect(demo.observer.getByTestId("observer-status")).toContainText("away");
    await expect(demo.observer.getByTestId("observer-theme")).toHaveText("light");
    await expect(demo.controller.getByTestId("controller-root")).toHaveAttribute("data-theme", "light");
    await expect(demo.observer.getByTestId("observer-root")).toHaveAttribute("data-theme", "light");
    await expect(demo.inspector.getByTestId("inspector-root")).toHaveAttribute("data-theme", "light");
    await expect(demo.inspector.getByTestId("inspector-state")).toContainText('"name": "Ada"');
    await expect(demo.inspector.getByTestId("inspector-state")).toContainText('"status": "away"');
  });

  test("broadcasts a main-originated mutation", async () => {
    const demo = await launchDemo();
    application = demo.application;

    await demo.controller.getByTestId("increment-from-main").click();
    await expect(demo.controller.getByTestId("controller-counter")).toHaveText("1");
    await expect(demo.observer.getByTestId("observer-counter")).toHaveText("1");
    await expect(demo.inspector.getByTestId("inspector-state")).toContainText('"lastUpdatedBy": "main"');
    await expectSettled(demo.controller);
  });

  test("rehydrates a closed Observer at current state with a new client", async () => {
    const demo = await launchDemo();
    application = demo.application;
    const originalClientId = await demo.observer.getByTestId("sync-client").getAttribute("data-client-id");

    await demo.observer.close();
    await expect.poll(() => demo.application.windows().length).toBe(2);
    for (let index = 0; index < 3; index += 1) {
      await demo.controller.getByTestId("increment-one").click();
    }
    await demo.controller.getByTestId("wait-for-sync").click();
    await expectSettled(demo.controller);
    const controllerRevision = await demo.controller.getByTestId("sync-revision").textContent();

    const newWindowPromise = demo.application.waitForEvent("window");
    await demo.controller.getByTestId("reopen-observer").click();
    const reopened = await newWindowPromise;
    await expect(reopened.getByTestId("observer-root")).toBeVisible();
    await expect(reopened.getByTestId("observer-counter")).toHaveText("3");
    await expect(reopened.getByTestId("sync-revision")).toHaveText(controllerRevision ?? "");
    await expect(reopened.getByTestId("sync-client")).not.toHaveAttribute(
      "data-client-id",
      originalClientId ?? "",
    );
    await expectSettled(reopened);
  });

  test("settles multiple optimistic mutations through flush", async () => {
    const demo = await launchDemo();
    application = demo.application;

    await demo.controller.getByTestId("burst-updates").click();
    await expect(demo.controller.getByTestId("controller-counter")).toHaveText("10");
    await demo.controller.getByTestId("wait-for-sync").click();
    await expect(demo.controller.getByTestId("wait-for-sync")).toHaveText("Synchronized");
    await expectSettled(demo.controller);
    await expect(demo.observer.getByTestId("observer-counter")).toHaveText("10");
    await expect(demo.inspector.getByTestId("inspector-state")).toContainText('"counter": 10');
    await expect(demo.inspector.getByTestId("inspector-pending")).toHaveText("0");
    await expect(demo.inspector.getByTestId("inspector-status")).toHaveText("synced");
  });
});
