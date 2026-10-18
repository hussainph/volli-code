import { afterEach, describe, expect, it, vi } from "vite-plus/test";
// Import the adapter directly: the package root's lazy autoUpdater getter loads Electron.
import { AppImageUpdater } from "electron-updater/out/AppImageUpdater";

import type { UpdateLastCheck, UpdateUiState } from "../ipc/contract";
import type { NotificationRequest } from "./notifications/dispatch";
import {
  readAllowPrerelease,
  readUpdateChannel,
  readUpdateLastCheck,
  runningBuildKind,
  writeUpdateChannel,
  writeUpdateLastCheck,
  startAutoUpdate,
  UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY,
  UPDATE_LAST_CHECK_APP_STATE_KEY,
  type AutoUpdaterLike,
} from "./auto-update";
import { setAppState } from "@volli/host-core/db";
import { openTestDb, type TestDb } from "@volli/host-core/testing";

describe("running build kind", () => {
  it.each([
    [false, "0.2.2", "dev"],
    [false, "0.3.0-canary.1", "dev"],
    [true, "0.3.0-canary.1", "canary"],
    [true, "0.3.0-beta.2+build.7", "canary"],
    [true, "0.3.0-1", "canary"],
    [true, "0.2.2", "stable"],
    [true, "0.2.2+canary-build.1", "stable"],
  ] as const)("packaged=%s version=%s → %s", (isPackaged, version, kind) => {
    // AppImageUpdater uses the same AppUpdater constructor/parser as MacUpdater,
    // but an injected app avoids Electron entirely. No update checks or IO run.
    const updater = new AppImageUpdater(null, { version, name: "Volli", isPackaged });
    expect(runningBuildKind(isPackaged, updater.currentVersion)).toBe(kind);
    // A user choosing the canary feed must not change the running build's kind.
    updater.allowPrerelease = !updater.allowPrerelease;
    expect(runningBuildKind(isPackaged, updater.currentVersion)).toBe(kind);
  });
});

const INITIAL_DELAY_MS = 30_000;
const INTERVAL_MS = 4 * 60 * 60 * 1000;

type Listener = (...args: never[]) => void;

/** A plain, event-recording stand-in for electron-updater's `autoUpdater`. */
class FakeUpdater implements AutoUpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  checks = 0;
  installs = 0;
  failNextCheckWith: unknown = null;
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): unknown {
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...existing, listener]);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }

  checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    if (this.failNextCheckWith !== null) {
      const failure = this.failNextCheckWith;
      this.failNextCheckWith = null;
      return Promise.reject(failure instanceof Error ? failure : new Error(String(failure)));
    }
    return Promise.resolve(null);
  }

  quitAndInstall(): void {
    this.installs += 1;
  }
}

interface Harness {
  updater: FakeUpdater;
  logs: string[];
  notifications: NotificationRequest[];
  /** Every state the module announced through `onStateChange`, in order. */
  stateChanges: UpdateUiState[];
  /** What `hasUpdateSurface()` answers — flip it to simulate windows opening/closing. */
  surface: { present: boolean };
  start(overrides?: {
    isPackaged?: boolean;
    allowPrerelease?: boolean;
    lastCheck?: Parameters<typeof startAutoUpdate>[0]["lastCheck"];
    now?: () => number;
  }): ReturnType<typeof startAutoUpdate>;
}

function makeHarness(): Harness {
  const updater = new FakeUpdater();
  const logs: string[] = [];
  const notifications: NotificationRequest[] = [];
  const stateChanges: UpdateUiState[] = [];
  const surface = { present: false };
  return {
    updater,
    logs,
    notifications,
    stateChanges,
    surface,
    start: (overrides = {}) =>
      startAutoUpdate({
        isPackaged: overrides.isPackaged ?? true,
        updater,
        allowPrerelease: overrides.allowPrerelease ?? false,
        currentVersion: "0.1.0",
        notify: (request) => notifications.push(request),
        log: (line) => logs.push(line),
        onStateChange: (state) => stateChanges.push(state),
        hasUpdateSurface: () => surface.present,
        lastCheck: overrides.lastCheck,
        now: overrides.now,
      }),
  };
}

