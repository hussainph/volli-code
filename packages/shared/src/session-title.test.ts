import { describe, expect, it } from "vite-plus/test";

import {
  autoTitleFromKickoff,
  autoTitleFromMessage,
  DEFAULT_KICKOFF_MESSAGE,
} from "./session-title";

describe("autoTitleFromMessage", () => {
  it("uses the first visible line and collapses whitespace", () => {
    expect(autoTitleFromMessage("\n  Fix   the\tparser\nDetails below.")).toBe("Fix the parser");
  });

  it("cuts long lines at a word boundary", () => {
    expect(
      autoTitleFromMessage("Investigate why the worktree exec socket keeps dropping mid session"),
    ).toBe("Investigate why the worktree exec socket keeps…");
  });

  it("keeps a line at the limit and hard-cuts one long word", () => {
    const atLimit = "a".repeat(48);
    expect(autoTitleFromMessage(atLimit)).toBe(atLimit);
    expect(autoTitleFromMessage("a".repeat(60))).toBe(`${"a".repeat(48)}…`);
  });

  it("returns null for whitespace only", () => {
    expect(autoTitleFromMessage(" \n\t")).toBeNull();
  });
});

describe("autoTitleFromKickoff", () => {
  it("honors the orchestration stage plus ticket pattern", () => {
    expect(autoTitleFromKickoff("validate vc-52 before release", "VC-9")).toBe("Validate VC-52");
  });

  it("names the started ticket rather than an empty or stock instruction", () => {
    expect(autoTitleFromKickoff("", "VC-9")).toBe("Work on VC-9");
    expect(
      autoTitleFromKickoff(
        "Begin work on this ticket. Your assignment is the Ticket Brief above.",
        "VC-9",
      ),
    ).toBe("Work on VC-9");
  });

  // The stock-kickoff arm above is a regex, and the sentence it recognises is a
  // constant every door starting a Ticket Session sends. Nothing else notices
  // if the two drift — the door keeps working and quietly titles its Sessions
  // after the instruction.
  it("recognises the shipped DEFAULT_KICKOFF_MESSAGE as the stock instruction", () => {
    expect(autoTitleFromKickoff(DEFAULT_KICKOFF_MESSAGE, "VC-56")).toBe("Work on VC-56");
  });

  it("keeps a meaningful kickoff that does not name a ticket", () => {
    expect(autoTitleFromKickoff("Fix the flaky parser test", "VC-9")).toBe(
      "Fix the flaky parser test",
    );
  });
});
