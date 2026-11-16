import { afterEach, describe, expect, it } from "vite-plus/test";

import { setAppState } from "../db/app-state-repo";
import { openTestDb } from "../db/test-helpers";
import {
  QUIT_RESUME_APP_STATE_KEY,
  readAutoResumeAfterQuit,
  writeAutoResumeAfterQuit,
} from "./quit-resume-settings";

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

describe("automatic resume after a quit (VC-1245)", () => {
  it("is off until someone turns it on, and every upgraded profile starts off", () => {
    const { db } = testDb();
    expect(readAutoResumeAfterQuit(db)).toBe(false);
  });

  it("stores what was chosen", () => {
    const { db } = testDb();
    expect(writeAutoResumeAfterQuit(db, true, NOW)).toBe(true);
    expect(readAutoResumeAfterQuit(db)).toBe(true);
    expect(writeAutoResumeAfterQuit(db, false, NOW)).toBe(false);
    expect(readAutoResumeAfterQuit(db)).toBe(false);
  });

  it.each(["not json", "null", "true", '{"autoResume":"yes"}', "{}"])(
    "reads an illegible value (%s) as off",
    (raw) => {
      const { db } = testDb();
      setAppState(db, QUIT_RESUME_APP_STATE_KEY, raw, NOW);
      expect(readAutoResumeAfterQuit(db)).toBe(false);
    },
  );
});
