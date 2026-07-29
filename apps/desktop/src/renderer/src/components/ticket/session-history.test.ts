import { describe, expect, it } from "vite-plus/test";
import { createSessionHarnessState, type HarnessId, type SessionRecord } from "@volli/shared";

import {
  buildTicketSessionRows,
  canResumeSession,
  filterSessionHistory,
  groupSessionRows,
  latestResumableSession,
  sessionSourceLabel,
  type TicketSessionRow,
  type TicketSessionRowsInput,
} from "./session-history";
import { ticketScope, type SessionTab } from "../../stores/sessions";

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

function tab(overrides: Partial<SessionTab> & { sessionId: string }): SessionTab {
  return {
    sessionId: overrides.sessionId,
    title: overrides.title ?? "Session 1",
    scope: overrides.scope ?? ticketScope("p1", "t1"),
    layout: overrides.layout ?? { kind: "pane", sessionId: overrides.sessionId, exitCode: null },
    activePaneId: overrides.activePaneId ?? overrides.sessionId,
  };
}

function rowsInput(overrides: Partial<TicketSessionRowsInput> = {}): TicketSessionRowsInput {
  return {
    records: [record()],
    tabs: [tab({ sessionId: "s1" })],
    lastOutputAt: {},
    parkState: {},
    harness: {},
    settingUp: false,
    now: 1_000_000,
    ...overrides,
  };
}

describe("buildTicketSessionRows", () => {
  it("reads a live, quiet pane as an open idle row titled by its live tab", () => {
    expect(buildTicketSessionRows(rowsInput())).toEqual([
      {
        record: record(),
        title: "Session 1",
        isOpen: true,
        isRoot: true,
        tabId: "s1",
        status: "idle",
      },
    ]);
  });

  it("names the worktree setup script a live pane is waiting on instead of its raw activity", () => {
    const rows = buildTicketSessionRows(
      rowsInput({ settingUp: true, lastOutputAt: { s1: 999_999 } }),
    );
    expect(rows[0]?.status).toBe("setup");
  });

  it("keeps an exited pane's real status during setup rather than claiming setup is still running", () => {
    const rows = buildTicketSessionRows(
      rowsInput({
        settingUp: true,
        tabs: [tab({ sessionId: "s1", layout: { kind: "pane", sessionId: "s1", exitCode: 1 } })],
      }),
    );
    expect(rows[0]?.status).toBe("exited");
  });

  it("reads a harness-declared block as waiting, which no amount of PTY silence can say", () => {
    const rows = buildTicketSessionRows(
      rowsInput({
        harness: {
          s1: {
            ...createSessionHarnessState({
              harnessId: "claude-code",
              expectedTier: "hooked",
              declaredEvents: ["input.needed"],
              startedAt: 0,
            }),
            delivered: true,
            declared: "waiting",
          },
        },
      }),
    );
    expect(rows[0]?.status).toBe("waiting");
  });

  it("reads a record with no open pane as an exited row under its own durable title", () => {
    expect(
      buildTicketSessionRows(
        rowsInput({ records: [record({ title: "Old run", endedAt: 500 })], tabs: [] }),
      ),
    ).toEqual([
      {
        record: record({ title: "Old run", endedAt: 500 }),
        title: "Old run",
        isOpen: false,
        isRoot: false,
        tabId: undefined,
        status: "exited",
      },
    ]);
  });

  it("keeps a live split pane live, under its own title but its tab's id", () => {
    const rows = buildTicketSessionRows(
      rowsInput({
        records: [record({ id: "s1" }), record({ id: "s2", title: "Server logs" })],
        tabs: [
          tab({
            sessionId: "s1",
            title: "Renamed tab",
            layout: {
              kind: "split",
              id: "s2",
              direction: "vertical",
              ratio: 0.5,
              first: { kind: "pane", sessionId: "s1", exitCode: null },
              second: { kind: "pane", sessionId: "s2", exitCode: null },
            },
          }),
        ],
        lastOutputAt: { s2: 999_999 },
      }),
    );

    expect(rows).toEqual([
      {
        record: record({ id: "s1" }),
        title: "Renamed tab",
        isOpen: true,
        isRoot: true,
        tabId: "s1",
        status: "idle",
      },
      {
        record: record({ id: "s2", title: "Server logs" }),
        title: "Server logs",
        isOpen: true,
        isRoot: false,
        tabId: "s1",
        status: "working",
      },
    ]);
  });

  it("reads a parked pane as parked", () => {
    const rows = buildTicketSessionRows(
      rowsInput({ parkState: { s1: { parked: true, keepAwake: false } } }),
    );
    expect(rows[0]?.status).toBe("parked");
  });
});

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
