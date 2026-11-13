/** The smoke-only seams of a launch's database check (VC-1203): inert unless set. */
import { describe, expect, it } from "vite-plus/test";

import {
  holdDatabaseCheckForSmoke,
  smokeDatabaseCheckOffMainBytes,
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
