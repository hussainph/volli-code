import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { getAppState, setAppState } from "../db/app-state-repo";
import { openTestDb, type TestDb } from "../db/test-helpers";
import {
  advanceScheduleCursor,
  AUTOMATION_SCHEDULE_CURSORS_KEY,
  readScheduleCursors,
  rebaseScheduleCursor,
} from "./schedule-cursor";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

describe("readScheduleCursors", () => {
  it("reads nothing evaluated before this host has ever looked", () => {
    // Which is the non-retroactive rule at rest: a machine that has never
    // watched a schedule is owed none of its past occurrences.
    expect(readScheduleCursors(ctx.db)).toEqual({});
  });

  it("reads what was written", () => {
    advanceScheduleCursor(ctx.db, { automationId: "a1", through: 1_000 }, 5);
    advanceScheduleCursor(ctx.db, { automationId: "a2", through: 2_000 }, 5);
    expect(readScheduleCursors(ctx.db)).toEqual({ a1: 1_000, a2: 2_000 });
  });

  it("survives a row no build of this app wrote", () => {
    for (const stored of ["{", "[]", "null", '"nope"', "7"]) {
      setAppState(ctx.db, AUTOMATION_SCHEDULE_CURSORS_KEY, stored, 1);
      expect(readScheduleCursors(ctx.db)).toEqual({});
    }
  });

  it("drops one unreadable entry rather than every other schedule's", () => {
    // Per-entry, not per-record: voiding the map would restart every OTHER
    // schedule's clock, which silently forgives skips that really were owed.
    setAppState(
      ctx.db,
      AUTOMATION_SCHEDULE_CURSORS_KEY,
      JSON.stringify({ a1: 1_000, a2: "tomorrow", a3: null, a4: Number.NaN }),
      1,
    );
    expect(readScheduleCursors(ctx.db)).toEqual({ a1: 1_000 });
  });
});

describe("advanceScheduleCursor", () => {
  it("moves one schedule forward and leaves the others alone", () => {
    advanceScheduleCursor(ctx.db, { automationId: "a1", through: 1_000 }, 5);
    advanceScheduleCursor(ctx.db, { automationId: "a2", through: 2_000 }, 5);
    expect(advanceScheduleCursor(ctx.db, { automationId: "a1", through: 3_000 }, 6)).toEqual({
      a1: 3_000,
      a2: 2_000,
    });
  });

  it("never moves backwards, so a stale pass cannot make an evening due again", () => {
    // Never-replay, expressed in storage: a second window or a retried pass
    // holding an older answer must not drag the cursor back over an occurrence
    // that has already been fired or skipped.
    advanceScheduleCursor(ctx.db, { automationId: "a1", through: 3_000 }, 5);
    expect(advanceScheduleCursor(ctx.db, { automationId: "a1", through: 1_000 }, 6)).toEqual({
      a1: 3_000,
    });
    expect(readScheduleCursors(ctx.db)).toEqual({ a1: 3_000 });
  });

  it("writes nothing when there is nothing to move", () => {
    advanceScheduleCursor(ctx.db, { automationId: "a1", through: 3_000 }, 5);
    const written = getAppState(ctx.db, AUTOMATION_SCHEDULE_CURSORS_KEY);
    advanceScheduleCursor(ctx.db, { automationId: "a1", through: 3_000 }, 9);
    expect(getAppState(ctx.db, AUTOMATION_SCHEDULE_CURSORS_KEY)).toBe(written);
  });
});

describe("rebaseScheduleCursor", () => {
  it("starts one new lifecycle and leaves every other schedule alone", () => {
    advanceScheduleCursor(ctx.db, { automationId: "a1", through: 3_000 }, 5);
    advanceScheduleCursor(ctx.db, { automationId: "a2", through: 2_000 }, 5);

    expect(rebaseScheduleCursor(ctx.db, { automationId: "a1", through: 1_000 }, 6)).toEqual({
      a1: 1_000,
      a2: 2_000,
    });
    expect(readScheduleCursors(ctx.db)).toEqual({ a1: 1_000, a2: 2_000 });
  });

  it("durably establishes the baseline before a scheduler has seen the schedule", () => {
    expect(rebaseScheduleCursor(ctx.db, { automationId: "a1", through: 1_000 }, 6)).toEqual({
      a1: 1_000,
    });
    expect(readScheduleCursors(ctx.db)).toEqual({ a1: 1_000 });
  });
});
