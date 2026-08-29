import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { setAppState } from "../db/app-state-repo";
import { openTestDb, type TestDb } from "../db/test-helpers";
import {
  AUTOMATIONS_DISABLED_KEY,
  disabledAutomationIds,
  setAutomationEnabled,
} from "./enablement";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

describe("disabledAutomationIds", () => {
  it("reads nothing disabled before anyone has touched the switch", () => {
    expect(disabledAutomationIds(ctx.db)).toEqual([]);
  });

  it("survives a blob no build of this app wrote", () => {
    // Tolerant on read, like durable history: this row outlives the build that
    // wrote it, and a hand-edited value must not brick the page reading it.
    for (const stored of ["not json", '"a string"', "42", "null", '{"a1":true}']) {
      setAppState(ctx.db, AUTOMATIONS_DISABLED_KEY, stored, 1);
      expect(disabledAutomationIds(ctx.db)).toEqual([]);
    }
  });

  it("keeps the strings out of a mixed array rather than failing the whole row", () => {
    setAppState(ctx.db, AUTOMATIONS_DISABLED_KEY, JSON.stringify(["a2", 7, null, "a1", "a2"]), 1);
    expect(disabledAutomationIds(ctx.db)).toEqual(["a1", "a2"]);
  });
});

describe("setAutomationEnabled", () => {
  it("stores only the disabled ids, sorted, and answers with the whole set", () => {
    expect(setAutomationEnabled(ctx.db, { automationId: "a2", enabled: false }, 1)).toEqual(["a2"]);
    expect(setAutomationEnabled(ctx.db, { automationId: "a1", enabled: false }, 2)).toEqual([
      "a1",
      "a2",
    ]);
    expect(disabledAutomationIds(ctx.db)).toEqual(["a1", "a2"]);
  });

  it("is idempotent by value rather than a toggle, so a repeated request is safe", () => {
    setAutomationEnabled(ctx.db, { automationId: "a1", enabled: false }, 1);
    expect(setAutomationEnabled(ctx.db, { automationId: "a1", enabled: false }, 2)).toEqual(["a1"]);
    setAutomationEnabled(ctx.db, { automationId: "a1", enabled: true }, 3);
    expect(setAutomationEnabled(ctx.db, { automationId: "a1", enabled: true }, 4)).toEqual([]);
  });

  it("enabling an id nobody disabled changes nothing", () => {
    expect(setAutomationEnabled(ctx.db, { automationId: "never-seen", enabled: true }, 1)).toEqual(
      [],
    );
  });
});