let ctx: TestDb | null = null;

afterEach(() => {
  vi.useRealTimers();
  ctx?.cleanup();
  ctx = null;
});

describe("readAllowPrerelease", () => {
  it("defaults to OFF when the row is absent", () => {
    ctx = openTestDb();
    expect(readAllowPrerelease(ctx.db)).toBe(false);
  });

  it("turns ON only for a stored JSON true", () => {
    ctx = openTestDb();
    setAppState(ctx.db, UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY, "true", 1);
    expect(readAllowPrerelease(ctx.db)).toBe(true);

    setAppState(ctx.db, UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY, "false", 2);
    expect(readAllowPrerelease(ctx.db)).toBe(false);

    // Truthy-but-not-true payloads fail closed: the toggle WIDENS the
    // update surface, so only an exact `true` may open it.
    setAppState(ctx.db, UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY, "1", 3);
    expect(readAllowPrerelease(ctx.db)).toBe(false);
  });

  it("fails closed on a malformed payload", () => {
    ctx = openTestDb();
    setAppState(ctx.db, UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY, "not-json{", 1);
    expect(readAllowPrerelease(ctx.db)).toBe(false);
  });
});

describe("writeUpdateChannel", () => {
  it("round-trips through the reader the updater already uses", () => {
    ctx = openTestDb();

    expect(writeUpdateChannel(ctx.db, "canary", 1)).toBe("canary");
    expect(readAllowPrerelease(ctx.db)).toBe(true);
    expect(readUpdateChannel(ctx.db)).toBe("canary");

    expect(writeUpdateChannel(ctx.db, "stable", 2)).toBe("stable");
    expect(readAllowPrerelease(ctx.db)).toBe(false);
    expect(readUpdateChannel(ctx.db)).toBe("stable");
  });

  it("reads stable for an install that has never chosen", () => {
    ctx = openTestDb();
    expect(readUpdateChannel(ctx.db)).toBe("stable");
  });

  it("widens a handed-over running updater on canary — and only widens", () => {
    ctx = openTestDb();
    const updater = { allowPrerelease: false };

    // Entering canary must reach the RUNNING updater, or "Check now" pressed
    // right after switching silently checks the stable feed until relaunch.
    writeUpdateChannel(ctx.db, "canary", 1, updater);
    expect(updater.allowPrerelease).toBe(true);

    // Leaving is one-way live: `false` is never assigned over the updater's
    // version-derived default (the stranding rule startup already follows).
    writeUpdateChannel(ctx.db, "stable", 2, updater);
    expect(updater.allowPrerelease).toBe(true);
    expect(readUpdateChannel(ctx.db)).toBe("stable");
  });

  it("writes the exact JSON true the reader fails closed against", () => {
    ctx = openTestDb();
    writeUpdateChannel(ctx.db, "canary", 1);

    // Not "1", not "yes" — `readAllowPrerelease` only opens on an exact JSON
    // `true`, so the writer has to produce precisely that or the toggle is a
    // switch that silently does nothing.
    expect(
      ctx.db
        .prepare("SELECT value FROM app_state WHERE key = ?")
        .get(UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY),
    ).toEqual({ value: "true" });
  });
});

