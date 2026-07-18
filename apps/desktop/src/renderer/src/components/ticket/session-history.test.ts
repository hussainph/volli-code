import { describe, expect, it } from "vite-plus/test";
import type { SessionRecord } from "@volli/shared";

import {
  filterSessionHistory,
  groupSessionRows,
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
