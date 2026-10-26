/**
 * This Mac as a runner against a real backend (VC-895): the dev sign-in,
 * `runners.registerThisMac` with the person's token, the sealed link in a
 * real inventory, the `/runner/token` exchange, the Convex client
 * connection, heartbeats, `asleep` on suspend and `online` on wake, and
 * removal, all on the pinned local Convex backend.
 *
 * Runs only under the fixture, which hands it the backend's URLs and the
 * test issuer's key: CI's `Convex (codegen + backend)` lane runs it so (and
 * requires it to run); it skips everywhere else.
 *
 *   pnpm -C convex with-backend --deploy -- \
 *     pnpm -C apps/desktop exec vp test run src/main/cloud-runner/convex.live.test.ts
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { PowerPort } from "@volli/host-core/ports";
import type { ThisMacRunnerSnapshot } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { convexAccountBackend } from "../account/backend";
import { devIssuerProvider } from "../account/dev-issuer";
import { createAccountService } from "../account/service";
import { inventoryAccountSessionStore } from "../account/session-store";
import { tempInventory } from "../account/test-support";
import { createDesktopMacRunner } from "./index";
import type { MacRunner } from "./mac-runner";

const url = process.env["VOLLI_CONVEX_URL"];
const siteUrl = process.env["VOLLI_CONVEX_SITE_URL"];
const privateKeyPem = process.env["VOLLI_CONVEX_TEST_PRIVATE_KEY"];
const ready = url !== undefined && siteUrl !== undefined && privateKeyPem !== undefined;

// CI's Convex lane sets this: there the test must run, never skip.
if (process.env["VOLLI_ACCOUNT_LIVE_REQUIRED"] === "1" && !ready) {
  throw new Error(
    "The live Mac runner test needs the fixture: run it under `with-backend --deploy`.",
  );
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Resolves once the runner's snapshot satisfies `test`. */
function until(
  runner: MacRunner,
  test: (snapshot: ThisMacRunnerSnapshot) => boolean,
  timeoutMs = 20_000,
): Promise<ThisMacRunnerSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out at ${JSON.stringify(runner.snapshot())}`)),
      timeoutMs,
    );
    const off = runner.subscribe((snapshot) => {
      if (!test(snapshot)) return;
      clearTimeout(timer);
      queueMicrotask(() => off());
      resolve(snapshot);
    });
  });
}

describe.skipIf(!ready)("this Mac as a runner against the pinned local backend", () => {
  it("registers, beats, says asleep on suspend and online on wake, and is removed", async () => {
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const subject = `live-${randomUUID()}`;
    const account = createAccountService({
      enabled: () => true,
      provider: devIssuerProvider({
        privateKeyPem: privateKeyPem!,
        subject,
        displayName: "Live Runner",
        email: `${subject}@example.com`,
      }),
      backend: convexAccountBackend({ url: url! }),
      store: inventoryAccountSessionStore(temp.inventory, async () => {}),
      openBrowser: async (target) => {
        const location = (await fetch(target, { redirect: "manual" })).headers.get("location");
        if (location !== null) await fetch(location);
      },
    });
    cleanups.push(() => account.dispose());
    account.snapshot();
    await account.settled();
    await account.signIn("github");
    await account.settled();
    const userId = account.snapshot().account!.userId!;

    // The person's own view of their runners, as the window's client reads it.
    const person = new ConvexClient(url!, { unsavedChangesWarning: false });
    cleanups.push(() => person.close());
    person.setAuth(async () => account.accessToken());
    const list = makeFunctionReference<"query">("runners:list");
    const statusOf = async (runnerId: string) =>
      ((await person.query(list, {})) as { id: string; status: string }[]).find(
        (runner) => runner.id === runnerId,
      )?.status;

    let row: string | undefined;
    const power = new EventEmitter() as EventEmitter & PowerPort;
    const runner = createDesktopMacRunner({
      deployment: "cloud",
      userId,
      backendUrl: url!,
      siteUrl: siteUrl!,
      convex: { ConvexClient, makeFunctionReference },
      account,
      inventory: temp.inventory,
      unlockInventory: async () => {},
      recordRow: () => ({ read: () => row, write: (value) => void (row = value) }),
      power,
      liveWork: () => ({ turns: 0, shells: 0 }),
      dataDir: temp.dir,
      appVersion: "0.0.0-live",
      packaged: false,
      browser: () => ({ state: "available", backend: "electron" }),
      log: { info: () => {}, warn: () => {} },
    });
    cleanups.push(() => runner.stop());
    runner.start();

    const online = await until(runner, (snapshot) => snapshot.state === "online");
    const runnerId = online.runnerId!;
    expect(online.runnerName).toMatch(/-dev$/u);
    expect(await statusOf(runnerId)).toBe("online");

    power.emit("suspend");
    expect(runner.snapshot().state).toBe("asleep");
    await expect.poll(() => statusOf(runnerId), { timeout: 10_000 }).toBe("asleep");

    power.emit("resume");
    await until(runner, (snapshot) => snapshot.state === "online");
    await expect.poll(() => statusOf(runnerId), { timeout: 10_000 }).toBe("online");

    await runner.removeThisMac();
    expect(runner.snapshot()).toMatchObject({ state: "removed", problem: "removed" });
    expect(await statusOf(runnerId)).toBeUndefined();
  }, 60_000);
});
