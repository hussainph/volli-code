import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { getAppState, setAppState } from "../db/app-state-repo";
import { openTestDb, type TestDb } from "../db/test-helpers";
import {
  AUTOMATIONS_ENABLED_KEY,
  enabledAutomationIds,
  putEnabledAutomationIds,
} from "./enablement";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

describe("enabledAutomationIds", () => {
  it("reads nothing switched on before anyone has touched a switch", () => {
    // VC-112: a machine fires nothing until someone turns something on there.
    expect(enabledAutomationIds(ctx.db)).toEqual([]);
  });

  it("survives a blob no build of this app wrote, and fails closed", () => {
    // Tolerant on read, like durable history: this row outlives the build that
    // wrote it, and a hand-edited value must not brick the page reading it.
    // Unreadable reads as "nothing on", which is the safe direction.
    for (const stored of ["not json", '"a string"', "42", "null", '{"a1":true}']) {
      setAppState(ctx.db, AUTOMATIONS_ENABLED_KEY, stored, 1);
      expect(enabledAutomationIds(ctx.db)).toEqual([]);
    }
  });

  it("fails closed on a MIXED array too, rather than salvaging the readable half", () => {
    // Half-understood is not understood. Keeping "a1" here would be a guess
    // about which Automations somebody armed on this machine, and a wrong
    // guess in that direction fires work nobody asked for; refusing the whole
    // row can only under-fire, which VC-112 already calls the resting state.
    setAppState(ctx.db, AUTOMATIONS_ENABLED_KEY, JSON.stringify(["a2", 7, null, "a1", "a2"]), 1);
    expect(enabledAutomationIds(ctx.db)).toEqual([]);
  });

  it("still reads a wholly well-formed array, deduped and sorted", () => {
    setAppState(ctx.db, AUTOMATIONS_ENABLED_KEY, JSON.stringify(["a2", "a1", "a2"]), 1);
    expect(enabledAutomationIds(ctx.db)).toEqual(["a1", "a2"]);
  });
});

describe("putEnabledAutomationIds", () => {
  it("stores the set sorted and deduped, so equal sets are equal bytes", () => {
    expect(putEnabledAutomationIds(ctx.db, ["a2", "a1", "a2"], 1)).toEqual(["a1", "a2"]);
    expect(getAppState(ctx.db, AUTOMATIONS_ENABLED_KEY)).toBe(JSON.stringify(["a1", "a2"]));
    expect(enabledAutomationIds(ctx.db)).toEqual(["a1", "a2"]);
  });

  it("replaces the row whole — the set it is given is the set that is on", () => {
    putEnabledAutomationIds(ctx.db, ["a1", "a2"], 1);
    expect(putEnabledAutomationIds(ctx.db, ["a2"], 2)).toEqual(["a2"]);
    expect(enabledAutomationIds(ctx.db)).toEqual(["a2"]);
    expect(putEnabledAutomationIds(ctx.db, [], 3)).toEqual([]);
    expect(enabledAutomationIds(ctx.db)).toEqual([]);
  });
});
