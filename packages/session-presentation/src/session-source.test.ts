import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  harnessLabel,
  PERSON_STARTED,
  type ChatSessionRecord,
  type HarnessId,
  type SessionListingRow,
  type SessionRecord,
} from "@volli/shared";

import { sessionSourceHarness, sessionSourceLabel } from "./session-source";

function terminalRow(session: SessionRecord): SessionListingRow {
  return {
    kind: "terminal",
    record: session,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  };
}

const sourceLabel = (session: SessionRecord) => sessionSourceLabel(terminalRow(session));

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    projectId: "p1",
    ticketId: "t1",
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "unknown",
    placement: "unknown",
    title: "Session 1",
    cwd: "/repo",
    createdAt: 1,
    endedAt: null,
    exitCode: null,
    lastActivityAt: 1,
    bornTicketless: false,
    ...overrides,
  };
}

function chatRecord(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: "chat-1",
    title: "Plan the migration",
    projectId: "p1",
    ticketId: "t1",
    createdAt: 1,
    adapterId: "opencode",
    live: true,
    activity: "idle",
    waitingOn: null,
    outcome: null,
    lastActivityAt: 1,
    bornTicketless: false,
    role: "ticket",
    parentSessionId: null,
    model: null,
    ...overrides,
  };
}

describe("sessionSourceLabel", () => {
  it("uses the actual harness only for sessions that launched an agent", () => {
    expect(sourceLabel(record({ launchKind: "agent", harnessId: "codex", placement: "tab" }))).toBe(
      "Codex",
    );
  });

  it("describes bare terminal tabs and splits without pretending they are Claude Code", () => {
    expect(sourceLabel(record({ launchKind: "shell", placement: "tab" }))).toBe("Shell");
    expect(sourceLabel(record({ launchKind: "shell", placement: "split" }))).toBe("Shell · Split");
  });

  // The pane says what is IN it. A terminal opened by opencode that the user
  // quit and replaced with claude reads as Claude Code.
  it("names the harness that is running, not the one that opened the pane", () => {
    expect(
      sourceLabel(
        record({ launchKind: "agent", harnessId: "opencode", activeHarnessId: "claude-code" }),
      ),
    ).toBe("Claude Code");
  });

  // `launchKind` is a fact about the pane's origin, and no announce changes it:
  // a shell that later ran an agent is still a shell tab.
  it("still reads as a shell when a harness announced itself inside one", () => {
    expect(sourceLabel(record({ launchKind: "shell", activeHarnessId: "claude-code" }))).toBe(
      "Shell",
    );
  });

  it("keeps legacy records honest when their launch kind was never recorded", () => {
    expect(sourceLabel(record())).toBe("Terminal");
    expect(sourceLabel(record({ placement: "split" }))).toBe("Terminal · Split");
  });

  // An unrecognized harness slug is still an agent launch; it is named by the
  // slug rather than silently borrowing the default harness's label.
  it("names an agent launch whose harness this build does not know", () => {
    expect(
      sourceLabel(record({ launchKind: "agent", harnessId: "my-custom-harness" as HarnessId })),
    ).toBe("my-custom-harness");
  });

  // A chat row has no PTY to describe, and attachment is not source metadata.
  it("names a chat row without displaying its attachment state", () => {
    expect(sessionSourceLabel({ kind: "chat", record: chatRecord({ live: true }) })).toBe("Chat");
    expect(sessionSourceLabel({ kind: "chat", record: chatRecord({ live: false }) })).toBe("Chat");
  });

  // The Role is the row's source (VC-9): a helper another Session started is
  // named as one, so a person scanning the list can tell it from the chat
  // that started it.
  it("names a Subagent Session by its Role and the parent it answers to", () => {
    expect(
      sessionSourceLabel({
        kind: "chat",
        record: chatRecord({
          role: "subagent",
          parentSessionId: "aaaaaaaa-0000-0000-0000-000000000000",
        }),
      }),
    ).toBe("Subagent · of aaaaaaaa");
    // A helper whose parent the ledger does not name is still a helper.
    expect(sessionSourceLabel({ kind: "chat", record: chatRecord({ role: "subagent" }) })).toBe(
      "Subagent",
    );
  });
});

