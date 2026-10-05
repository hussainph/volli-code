/**
 * The web keys' launch reconcile against an accepted quit (VC-643's review
 * blocker). Each case drives the real pieces desktop wires together: the
 * accepted-quit coordinator, this lifecycle, `WebAccessSettings`, the sealed
 * mirror and desktop's keychain keyring, over a migrated database holding a
 * web key. Only Electron's asynchronous `safeStorage` is a fake, one that can
 * stall like a keychain prompt nobody answers. Fake timers make "exit timing
 * unchanged" exact: the quit exits at the same instant as one with no web
 * sealing at all.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { openTestDb, type TestDb } from "@volli/host-core/db/test-helpers";
import { writeSecret } from "@volli/host-core/db/secrets-repo";
import {
  CREDENTIAL_INVENTORY_FILE_NAME,
  CREDENTIAL_KEYCHAIN_KEY_FILE_NAME,
  CredentialLock,
  keychainCredentialKeyring,
  SealedInventory,
  type CredentialKeychain,
} from "@volli/host-core/secrets";
import { BRAVE_SEARCH_KEY_SECRET, WebCredentialStore } from "@volli/host-core/web/credential";
import { WebCredentialMirror } from "@volli/host-core/web/credential-mirror";
import { WebAccessSettings } from "@volli/host-core/web/settings";

import { registerAcceptedQuitCoordinator } from "../quit-gate";
import { observeKeychainUse, webSealingLifecycle } from "./sealing-lifecycle";

/** How long the native drain takes in these runs, and the launch delay. */
const DRAIN_MS = 80;
const DELAY_MS = 5_000;

let testDb: TestDb;
beforeEach(() => {
  testDb = openTestDb();
  writeSecret(testDb.db, BRAVE_SEARCH_KEY_SECRET, "BSA-quit-sentinel", 1);
});
afterEach(() => {
  vi.useRealTimers();
  new CredentialLock(join(dirname(testDb.dbPath), "host-credentials.lock")).close();
  testDb.cleanup();
});

/**
 * Electron's asynchronous safeStorage. Every call is logged with whether a
 * quit had been accepted when it started; `stall` holds every answer.
 */
