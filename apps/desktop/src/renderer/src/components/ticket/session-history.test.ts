import { describe, expect, it } from "vite-plus/test";
import type { HarnessId, SessionRecord } from "@volli/shared";

import {
  canResumeSession,
  filterSessionHistory,
  groupSessionRows,
  latestResumableSession,
  sessionSourceLabel,
  type TicketSessionRow,
} from "./session-history";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    projectId: "p1",
    ticketId: "t1",
    harnessId: "claude-code",
    harnessSessionId: null,
    launchKind: "unknown",
    placement: "unknown",
    title: "Session 1",
    cwd: "/repo",
    createdAt: 1,
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function row(overrides: Partial<TicketSessionRow> = {}): TicketSessionRow {
  return {
    record: record(),
    title: "Session 1",
    isOpen: true,
    isRoot: true,
    tabId: "s1",
    status: "idle",
    ...overrides,
  };
}

describe("sessionSourceLabel", () => {
  it("uses the actual harness only for sessions that launched an agent", () => {
    expect(
      sessionSourceLabel(record({ launchKind: "agent", harnessId: "codex", placement: "tab" })),
    ).toBe("Codex");
  });

  it("describes bare terminal tabs and splits without pretending they are Claude Code", () => {
    expect(sessionSourceLabel(record({ launchKind: "shell", placement: "tab" }))).toBe("Shell");
    expect(sessionSourceLabel(record({ launchKind: "shell", placement: "split" }))).toBe(
      "Shell · Split",
    );
  });

  it("keeps legacy records honest when their launch kind was never recorded", () => {
    expect(sessionSourceLabel(record())).toBe("Terminal");
    expect(sessionSourceLabel(record({ placement: "split" }))).toBe("Terminal · Split");
  });
});

describe("groupSessionRows", () => {
  it("keeps only open non-exited panes in the current working set", () => {
    const working = row({ record: record({ id: "working" }), status: "working" });
    const parked = row({ record: record({ id: "parked" }), status: "parked" });
    const openExited = row({ record: record({ id: "open-exited" }), status: "exited" });
    const closed = row({
      record: record({ id: "closed", endedAt: 10 }),
      isOpen: false,
      status: "exited",
    });

    expect(groupSessionRows([working, parked, openExited, closed])).toEqual({
      current: [working, parked],
      history: [openExited, closed],
    });
  });
});

describe("canResumeSession", () => {
  it("is false for a still-live agent session — nothing has ended to resume into", () => {
    expect(canResumeSession(record({ launchKind: "agent", endedAt: null }))).toBe(false);
  });

  it("is false for a bare shell, whether live or ended", () => {
    expect(canResumeSession(record({ launchKind: "shell", endedAt: null }))).toBe(false);
    expect(canResumeSession(record({ launchKind: "shell", endedAt: 10 }))).toBe(false);
  });

  it("is false for an ended session whose harness has no known resume support", () => {
    expect(
      canResumeSession(
        record({ launchKind: "agent", endedAt: 10, harnessId: "my-custom-harness" as HarnessId }),
      ),
    ).toBe(false);
  });

  it("is true for an ended Claude Code agent session", () => {
    expect(
      canResumeSession(
        record({
          launchKind: "agent",
          endedAt: 10,
          harnessId: "claude-code",
          harnessSessionId: null,
        }),
      ),
    ).toBe(true);
  });
});

describe("latestResumableSession", () => {
  it("returns null when no record qualifies", () => {
    expect(
      latestResumableSession([
        record({ id: "live", launchKind: "agent", endedAt: null }),
        record({ id: "shell", launchKind: "shell", endedAt: 10 }),
      ]),
    ).toBeNull();
  });

  it("picks the newest resumable record regardless of input order", () => {
    const older = record({
      id: "older",
      launchKind: "agent",
      harnessId: "claude-code",
      createdAt: 10,
      endedAt: 20,
    });
    const newer = record({
      id: "newer",
      launchKind: "agent",
      harnessId: "codex",
      createdAt: 30,
      endedAt: 40,
    });
    const unresumableNewest = record({
      id: "unresumable",
      launchKind: "shell",
      createdAt: 99,
      endedAt: 100,
    });

    expect(latestResumableSession([unresumableNewest, older, newer])).toEqual(newer);
    expect(latestResumableSession([newer, unresumableNewest, older])).toEqual(newer);
  });
});

describe("filterSessionHistory", () => {
  const codex = row({
    record: record({ id: "codex", launchKind: "agent", harnessId: "codex" }),
    title: "Review auth flow",
  });
  const split = row({
    record: record({ id: "split", launchKind: "shell", placement: "split" }),
    title: "Server logs",
  });

  it("matches titles and source metadata case-insensitively", () => {
    expect(filterSessionHistory([codex, split], "AUTH")).toEqual([codex]);
    expect(filterSessionHistory([codex, split], "codex")).toEqual([codex]);
    expect(filterSessionHistory([codex, split], "split")).toEqual([split]);
  });

  it("returns every row for a blank query", () => {
    expect(filterSessionHistory([codex, split], "   ")).toEqual([codex, split]);
  });
});