describe("sessionSourceHarness", () => {
  const sourceHarness = (session: SessionRecord) => sessionSourceHarness(terminalRow(session));

  // The id half of the label's own verdict, reached by the same rule: a glyph
  // and the words beside it must never name two different harnesses.
  it("names the harness an agent launch is running", () => {
    expect(sourceHarness(record({ launchKind: "agent", harnessId: "codex" }))).toBe("codex");
    expect(
      sourceHarness(
        record({ launchKind: "agent", harnessId: "opencode", activeHarnessId: "claude-code" }),
      ),
    ).toBe("claude-code");
  });

  // A custom slug round-trips rather than collapsing to the default harness —
  // the caller decides what artwork an unknown harness gets, and it can only
  // decide that if it is told the slug.
  it("hands back an unrecognized slug verbatim", () => {
    expect(
      sourceHarness(record({ launchKind: "agent", harnessId: "my-custom-harness" as HarnessId })),
    ).toBe("my-custom-harness");
  });

  // Everything the label refuses to call a harness, this refuses to name one
  // for — including the shell that later ran an agent.
  it("names none for a session that did not launch one", () => {
    expect(sourceHarness(record({ launchKind: "shell" }))).toBeNull();
    expect(
      sourceHarness(record({ launchKind: "shell", activeHarnessId: "claude-code" })),
    ).toBeNull();
    expect(sourceHarness(record())).toBeNull();
  });

  // A structured Session runs the Agent Runtime, not a CLI.
  it("names none for a chat row", () => {
    expect(sessionSourceHarness({ kind: "chat", record: chatRecord() })).toBeNull();
  });
});

/**
 * The pairing itself, which is the thing VC-402 actually rests on: a row draws
 * the glyph `sessionSourceHarness` picks and prints the words
 * `sessionSourceLabel` picks, so a reader is told one harness twice or two
 * harnesses once.
 *
 * Asserted as a RELATION over a matrix rather than as two lists of expected
 * strings, because the failure this guards is drift between the two functions,
 * and two independently-maintained expectation lists are exactly how that drift
 * gets written down as intended. The matrix is every axis either function reads
 * — `launchKind`, `harnessId`, `activeHarnessId`, `placement` — so a change to
 * the gate in one has nowhere to hide.
 */
describe("sessionSourceHarness agrees with sessionSourceLabel", () => {
  const LAUNCH_KINDS = ["agent", "shell", "unknown"] as const;
  const HARNESSES = ["claude-code", "codex", "my-custom-harness" as HarnessId] as const;
  const ACTIVE = [null, "cursor" as HarnessId] as const;
  const PLACEMENTS = ["tab", "split", "unknown"] as const;

  it("names the same harness in the glyph and in the words, or names none", () => {
    let namedAHarness = 0;
    for (const launchKind of LAUNCH_KINDS) {
      for (const harnessId of HARNESSES) {
        for (const activeHarnessId of ACTIVE) {
          for (const placement of PLACEMENTS) {
            const session = record({ launchKind, harnessId, activeHarnessId, placement });
            const harness = sessionSourceHarness(terminalRow(session));
            const label = sourceLabel(session);
            if (harness === null) {
              // No glyph to decode, so the words must not be naming a CLI
              // either: the only labels left are the two generic ones.
              expect(["Shell", "Shell · Split", "Terminal", "Terminal · Split"]).toContain(label);
              continue;
            }
            namedAHarness += 1;
            // The label is the harness's own words, plus only the placement
            // suffix the glyph never claimed to carry.
            expect(label).toBe(
              placement === "split" ? `${harnessLabel(harness)} · Split` : harnessLabel(harness),
            );
          }
        }
      }
    }
    // The relation above is vacuously true if nothing ever names a harness.
    expect(namedAHarness).toBe(HARNESSES.length * ACTIVE.length * PLACEMENTS.length);
  });
});