function keychainFake() {
  const log = { calls: 0, afterQuit: 0, quitAccepted: false };
  let release: (() => void) | null = null;
  let stall: Promise<void> | null = null;
  const enter = async () => {
    log.calls += 1;
    if (log.quitAccepted) log.afterQuit += 1;
    await stall;
  };
  const keychain: CredentialKeychain = {
    async isAsyncEncryptionAvailable() {
      await enter();
      return true;
    },
    async encryptStringAsync(value) {
      await enter();
      return Buffer.from(`wrapped:${value}`);
    },
    async decryptStringAsync(value) {
      await enter();
      return { result: value.toString().slice("wrapped:".length) };
    },
  };
  return {
    keychain,
    log,
    /** From now on, every call waits until {@link unstall}: an unanswered prompt. */
    stallAll() {
      stall = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    unstall() {
      release?.();
      stall = null;
    },
  };
}

/** Desktop's wiring: the web stack, its lifecycle, and the quit coordinator that stops it. */
function desktop(options: { sealing: boolean }) {
  const fake = keychainFake();
  const dir = dirname(testDb.dbPath);
  const keyring = keychainCredentialKeyring({
    path: join(dir, CREDENTIAL_KEYCHAIN_KEY_FILE_NAME),
    keychain: fake.keychain,
    inventoryPath: join(dir, CREDENTIAL_INVENTORY_FILE_NAME),
    platform: "darwin",
  });
  const mirror = new WebCredentialMirror({
    db: testDb.db,
    inventory: new SealedInventory({
      path: join(dir, CREDENTIAL_INVENTORY_FILE_NAME),
      keyring,
      families: ["web-search"],
    }),
    keyring,
    // This launch already used the keychain (say, the Session-secrets store
    // opened), so the launch reconcile may ask it: the case the quit must stop.
    mayUnlockUnattended: () => true,
  });
  const settings = new WebAccessSettings({
    db: testDb.db,
    credentials: {
      brave: new WebCredentialStore({ db: testDb.db, secretName: BRAVE_SEARCH_KEY_SECRET }),
      exa: new WebCredentialStore({ db: testDb.db, secretName: "exa_search_api_key" }),
    },
    mirror,
  });
  const sealing = webSealingLifecycle(options.sealing ? settings : null, { delayMs: DELAY_MS });
  let attemptQuit!: (event: { preventDefault(): void }) => void;
  let exitedAt: number | null = null;
  registerAcceptedQuitCoordinator({
    lifecycle: {
      on(_event, listener) {
        attemptQuit = listener;
      },
      exit: () => {
        exitedAt = Date.now();
      },
    },
    shutdownNativeSessions: () => new Promise<void>((settle) => setTimeout(settle, DRAIN_MS)),
    shutdownAgentSocket: () => Promise.resolve(),
    stopBackgroundWork: () => {
      fake.log.quitAccepted = true;
      sealing.stop();
    },
    reportFailure: () => {},
  });
  return {
    fake,
    mirror,
    sealing,
    files: () =>
      [CREDENTIAL_INVENTORY_FILE_NAME, CREDENTIAL_KEYCHAIN_KEY_FILE_NAME].filter((name) =>
        existsSync(join(dir, name)),
      ),
    /** Quits now; answers how long after the quit the process exited. */
    async quit(): Promise<number> {
      const quitAt = Date.now();
      attemptQuit({ preventDefault: () => {} });
      await vi.advanceTimersByTimeAsync(DRAIN_MS + 50);
      expect(exitedAt).not.toBeNull();
      return exitedAt! - quitAt;
    },
  };
}

/** The exit time of the same quit with no web sealing wired at all. */
async function baselineExit(): Promise<number> {
  const { sealing, quit } = desktop({ sealing: false });
  sealing.afterFirstPaint();
  await vi.advanceTimersByTimeAsync(10);
  return quit();
}

describe("the web keys' launch reconcile and an accepted quit", () => {
  it("quit during the launch delay: the timer is cancelled, nothing starts", async () => {
    vi.useFakeTimers();
    const expected = await baselineExit();
    const app = desktop({ sealing: true });
    app.sealing.afterFirstPaint();
    await vi.advanceTimersByTimeAsync(10);
    expect(await app.quit()).toBe(expected);
    // Long past when the timer would have fired.
    await vi.advanceTimersByTimeAsync(DELAY_MS * 3);
    expect(app.fake.log).toEqual({ calls: 0, afterQuit: 0, quitAccepted: true });
    expect(app.files()).toEqual([]);
    expect(app.mirror.reconcile()).toEqual({ sealing: "pending", reason: "stopped" });
    // A launch that paints after the quit schedules nothing either.
    app.sealing.afterFirstPaint();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("quit during a busy retry: the retry is cancelled, the keychain never asked", async () => {
    vi.useFakeTimers();
    const expected = await baselineExit();
    const app = desktop({ sealing: true });
    const lock = new CredentialLock(join(dirname(testDb.dbPath), "host-credentials.lock"));
    let quitTook = 0;
    // Another holder keeps the credential lock across the launch reconcile and the quit.
    await lock.with(async () => {
      app.sealing.afterFirstPaint();
      await vi.advanceTimersByTimeAsync(DELAY_MS + 30);
      // Retrying: busy attempts, pauses between them, nothing asked yet.
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(app.fake.log.calls).toBe(0);
      quitTook = await app.quit();
    });
    expect(quitTook).toBe(expected);
    // The lock is free now; the retry would have sealed within its 10 s window.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(app.fake.log).toEqual({ calls: 0, afterQuit: 0, quitAccepted: true });
    expect(app.files()).toEqual([]);
  });

  it("quit during key acquisition: a stalled keychain is abandoned, not awaited", async () => {
    vi.useFakeTimers();
    const expected = await baselineExit();
    const app = desktop({ sealing: true });
    app.fake.stallAll();
    app.sealing.afterFirstPaint();
    await vi.advanceTimersByTimeAsync(DELAY_MS + 10);
    // In flight: one keychain call, unanswered.
    expect(app.fake.log.calls).toBe(1);
    expect(await app.quit()).toBe(expected);
    // The keychain answers long after: nothing further starts or is written.
    app.fake.unstall();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(app.fake.log).toEqual({ calls: 1, afterQuit: 0, quitAccepted: true });
    expect(app.files()).toEqual([]);
  });

  it("without a quit, reconciles once after the delay", async () => {
    vi.useFakeTimers();
    const app = desktop({ sealing: true });
    app.sealing.afterFirstPaint();
    app.sealing.afterFirstPaint();
    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
    expect(app.fake.log.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await vi.waitFor(() => expect(app.mirror.sealing()).toBe("sealed"));
    expect(app.files()).toEqual([
      CREDENTIAL_INVENTORY_FILE_NAME,
      CREDENTIAL_KEYCHAIN_KEY_FILE_NAME,
    ]);
    // Stopping with nothing scheduled, and with no target, is harmless.
    app.sealing.stop();
    webSealingLifecycle(null).stop();
  });
});

describe("the accepted-quit coordinator's background stop", () => {
  it("reports a stop that throws, and the quit goes on", async () => {
    vi.useFakeTimers();
    let attemptQuit!: (event: { preventDefault(): void }) => void;
    const exit = vi.fn();
    const reportFailure = vi.fn(() => {
      throw new Error("reporter failed too");
    });
    registerAcceptedQuitCoordinator({
      lifecycle: {
        on(_event, listener) {
          attemptQuit = listener;
        },
        exit,
      },
      shutdownNativeSessions: () => Promise.resolve(),
      shutdownAgentSocket: () => Promise.resolve(),
      stopBackgroundWork: () => {
        throw new Error("stop failed");
      },
      reportFailure,
    });
    attemptQuit({ preventDefault: () => {} });
    await vi.runAllTimersAsync();
    expect(reportFailure).toHaveBeenCalledWith(new Error("stop failed"));
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});

describe("observeKeychainUse", () => {
  it("forwards every call and notes only a successful wrap or unwrap", () => {
    const source = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => Buffer.from(value)),
      decryptString: vi.fn((value: Buffer) => {
        if (value.length === 0) throw new Error("refused");
        return value.toString();
      }),
      getSelectedStorageBackend: vi.fn(() => "gnome_libsecret"),
    };
    const observed = observeKeychainUse(source);
    expect(observed.keychain.isEncryptionAvailable()).toBe(true);
    expect(observed.keychain.getSelectedStorageBackend?.()).toBe("gnome_libsecret");
    expect(observed.used()).toBe(false);
    expect(() => observed.keychain.decryptString(Buffer.alloc(0))).toThrow("refused");
    expect(observed.used()).toBe(false);
    expect(observed.keychain.decryptString(Buffer.from("x"))).toBe("x");
    expect(observed.used()).toBe(true);
    const wrapping = observeKeychainUse(source);
    expect(wrapping.keychain.encryptString("y")).toEqual(Buffer.from("y"));
    expect(wrapping.used()).toBe(true);
    const marked = observeKeychainUse(source);
    marked.markUsed();
    expect(marked.used()).toBe(true);
    // macOS's safeStorage has no backend method: none is invented.
    const { getSelectedStorageBackend: _absent, ...mac } = source;
    expect(observeKeychainUse(mac).keychain.getSelectedStorageBackend).toBeUndefined();
  });
});
