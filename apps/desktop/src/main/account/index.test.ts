import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { accountPort, createDesktopAccount, resolveAccountConfig } from "./index";
import { tempInventory, testKeyPair } from "./test-support";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const log = () => ({ info: vi.fn(), warn: vi.fn() });

describe("desktop main's account composition", () => {
  it("composes the dev issuer from an unpackaged build's environment, and serves it as the port", async () => {
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const opened: string[] = [];
    const marker = { write: vi.fn(), clear: vi.fn() };
    const service = createDesktopAccount({
      config: resolveAccountConfig({
        packaged: false,
        env: {
          VOLLI_ACCOUNT_PROVIDER: "dev",
          VOLLI_CONVEX_TEST_PRIVATE_KEY: testKeyPair().privateKeyPem,
        },
      }),
      enabled: () => true,
      inventory: temp.inventory,
      unlockInventory: async () => {},
      openBrowser: async (url) => {
        opened.push(url);
        const location = (await fetch(url, { redirect: "manual" })).headers.get("location");
        if (location !== null) await fetch(location);
      },
      log: log(),
      marker,
    });
    cleanups.push(() => service.dispose());
    const relaunch = vi.fn();
    const port = accountPort(service, { launch: () => ({ store: "local" }), relaunch });
    expect(await port.launch()).toEqual({ store: "local" });
    await port.relaunch();
    expect(relaunch).toHaveBeenCalledOnce();
    expect(await port.snapshot()).toMatchObject({ state: "restoring", provider: "dev" });
    await service.settled();
    const frames: string[] = [];
    const stop = await port.subscribe((snapshot) => void frames.push(snapshot.state));
    await port.signIn("github");
    await service.settled();
    expect(opened).toHaveLength(1);
    expect(await port.snapshot()).toMatchObject({
      state: "signed-in",
      account: { displayName: "Dev User", backend: "none" },
    });
    // The window's own client gets the access token, never the refresh token.
    expect(await port.accessToken(false)).toMatchObject({ kind: "token" });
    // No backend in this build: both refuse, and say so.
    await expect(Promise.resolve().then(() => port.requestDeletion())).rejects.toThrow(
      "no Volli Cloud backend",
    );
    await expect(Promise.resolve().then(() => port.cancelDeletion())).rejects.toThrow(
      "no Volli Cloud backend",
    );
    await port.cancelSignIn();
    await port.signOut();
    stop();
    expect(frames).toEqual(["signed-out", "signing-in", "signed-in", "signed-out"]);
    expect(marker.clear).toHaveBeenCalled();
  });

  it("logs a configuration it ignored, and answers an unconfigured build", async () => {
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const logger = log();
    const service = createDesktopAccount({
      config: resolveAccountConfig({
        packaged: false,
        env: { VOLLI_ACCOUNT_PROVIDER: "dev", VOLLI_CONVEX_URL: "http://127.0.0.1:1" },
      }),
      enabled: () => true,
      inventory: temp.inventory,
      unlockInventory: async () => {},
      openBrowser: () => {},
      log: logger,
    });
    expect(logger.warn).toHaveBeenCalledWith("account configuration ignored", {
      problem: "VOLLI_ACCOUNT_PROVIDER=dev needs VOLLI_CONVEX_TEST_PRIVATE_KEY",
    });
    expect(service.snapshot()).toMatchObject({ state: "unconfigured", provider: null });

    const workos = createDesktopAccount({
      config: resolveAccountConfig({
        packaged: false,
        env: { VOLLI_WORKOS_CLIENT_ID: "client_x" },
      }),
      enabled: () => true,
      inventory: temp.inventory,
      unlockInventory: async () => {},
      openBrowser: () => {},
      log: logger,
    });
    expect(workos.snapshot()).toMatchObject({ provider: "workos" });
    await workos.settled();
  });
});
