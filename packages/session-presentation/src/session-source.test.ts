import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  type ChatSessionRecord,
  type HarnessId,
  type SessionListingRow,
  type SessionRecord,
} from "@volli/shared";

import { sessionSourceHarness, sessionSourceLabel, sessionSourceProvider } from "./session-source";

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
    providerId: null,
    live: true,
    activity: "idle",
    waitingOn: null,
    outcome: null,
    lastActivityAt: 1,
    bornTicketless: false,
    role: "ticket",
    parentSessionId: null,
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
 * VC-402: who a structured Session is billed through, as the other half of
 * {@link sessionSourceHarness}.
 *
 * The pair is what is under test, not either function alone: a surface drawing
 * a mark asks both, and the answer has to be exactly one of them for any row.
 */
describe("sessionSourceProvider", () => {
  it("names the provider a chat's accepted model runs on", () => {
    expect(
      sessionSourceProvider({ kind: "chat", record: chatRecord({ providerId: "anthropic" }) }),
    ).toBe("anthropic");
  });

  it("names nothing for a chat that has accepted no model", () => {
    // Never the default it WOULD be given: a Session that has chosen nothing
    // has nothing to say, and a guessed provider is the row asserting an
    // account nobody picked.
    expect(
      sessionSourceProvider({ kind: "chat", record: chatRecord({ providerId: null }) }),
    ).toBeNull();
  });

  it("names nothing for a terminal, which answers the harness question instead", () => {
    const companion = terminalRow(record({ launchKind: "agent", harnessId: "codex" }));

    expect(sessionSourceProvider(companion)).toBeNull();
    expect(sessionSourceHarness(companion)).toBe("codex");
    // And the mirror: a chat answers the provider question and not the harness
    // one. Exactly one of the two, for every row.
    expect(
      sessionSourceHarness({ kind: "chat", record: chatRecord({ providerId: "zai" }) }),
    ).toBeNull();
  });
});
