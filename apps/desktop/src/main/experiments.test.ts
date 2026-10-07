import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getAppState, setAppState, settleTransaction } from "@volli/host-core/db";
import { openRawDb, openTestDb, type TestDb } from "@volli/host-core/testing";
import {
  ExperimentalSettings,
  EXPERIMENTS_APP_STATE_KEY,
  installExperimentalSettings,
  isExperimentEnabled,
  readExperiments,
  setExperiment,
} from "./experiments";
import { describeWithExperiment } from "./test-helpers/experiments";

let ctx: TestDb | undefined;
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  ctx?.cleanup();
  ctx = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function boot(environment?: string): ExperimentalSettings {
  ctx ??= openTestDb();
  const settings = new ExperimentalSettings(ctx.db, environment, () => 123);
  restore = installExperimentalSettings(settings);
  return settings;
}

describe("experimental host settings", () => {
  it("defaults off before and after boot, without writing anything", () => {
    expect(isExperimentEnabled("cloud")).toBe(false);
    boot();
    expect(readExperiments()).toEqual({ cloud: { enabled: false, source: "default" } });
    expect(getAppState(ctx!.db, EXPERIMENTS_APP_STATE_KEY)).toBeUndefined();
  });

  it("persists both states across an actual database close and reopen", async () => {
    boot();
    expect(await setExperiment("cloud", true)).toEqual({
      cloud: { enabled: true, source: "storage" },
    });
    expect(isExperimentEnabled("cloud")).toBe(true);
    expect(getAppState(ctx!.db, EXPERIMENTS_APP_STATE_KEY)).toBe('{"cloud":true}');
    ctx!.db.close();
    const reopened = openRawDb(ctx!.dbPath);
    try {
      const restarted = new ExperimentalSettings(reopened, undefined);
      expect(restarted.isEnabled("cloud")).toBe(true);
      await restarted.set("cloud", false);
    } finally {
      reopened.close();
    }
    const third = openRawDb(ctx!.dbPath);
    try {
      expect(new ExperimentalSettings(third, undefined).isEnabled("cloud")).toBe(false);
    } finally {
      third.close();
    }
  });

  it("ignores unknown stored ids and corrupt storage", () => {
    ctx = openTestDb();
    setAppState(ctx.db, EXPERIMENTS_APP_STATE_KEY, '{"future":true,"cloud":true}', 1);
    expect(new ExperimentalSettings(ctx.db, undefined).isEnabled("cloud")).toBe(true);
    setAppState(ctx.db, EXPERIMENTS_APP_STATE_KEY, "{", 2);
    expect(new ExperimentalSettings(ctx.db, undefined).snapshot().cloud).toEqual({
      enabled: false,
      source: "default",
    });
  });

  it("does not erase a newer build's settings when changing a known flag", async () => {
    ctx = openTestDb();
    setAppState(ctx.db, EXPERIMENTS_APP_STATE_KEY, '{"future":true,"cloud":false}', 1);
    boot();
    await setExperiment("cloud", true);
    expect(JSON.parse(getAppState(ctx.db, EXPERIMENTS_APP_STATE_KEY)!)).toEqual({
      future: true,
      cloud: true,
    });
    expect(readExperiments()).toEqual({ cloud: { enabled: true, source: "storage" } });
  });

  it("captures the boot environment once, overrides storage, and refuses a locked write", async () => {
    ctx = openTestDb();
    setAppState(ctx.db, EXPERIMENTS_APP_STATE_KEY, '{"cloud":false}', 1);
    vi.stubEnv("VOLLI_EXPERIMENTAL", "cloud");
    boot(process.env["VOLLI_EXPERIMENTAL"]);
    vi.stubEnv("VOLLI_EXPERIMENTAL", "");
    expect(readExperiments().cloud).toEqual({ enabled: true, source: "environment" });
    await expect(setExperiment("cloud", false)).rejects.toThrow("set by environment");
    expect(getAppState(ctx.db, EXPERIMENTS_APP_STATE_KEY)).toBe('{"cloud":false}');
    expect(
      new ExperimentalSettings(ctx.db, process.env["VOLLI_EXPERIMENTAL"]).isEnabled("cloud"),
    ).toBe(false);
  });

  it("ignores retired environment ids with one warning and still enables known flags", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("VOLLI_EXPERIMENTAL", "cloud,retired-flag");
    expect(() => boot(process.env["VOLLI_EXPERIMENTAL"])).not.toThrow();
    expect(readExperiments().cloud).toEqual({ enabled: true, source: "environment" });
    expect(isExperimentEnabled("cloud")).toBe(true);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "[experiments] ignoring unknown VOLLI_EXPERIMENTAL ids",
      { ids: ["retired-flag"] },
    );
    expect(getAppState(ctx!.db, EXPERIMENTS_APP_STATE_KEY)).toBeUndefined();
  });

  it("matches environment ids case-insensitively without warning for known ids", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("VOLLI_EXPERIMENTAL", "Cloud");
    boot(process.env["VOLLI_EXPERIMENTAL"]);
    expect(readExperiments().cloud).toEqual({ enabled: true, source: "environment" });
    expect(warning).not.toHaveBeenCalled();
  });

  it("keeps flags dark for unknown-only env ids and groups warnings once at boot", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    boot(" Retired-Flag,retired-flag,other ");
    expect(isExperimentEnabled("cloud")).toBe(false);
    expect(readExperiments().cloud.source).toBe("default");
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "[experiments] ignoring unknown VOLLI_EXPERIMENTAL ids",
      { ids: ["retired-flag", "other"] },
    );
  });

  it("rejects unknown reader ids and commands before writing", async () => {
    boot();
    // @ts-expect-error Runtime clients cannot bypass the registry either.
    expect(() => isExperimentEnabled("other")).toThrow("Unknown experiment");
    // @ts-expect-error Runtime commands are validated as well as typed.
    await expect(setExperiment("other", true)).rejects.toThrow("Unknown experiment");
    // @ts-expect-error A non-boolean cannot become durable intent.
    await expect(setExperiment("cloud", "yes")).rejects.toThrow("must be a boolean");
    expect(getAppState(ctx!.db, EXPERIMENTS_APP_STATE_KEY)).toBeUndefined();
  });

  it("reads defaults in degraded mode but refuses writes", async () => {
    restore = installExperimentalSettings(new ExperimentalSettings(null, undefined));
    expect(isExperimentEnabled("cloud")).toBe(false);
    await expect(setExperiment("cloud", true)).rejects.toThrow("storage is unavailable");
  });

  it("publishes committed flags without joining an invalid awaited transaction", async () => {
    boot();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // @ts-expect-error Transaction work cannot span an await.
    const other = settleTransaction(ctx!.db, async () => {
      await held;
      throw new Error("other writer rolled back");
    });
    const rejected = expect(other).rejects.toThrow("must be synchronous");
    const saving = setExperiment("cloud", true);
    expect(ctx!.db.inTransaction).toBe(false);
    expect(isExperimentEnabled("cloud")).toBe(true);
    expect(new ExperimentalSettings(ctx!.db, undefined).isEnabled("cloud")).toBe(true);
    release();
    await rejected;
    await saving;
    expect(isExperimentEnabled("cloud")).toBe(true);
    expect(new ExperimentalSettings(ctx!.db, undefined).isEnabled("cloud")).toBe(true);
  });

  it("serializes concurrent settings commands and publishes the last committed value", async () => {
    boot();
    const [on, off] = await Promise.all([
      setExperiment("cloud", true),
      setExperiment("cloud", false),
    ]);
    expect(on.cloud.enabled).toBe(true);
    expect(off.cloud.enabled).toBe(false);
    expect(isExperimentEnabled("cloud")).toBe(false);
    expect(new ExperimentalSettings(ctx!.db, undefined).isEnabled("cloud")).toBe(false);
  });

  it("keeps the last committed value when persistence fails", async () => {
    boot();
    await setExperiment("cloud", true);
    ctx!.db.exec(`CREATE TRIGGER refuse_experiment BEFORE UPDATE ON app_state
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    await expect(setExperiment("cloud", false)).rejects.toThrow("disk full");
    expect(isExperimentEnabled("cloud")).toBe(true);
    expect(new ExperimentalSettings(ctx!.db, undefined).isEnabled("cloud")).toBe(true);
  });
});

describeWithExperiment("cloud", () => {
  it("lets later cloud suites exercise the on state through the production reader", () => {
    expect(isExperimentEnabled("cloud")).toBe(true);
    expect(readExperiments().cloud.source).toBe("environment");
  });
});

describe("after the flag-on suite", () => {
  it("restores the default reader so existing tests stay dark", () => {
    expect(isExperimentEnabled("cloud")).toBe(false);
  });
});
