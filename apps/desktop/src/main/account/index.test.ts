import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  accountPort,
  createDesktopAccount,
  createDesktopGithub,
  resolveAccountConfig,
} from "./index";
import { tempInventory, testKeyPair } from "./test-support";
import { previewAtLaunch } from "../preview-gate";
import { chooseProductStore } from "../cloud-launch";

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
    const config = resolveAccountConfig({
      packaged: false,
      env: {
        VOLLI_ACCOUNT_PROVIDER: "dev",
        VOLLI_CONVEX_TEST_PRIVATE_KEY: testKeyPair().privateKeyPem,
      },
    });
    const service = createDesktopAccount({
      config,
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
    const github = createDesktopGithub({
      config,
      enabled: () => true,
      account: service,
      openBrowser: (url) => void opened.push(url),
      log: log(),
    });
    cleanups.push(() => github.dispose());
    const relaunch = vi.fn();
    const reportUnsavedWrites = vi.fn();
    const saveSnapshot = vi.fn();
    const beforeSignOut = vi.fn(() => {
      expect(service.snapshot().state).toBe("signed-in");
    });
    const port = accountPort(
      service,
      {
        launch: () => ({ store: "local" }),
        relaunch,
        reportUnsavedWrites,
        saveSnapshot,
        readSnapshot: () => "{}",
        beforeSignOut,
      },
      github,
    );
    await port.saveSnapshot("{}");
    expect(saveSnapshot).toHaveBeenCalledWith("{}");
    expect(await port.readSnapshot()).toBe("{}");
    await port.reportUnsavedWrites(2);
    expect(reportUnsavedWrites).toHaveBeenCalledWith(2);
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
    expect(beforeSignOut).not.toHaveBeenCalled();
    await port.signOut();
    expect(beforeSignOut).toHaveBeenCalledOnce();
    stop();
    expect(frames).toEqual(["signed-out", "signing-in", "signed-in", "signed-out"]);
    expect(marker.clear).toHaveBeenCalled();

    // No backend in this build: the GitHub half has no section, and its
    // commands refuse without opening anything.
    const githubFrames: string[] = [];
    const stopGithub = await port.github.subscribe(
      (snapshot) => void githubFrames.push(snapshot.state),
    );
    expect(githubFrames).toEqual(["unavailable"]);
    await expect(Promise.resolve().then(() => port.github.connect())).rejects.toThrow(
      "no Volli Cloud backend",
    );
    stopGithub();
    expect(opened).toHaveLength(1);
  });

  it("initialises local decoration on a markerless stable enrollment launch without opening Account or restoring credentials", async () => {
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const inventoryRead = vi.spyOn(temp.inventory, "get");
    const unlock = vi.fn(async () => {});
    const config = resolveAccountConfig({
      packaged: false,
      env: {
        VOLLI_WORKOS_CLIENT_ID: "client_markerless",
        VOLLI_CONVEX_URL: "http://127.0.0.1:1",
      },
    });
    expect(config.provider).not.toBeNull();
    expect(config.backendUrl).not.toBeNull();
    const account = createDesktopAccount({
      config,
      enabled: () => true,
      inventory: temp.inventory,
      unlockInventory: unlock,
      openBrowser: vi.fn(),
      log: log(),
    });
    cleanups.push(() => account.dispose());
    const restoreAccount = vi.fn(async () => {
      account.snapshot();
      await account.settled();
      return account.previewUserId();
    });
    // Main's actual launch gates: enrollment is available independently of
    // cloud; a markerless stable launch deliberately never calls restoration.
    const preview = await previewAtLaunch({
      stable: true,
      configured: true,
      readMarker: () => null,
      restoreAccount,
    });
    expect(preview).toBe(false);
    expect(
      chooseProductStore({
        cloudFlag: preview,
        readMarker: () => null,
        backendUrl: config.backendUrl,
        signInConfigured: config.provider !== null,
      }),
    ).toEqual({ store: "local" });
    expect(account.sourceIconRestoring()).toBe(false);
    expect(account.sourceIconOwner()).toMatch(/^[a-f0-9]{64}$/);
    expect(account.sourceIconEpoch()).toMatch(/^[a-f0-9]{64}$/);
    expect(restoreAccount).not.toHaveBeenCalled();
    expect(inventoryRead).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
    inventoryRead.mockRestore();
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
