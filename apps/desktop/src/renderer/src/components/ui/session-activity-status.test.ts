/**
 * `sessionActivityDotState` is the one activity→dot mapping (VC-324). These
 * tests pin its three decisions, because the whole point of centralizing the
 * mapping was that a per-surface switch could quietly disagree with it — so
 * the mapping itself is the thing under test, not any one row.
 */
import { describe, expect, it } from "vite-plus/test";

import { SESSION_ACTIVITY_LABEL, sessionActivityDotState } from "./session-activity-status";

describe("sessionActivityDotState", () => {
  it("attention outranks every activity", () => {
    expect(sessionActivityDotState("working", { attention: true })).toBe("waiting");
    expect(sessionActivityDotState("interrupted", { attention: true })).toBe("waiting");
    expect(sessionActivityDotState("idle", { attention: true })).toBe("waiting");
  });

  it("keeps interrupted interrupted — the last turn died, however long ago (VC-324)", () => {
    expect(sessionActivityDotState("interrupted")).toBe("interrupted");
    expect(sessionActivityDotState("interrupted", { attention: false })).toBe("interrupted");
  });

  it("names the live states and rests everything else at idle", () => {
    expect(sessionActivityDotState("working")).toBe("working");
    expect(sessionActivityDotState("waiting")).toBe("waiting");
    for (const resting of ["idle", "parked", "exited", "stopped"] as const) {
      expect(sessionActivityDotState(resting)).toBe("idle");
    }
  });

  it("says every activity in words, including interrupted", () => {
    expect(SESSION_ACTIVITY_LABEL.interrupted).toBe("Interrupted");
    expect(SESSION_ACTIVITY_LABEL.stopped).toBe("Stopped");
  });
});
