import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { UpdateUiState } from "../ipc/contract";
import {
  readAllowPrerelease,
  readUpdateChannel,
  writeUpdateChannel,
  startAutoUpdate,
  UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY,
  type AutoUpdaterLike,
} from "./auto-update";
import { setAppState } from "./db/app-state-repo";
import { openTestDb, type TestDb } from "./db/test-helpers";

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
  notifications: { title: string; body: string }[];
  /** Every state the module announced through `onStateChange`, in order. */
  stateChanges: UpdateUiState[];
  /** What `hasUpdateSurface()` answers — flip it to simulate windows opening/closing. */
  surface: { present: boolean };
  start(overrides?: {
    isPackaged?: boolean;
    allowPrerelease?: boolean;
  }): ReturnType<typeof startAutoUpdate>;
}

function makeHarness(): Harness {
  const updater = new FakeUpdater();
  const logs: string[] = [];
  const notifications: { title: string; body: string }[] = [];
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
        notify: (title, body) => notifications.push({ title, body }),
        log: (line) => logs.push(line),
        onStateChange: (state) => stateChanges.push(state),
        hasUpdateSurface: () => surface.present,
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
        title: "Update ready",
        body: "Volli Code 0.2.0 has been downloaded and will install when you quit.",
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
        title: "Update ready",
        body: "Volli Code 0.2.0 has been downloaded and will install when you quit.",
      },
      {
        title: "Update ready",
        body: "Volli Code 0.3.0 has been downloaded and will install when you quit.",
      },
    ]);
    // The download itself still logs every time — only the notification dedupes.
    expect(harness.logs.filter((line) => line.includes("downloaded 0.2.0"))).toHaveLength(2);
    handle.stop();
  });
});