describe("startAutoUpdate", () => {
  it("does nothing in dev beyond logging why", () => {
    vi.useFakeTimers();
    const harness = makeHarness();

    const handle = harness.start({ isPackaged: false });
    vi.advanceTimersByTime(INTERVAL_MS * 3);

    expect(harness.logs).toEqual(["[updater] dev run — auto-update disabled"]);
    expect(harness.updater.checks).toBe(0);
    expect(harness.updater.autoDownload).toBe(false);
    handle.stop();
  });

  it("in dev the handle is inert but truthful: unsupported state, no-op commands", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();

    const handle = harness.start({ isPackaged: false });
    expect(handle.state()).toMatchObject({ supported: false, phase: "idle" });

    await handle.checkNow();
    handle.quitAndInstall();

    expect(harness.updater.checks).toBe(0);
    expect(harness.updater.installs).toBe(0);
    expect(harness.stateChanges).toEqual([]);
    handle.stop();
  });

  it("configures background download, install-on-quit and the prerelease policy", () => {
    vi.useFakeTimers();
    const harness = makeHarness();

    const handle = harness.start({ allowPrerelease: true });

    expect(harness.updater.autoDownload).toBe(true);
    expect(harness.updater.autoInstallOnAppQuit).toBe(true);
    expect(harness.updater.allowPrerelease).toBe(true);
    expect(harness.logs).toContain("[updater] allowPrerelease=true (toggle=true)");
    handle.stop();
  });

  it("applies the prerelease toggle one-way: off defers to the updater's own default", () => {
    vi.useFakeTimers();

    // Stable-build default (false) stays false with the toggle off…
    const stable = makeHarness();
    stable.start({ allowPrerelease: false }).stop();
    expect(stable.updater.allowPrerelease).toBe(false);
    expect(stable.logs).toContain("[updater] allowPrerelease=false (toggle=false)");

    // …and a canary build's version-derived default (true) is never
    // clobbered by an absent/false toggle — forcing false would point the
    // install at the stable-only feed and off its own canary line.
    const canary = makeHarness();
    canary.updater.allowPrerelease = true;
    canary.start({ allowPrerelease: false }).stop();
    expect(canary.updater.allowPrerelease).toBe(true);
    expect(canary.logs).toContain("[updater] allowPrerelease=true (toggle=false)");
  });

  it("checks after the initial delay and then on the interval", () => {
    vi.useFakeTimers();
    const harness = makeHarness();

    const handle = harness.start();
    vi.advanceTimersByTime(INITIAL_DELAY_MS - 1);
    expect(harness.updater.checks).toBe(0);

    vi.advanceTimersByTime(1);
    expect(harness.updater.checks).toBe(1);

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(harness.updater.checks).toBe(2);

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(harness.updater.checks).toBe(3);
    handle.stop();
  });

  it("stops checking once stopped", () => {
    vi.useFakeTimers();
    const harness = makeHarness();

    const handle = harness.start();
    handle.stop();
    vi.advanceTimersByTime(INITIAL_DELAY_MS + INTERVAL_MS * 2);

    expect(harness.updater.checks).toBe(0);
  });

  it("logs a failed check instead of throwing", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();

    const handle = harness.start();
    harness.updater.failNextCheckWith = new Error("HttpError: 404 latest-mac.yml");
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(harness.updater.checks).toBe(1);
    expect(harness.logs).toContain("[updater] check failed: HttpError: 404 latest-mac.yml");
    handle.stop();
  });

  it("logs every updater event", () => {
    const harness = makeHarness();
    vi.useFakeTimers();
    const handle = harness.start();

    harness.updater.emit("checking-for-update");
    harness.updater.emit("update-available", { version: "0.2.0" });
    harness.updater.emit("update-not-available", { version: "0.1.0" });
    harness.updater.emit("error", new Error("feed unreachable"));

    expect(harness.logs).toEqual([
      "[updater] allowPrerelease=false (toggle=false)",
      "[updater] checking for updates",
      "[updater] update available: 0.2.0 — downloading",
      "[updater] up to date (latest: 0.1.0)",
      "[updater] error: feed unreachable",
    ]);
    handle.stop();
  });

  it("checkNow responds immediately and settles back to idle when the check produces nothing", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const handle = harness.start();

    // FakeUpdater resolves null — electron-updater's "updater inactive" answer,
    // which emits no event at all. `checking` must not hang on it.
    const settled = handle.checkNow();
    expect(handle.state().phase).toBe("checking");
    await settled;

    expect(handle.state().phase).toBe("idle");
    expect(harness.updater.checks).toBe(1);
    expect(harness.stateChanges.map((state) => state.phase)).toEqual(["checking", "idle"]);
    handle.stop();
  });

  it("checkNow lands a rejected check in the error state", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const handle = harness.start();

    harness.updater.failNextCheckWith = new Error("HttpError: 404 latest-mac.yml");
    await handle.checkNow();

    expect(handle.state()).toMatchObject({
      phase: "error",
      error: "HttpError: 404 latest-mac.yml",
    });
    expect(harness.logs).toContain("[updater] check failed: HttpError: 404 latest-mac.yml");
    handle.stop();
  });

  it("a later successful check clears the error state", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const handle = harness.start();

    harness.updater.failNextCheckWith = new Error("offline");
    await handle.checkNow();
    expect(handle.state().phase).toBe("error");

    await handle.checkNow();
    expect(handle.state()).toMatchObject({ phase: "idle", error: null });
    handle.stop();
  });

  it("quitAndInstall hands the staged update to the updater", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const handle = harness.start();

    handle.quitAndInstall();

    expect(harness.updater.installs).toBe(1);
    handle.stop();
  });

  it("stays silent when a window is showing the badge — without burning the version's one notification", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const handle = harness.start();

    // A window is open: the sidebar badge/dialog owns the announcement.
    harness.surface.present = true;
    harness.updater.emit("update-downloaded", { version: "0.2.0" });
    expect(harness.notifications).toEqual([]);
    expect(handle.state().phase).toBe("downloaded");

    // Every window has since closed (macOS keeps the app alive): the native
    // notification is the only voice left, and the version wasn't burned above.
    harness.surface.present = false;
    harness.updater.emit("update-downloaded", { version: "0.2.0" });
    expect(harness.notifications).toEqual([
      {
        producer: "update-ready",
        title: "Update ready",
        body: "Volli Code 0.2.0 has been downloaded and will install when you quit.",
        // A click opens the update surface rather than a random window (VC-295).
        target: { kind: "update" },
      },
    ]);
    handle.stop();
  });

  it("tracks the check→download→ready lifecycle as user-facing state, announcing every transition", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const handle = harness.start();

    expect(handle.state()).toEqual({
      supported: true,
      phase: "idle",
      currentVersion: "0.1.0",
      targetVersion: null,
      percent: null,
      error: null,
      lastCheck: null,
    });

    harness.updater.emit("checking-for-update");
    expect(handle.state().phase).toBe("checking");

    harness.updater.emit("update-available", { version: "0.2.0" });
    expect(handle.state()).toMatchObject({
      phase: "downloading",
      targetVersion: "0.2.0",
      percent: 0,
    });

    harness.updater.emit("download-progress", { percent: 42.5 });
    expect(handle.state()).toMatchObject({ phase: "downloading", percent: 42.5 });

    harness.updater.emit("update-downloaded", { version: "0.2.0" });
    expect(handle.state()).toMatchObject({
      phase: "downloaded",
      targetVersion: "0.2.0",
      percent: null,
    });

    expect(harness.stateChanges.map((state) => state.phase)).toEqual([
      "checking",
      "downloading",
      "downloading",
      "downloaded",
    ]);
    handle.stop();
  });

  it("a staged download is never demoted by a re-check — checking and errors keep the badge", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const handle = harness.start();

    harness.updater.emit("update-downloaded", { version: "0.2.0" });
    expect(handle.state().phase).toBe("downloaded");

    // The 4h schedule keeps checking after a download. Neither the check's
    // start nor its failure (offline laptop, feed briefly gone) may hide the
    // staged install: the badge is the "never invisible" guarantee, and
    // `volli:update-install` gates on phase === "downloaded".
    harness.updater.emit("checking-for-update");
    expect(handle.state().phase).toBe("downloaded");

    harness.updater.failNextCheckWith = new Error("offline");
    await handle.checkNow();
    expect(handle.state().phase).toBe("downloaded");
    expect(harness.logs).toContain("[updater] check failed: offline");

    harness.updater.emit("error", new Error("feed unreachable"));
    expect(handle.state().phase).toBe("downloaded");

    // A real outcome still moves the state: a newer version beginning to
    // download supersedes the staged one.
    harness.updater.emit("update-available", { version: "0.3.0" });
    expect(handle.state()).toMatchObject({ phase: "downloading", targetVersion: "0.3.0" });
    handle.stop();
  });

  it("notifies once per downloaded version — quiet on a re-download, again for a newer one", () => {
    const harness = makeHarness();
    vi.useFakeTimers();
    const handle = harness.start();

    harness.updater.emit("update-downloaded", { version: "0.2.0" });
    harness.updater.emit("update-downloaded", { version: "0.2.0" });
    harness.updater.emit("update-downloaded", { version: "0.3.0" });

    expect(harness.notifications).toEqual([
      {
        producer: "update-ready",
        title: "Update ready",
        body: "Volli Code 0.2.0 has been downloaded and will install when you quit.",
        target: { kind: "update" },
      },
      {
        producer: "update-ready",
        title: "Update ready",
        body: "Volli Code 0.3.0 has been downloaded and will install when you quit.",
        target: { kind: "update" },
      },
    ]);
    // The download itself still logs every time — only the notification dedupes.
    expect(harness.logs.filter((line) => line.includes("downloaded 0.2.0"))).toHaveLength(2);
    handle.stop();
  });
});

