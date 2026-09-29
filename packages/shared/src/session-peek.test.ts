import { describe, expect, it } from "vite-plus/test";

import { peekSummaryOf, SESSION_PEEK_ENTRIES, type SessionPeekEntry } from "./session-peek";

function entry(partial: Partial<SessionPeekEntry>): SessionPeekEntry {
  return { at: 1_000, role: "assistant", text: "", tools: [], ...partial };
}

describe("SESSION_PEEK_ENTRIES", () => {
  it("asks for a glance, not a transcript", () => {
    expect(SESSION_PEEK_ENTRIES).toBe(6);
  });
});

describe("peekSummaryOf", () => {
  it("says nothing for an empty tail", () => {
    expect(peekSummaryOf([])).toBeNull();
  });

  it("prefers the newest assistant text", () => {
    expect(
      peekSummaryOf([
        entry({ text: "Older answer" }),
        entry({ role: "user", text: "And then?" }),
        entry({ text: "Newer answer" }),
      ]),
    ).toBe("Newer answer");
  });

  it("never speaks for the person or the system", () => {
    expect(
      peekSummaryOf([
        entry({ text: "What the agent said" }),
        entry({ role: "user", text: "What the person said" }),
        entry({ role: "system", text: "What the harness said" }),
      ]),
    ).toBe("What the agent said");
  });

  it("falls back to the newest tool names when the agent has only acted", () => {
    expect(
      peekSummaryOf([entry({ tools: ["list_dir"] }), entry({ tools: ["read_file", "edit_file"] })]),
    ).toBe("Ran read_file, edit_file");
  });

  it("reads past a tools-only message to the words before it", () => {
    expect(
      peekSummaryOf([entry({ text: "Looking into it" }), entry({ tools: ["read_file"] })]),
    ).toBe("Looking into it");
  });

  it("says nothing when the tail holds neither words nor tools", () => {
    expect(peekSummaryOf([entry({}), entry({ role: "user" })])).toBeNull();
  });
});
