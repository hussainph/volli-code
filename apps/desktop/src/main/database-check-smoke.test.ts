/** The smoke-only seams of a launch's database check (VC-1203): inert unless set. */
import { describe, expect, it } from "vite-plus/test";

import {
  holdDatabaseCheckForSmoke,
  smokeDatabaseCheckOffMainBytes,
  smokeBackupHoldRows,
  smokeDatabaseWorkerHoldRows,
  smokeDatabaseWorkerHoldUntil,
  type DatabaseCheckSmokeGlobal,
} from "./database-check-smoke";

describe("smokeDatabaseCheckOffMainBytes", () => {
  it("is the shipped default unless a whole number is set", () => {
    expect(smokeDatabaseCheckOffMainBytes({})).toBeUndefined();
    expect(smokeDatabaseCheckOffMainBytes({ VOLLI_SMOKE_DATABASE_CHECK_OFF_MAIN_BYTES: "" })).toBe(
      undefined,
    );
    expect(
      smokeDatabaseCheckOffMainBytes({ VOLLI_SMOKE_DATABASE_CHECK_OFF_MAIN_BYTES: "-1" }),
    ).toBeUndefined();
    expect(
      smokeDatabaseCheckOffMainBytes({ VOLLI_SMOKE_DATABASE_CHECK_OFF_MAIN_BYTES: "1e3" }),
    ).toBeUndefined();
    expect(smokeDatabaseCheckOffMainBytes({ VOLLI_SMOKE_DATABASE_CHECK_OFF_MAIN_BYTES: "0" })).toBe(
      0,
    );
  });
});

describe("smokeDatabaseWorkerHoldRows", () => {
  it("holds nothing unless a whole number is set", () => {
    expect(smokeDatabaseWorkerHoldRows({})).toBeUndefined();
    expect(
      smokeDatabaseWorkerHoldRows({ VOLLI_SMOKE_DATABASE_WORKER_HOLD_ROWS: "" }),
    ).toBeUndefined();
    expect(
      smokeDatabaseWorkerHoldRows({ VOLLI_SMOKE_DATABASE_WORKER_HOLD_ROWS: "2e9" }),
    ).toBeUndefined();
    expect(
      smokeDatabaseWorkerHoldRows({ VOLLI_SMOKE_DATABASE_WORKER_HOLD_ROWS: "2000000000" }),
    ).toBe(2_000_000_000);
  });
});

describe("smokeBackupHoldRows", () => {
  it("holds nothing unless a whole number is set", () => {
    expect(smokeBackupHoldRows({})).toBeUndefined();
    expect(smokeBackupHoldRows({ VOLLI_SMOKE_BACKUP_HOLD_ROWS: "1.5" })).toBeUndefined();
    expect(smokeBackupHoldRows({ VOLLI_SMOKE_BACKUP_HOLD_ROWS: "1000" })).toBe(1000);
  });
});

describe("smokeDatabaseWorkerHoldUntil", () => {
  it("holds nothing unless an absolute path is set", () => {
    expect(smokeDatabaseWorkerHoldUntil({})).toBeUndefined();
    expect(
      smokeDatabaseWorkerHoldUntil({ VOLLI_SMOKE_DATABASE_WORKER_HOLD_UNTIL: "" }),
    ).toBeUndefined();
    expect(
      smokeDatabaseWorkerHoldUntil({ VOLLI_SMOKE_DATABASE_WORKER_HOLD_UNTIL: "relative/file" }),
    ).toBeUndefined();
    expect(
      smokeDatabaseWorkerHoldUntil({ VOLLI_SMOKE_DATABASE_WORKER_HOLD_UNTIL: "/tmp/release" }),
    ).toBe("/tmp/release");
  });
});

describe("holdDatabaseCheckForSmoke", () => {
  it("does not hold an ordinary launch", async () => {
    const target: DatabaseCheckSmokeGlobal = {};
    await holdDatabaseCheckForSmoke({ VOLLI_SMOKE_HOLD_DATABASE_CHECK: "0" }, target);
    await holdDatabaseCheckForSmoke({}, target);
    expect(target.volliSmokeReleaseDatabaseCheck).toBeUndefined();
  });

  it("holds until the smoke releases it, once", async () => {
    const target: DatabaseCheckSmokeGlobal = {};
    let released = false;
    const held = holdDatabaseCheckForSmoke({ VOLLI_SMOKE_HOLD_DATABASE_CHECK: "1" }, target).then(
      () => {
        released = true;
      },
    );
    await Promise.resolve();
    expect(released).toBe(false);
    target.volliSmokeReleaseDatabaseCheck?.();
    await held;
    expect(released).toBe(true);
    expect(target.volliSmokeReleaseDatabaseCheck).toBeUndefined();
  });
});