describe("the last check's store (VC-294)", () => {
  it("round-trips an answered check", () => {
    ctx = openTestDb();
    const check: UpdateLastCheck = {
      at: 1_700_000,
      result: "error",
      version: null,
      error: "offline",
    };
    writeUpdateLastCheck(ctx.db, check);
    expect(readUpdateLastCheck(ctx.db)).toEqual(check);

    const found: UpdateLastCheck = {
      at: 1_800_000,
      result: "available",
      version: "0.3.0",
      error: null,
    };
    writeUpdateLastCheck(ctx.db, found);
    expect(readUpdateLastCheck(ctx.db)).toEqual(found);
  });

  it("reads never-checked when the row is absent", () => {
    ctx = openTestDb();
    expect(readUpdateLastCheck(ctx.db)).toBeNull();
  });

  it.each([
    ["malformed JSON", "not-json{"],
    ["a non-object", "42"],
    ["null", "null"],
    ["no timestamp", JSON.stringify({ result: "up-to-date" })],
    ["a non-finite timestamp", '{"at":1e999,"result":"up-to-date"}'],
    ["a result this build does not know", JSON.stringify({ at: 1, result: "rolled-back" })],
    ["a non-string result", JSON.stringify({ at: 1, result: 3 })],
  ])("reads never-checked from %s rather than failing", (_label, value) => {
    ctx = openTestDb();
    setAppState(ctx.db, UPDATE_LAST_CHECK_APP_STATE_KEY, value, 1);
    expect(readUpdateLastCheck(ctx.db)).toBeNull();
  });

  it("fills missing or mistyped optional fields with null", () => {
    ctx = openTestDb();
    setAppState(
      ctx.db,
      UPDATE_LAST_CHECK_APP_STATE_KEY,
      JSON.stringify({ at: 5, result: "up-to-date", version: 7, extra: true }),
      1,
    );
    expect(readUpdateLastCheck(ctx.db)).toEqual({
      at: 5,
      result: "up-to-date",
      version: null,
      error: null,
    });
  });
});

