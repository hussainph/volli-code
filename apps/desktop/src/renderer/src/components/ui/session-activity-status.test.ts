/**
 * `sessionActivityDotState` is the one activity→dot mapping (VC-324). These
 * tests pin its three decisions, because the whole point of centralizing the
 * mapping was that a per-surface switch could quietly disagree with it — so
 * the mapping itself is the thing under test, not any one row.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_ACTIVITY_LABEL,
  sessionActivityDotState,
  sessionActivityIsLive,
  sessionAttentionRank,
} from "./session-activity-status";
import type { StatusDotState } from "./status-dot";

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

/**
 * The two facts both rosters sort and split on (VC-406). Pinned here, on the
 * shared vocabulary, because the defect they replace was each roster deciding
 * for itself — Home's and the Ticket rail's — and drifting.
 */
describe("sessionActivityIsLive", () => {
  it("ends a Session only where something actually ended it", () => {
    expect(sessionActivityIsLive("stopped")).toBe(false);
    expect(sessionActivityIsLive("exited")).toBe(false);
  });

  it("keeps a Session to go back to live, interrupted included (VC-324)", () => {
    for (const activity of ["working", "waiting", "interrupted", "idle", "parked"] as const) {
      expect(sessionActivityIsLive(activity), activity).toBe(true);
    }
  });
});

describe("sessionAttentionRank", () => {
  it("puts what is asking for a person above what is merely busy or quiet", () => {
    expect(sessionAttentionRank("waiting")).toBeLessThan(sessionAttentionRank("error"));
    expect(sessionAttentionRank("error")).toBeLessThan(sessionAttentionRank("working"));
    expect(sessionAttentionRank("working")).toBeLessThan(sessionAttentionRank("idle"));
    expect(sessionAttentionRank("idle")).toBeLessThan(sessionAttentionRank("exited"));
  });

  it("ranks a broken turn with what broke, not with the quiet rows", () => {
    // The row `interrupted` used to sort with: alive and saying nothing.
    expect(sessionAttentionRank("interrupted")).toBe(sessionAttentionRank("error"));
    expect(sessionAttentionRank("interrupted")).toBeLessThan(sessionAttentionRank("idle"));
  });

  it("answers for every dot state, so no row can sort on an undefined", () => {
    const states: readonly StatusDotState[] = [
      "waiting",
      "error",
      "interrupted",
      "working",
      "setup",
      "ready",
      "starting",
      "idle",
      "parked",
      "exited",
      "stopped",
    ];
    for (const state of states) {
      expect(Number.isFinite(sessionAttentionRank(state)), state).toBe(true);
    }
  });
});
