import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readAllowPrerelease,
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
}

interface Harness {
  updater: FakeUpdater;
  logs: string[];
  notifications: { title: string; body: string }[];
  start(overrides?: {
    isPackaged?: boolean;
    allowPrerelease?: boolean;
  }): ReturnType<typeof startAutoUpdate>;
}

function makeHarness(): Harness {
  const updater = new FakeUpdater();
  const logs: string[] = [];
  const notifications: { title: string; body: string }[] = [];
  return {
    updater,
    logs,
    notifications,
    start: (overrides = {}) =>
      startAutoUpdate({
        isPackaged: overrides.isPackaged ?? true,
        updater,
        allowPrerelease: overrides.allowPrerelease ?? false,
        notify: (title, body) => notifications.push({ title, body }),
        log: (line) => logs.push(line),
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