/** An in-memory stand-in for the app_state row. */
function memoryStore(initial: UpdateLastCheck | null = null) {
  const store = {
    value: initial,
    writes: [] as UpdateLastCheck[],
    read: () => store.value,
    write: (check: UpdateLastCheck) => {
      store.writes.push(check);
      store.value = check;
    },
  };
  return store;
}

describe("startAutoUpdate's last check (VC-294)", () => {
  it("starts from the stored check — packaged or dev — so a relaunch still knows", () => {
    vi.useFakeTimers();
    const stored: UpdateLastCheck = { at: 9, result: "up-to-date", version: null, error: null };
    const packaged = makeHarness().start({ lastCheck: memoryStore(stored) });
    expect(packaged.state().lastCheck).toEqual(stored);
    packaged.stop();

    const dev = makeHarness().start({ isPackaged: false, lastCheck: memoryStore(stored) });
    expect(dev.state().lastCheck).toEqual(stored);
  });

  it("records each answer with its time, in memory and in the store", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const store = memoryStore();
    let clock = 100;
    const handle = harness.start({ lastCheck: store, now: () => clock });

    harness.updater.emit("checking-for-update");
    expect(handle.state().lastCheck).toBeNull();

    harness.updater.emit("update-not-available", { version: "0.1.0" });
    expect(handle.state().lastCheck).toEqual({
      at: 100,
      result: "up-to-date",
      version: null,
      error: null,
    });

    clock = 200;
    harness.updater.emit("update-available", { version: "0.2.0" });
    expect(handle.state().lastCheck).toEqual({
      at: 200,
      result: "available",
      version: "0.2.0",
      error: null,
    });

    clock = 300;
    harness.updater.emit("error", new Error("download failed"));
    expect(handle.state()).toMatchObject({
      phase: "error",
      lastCheck: { at: 300, result: "error", version: null, error: "download failed" },
    });

    expect(store.writes.map((check) => check.result)).toEqual(["up-to-date", "available", "error"]);
    // Every recorded answer was announced, so an open pane shows it at once.
    expect(harness.stateChanges.at(-1)?.lastCheck).toEqual(store.value);
    handle.stop();
  });

  it("records nothing for a check that settled without an answer", async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const handle = makeHarness().start({ lastCheck: store });

    await handle.checkNow();

    expect(handle.state()).toMatchObject({ phase: "idle", lastCheck: null });
    expect(store.writes).toEqual([]);
    handle.stop();
  });

  it("records a rejected check once, even when the error event reported it too", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const store = memoryStore();
    const handle = harness.start({ lastCheck: store });

    // Rejection alone (no event): still the last check.
    harness.updater.failNextCheckWith = new Error("offline");
    await handle.checkNow();
    expect(store.writes).toHaveLength(1);
    expect(handle.state().lastCheck).toMatchObject({ result: "error", error: "offline" });

    // Event and rejection for the same failure: one check, one record.
    harness.updater.checkForUpdates = () => {
      harness.updater.emit("error", new Error("feed unreachable"));
      return Promise.reject(new Error("feed unreachable"));
    };
    await handle.checkNow();
    expect(store.writes.map((check) => check.error)).toEqual(["offline", "feed unreachable"]);

    // The same failure on a LATER check is a new check, and gets a new time.
    // (The clock moves without firing the schedule's own timers.)
    vi.setSystemTime(Date.now() + 60_000);
    await handle.checkNow();
    expect(store.writes).toHaveLength(3);
    expect(store.writes[2]?.at).toBeGreaterThan(store.writes[1]?.at ?? Infinity);
    handle.stop();
  });

  it("a failed re-check over a staged download updates the last check but keeps the badge", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const store = memoryStore();
    const handle = harness.start({ lastCheck: store });

    harness.updater.emit("update-downloaded", { version: "0.2.0" });
    harness.updater.failNextCheckWith = new Error("offline");
    await handle.checkNow();

    expect(handle.state()).toMatchObject({
      phase: "downloaded",
      targetVersion: "0.2.0",
      error: null,
      lastCheck: { result: "error", error: "offline" },
    });
    handle.stop();
  });

  it("a store that throws is logged and never reaches the updater", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const handle = harness.start({
      lastCheck: {
        read: () => {
          throw new Error("db closed");
        },
        write: () => {
          throw new Error("disk full");
        },
      },
    });

    expect(handle.state().lastCheck).toBeNull();
    harness.updater.emit("update-not-available", { version: "0.1.0" });

    expect(handle.state().lastCheck).toMatchObject({ result: "up-to-date" });
    expect(harness.logs).toContain("[updater] could not read the last check: db closed");
    expect(harness.logs).toContain("[updater] could not record the last check: disk full");
    handle.stop();
  });
});
