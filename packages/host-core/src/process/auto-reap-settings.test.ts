import { afterEach, describe, expect, it } from "vite-plus/test";

import { setAppState } from "../db/app-state-repo";
import { openTestDb } from "../db/test-helpers";
import {
  AUTO_REAP_SETTINGS_KEY,
  getAutoReapPolicy,
  MIN_AUTO_REAP_AGE_HOURS,
  setAutoReapPolicy,
} from "./auto-reap-settings";

const NOW = 1_800_000_000_000;
const handles: ReturnType<typeof openTestDb>[] = [];

function testDb(): ReturnType<typeof openTestDb> {
  const handle = openTestDb();
  handles.push(handle);
  return handle;
}

afterEach(() => {
  while (handles.length > 0) handles.pop()!.cleanup();
});

describe("the automatic-reaping preference", () => {
  it("is off until someone turns it on", () => {
    const { db } = testDb();
    expect(getAutoReapPolicy(db)).toEqual({ enabled: false, minimumAgeHours: 24 });
  });

  it("round-trips what a person chose", () => {
    const { db } = testDb();
    expect(setAutoReapPolicy(db, { enabled: true, minimumAgeHours: 6 }, NOW)).toEqual({
      enabled: true,
      minimumAgeHours: 6,
    });
    expect(getAutoReapPolicy(db)).toEqual({ enabled: true, minimumAgeHours: 6 });
  });

  it("clamps a threshold below the floor rather than reaping work still in flight", () => {
    const { db } = testDb();
    expect(
      setAutoReapPolicy(db, { enabled: true, minimumAgeHours: MIN_AUTO_REAP_AGE_HOURS - 1 }, NOW)
        .minimumAgeHours,
    ).toBe(24);
    expect(
      setAutoReapPolicy(db, { enabled: true, minimumAgeHours: 3.7 }, NOW).minimumAgeHours,
    ).toBe(3);
  });

  it("reads an unreadable setting as OFF — never as permission to kill", () => {
    const { db } = testDb();
    setAppState(db, AUTO_REAP_SETTINGS_KEY, "{not json", NOW);
    expect(getAutoReapPolicy(db).enabled).toBe(false);
    setAppState(db, AUTO_REAP_SETTINGS_KEY, JSON.stringify({ minimumAgeHours: 1 }), NOW);
    expect(getAutoReapPolicy(db)).toEqual({ enabled: false, minimumAgeHours: 24 });
    setAppState(db, AUTO_REAP_SETTINGS_KEY, JSON.stringify({ enabled: true }), NOW);
    expect(getAutoReapPolicy(db)).toEqual({ enabled: true, minimumAgeHours: 24 });
  });
});
