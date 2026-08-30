import { describe, expect, it } from "vite-plus/test";
import {
  createSessionHarnessState,
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  getHarnessAdapter,
  type ChatSessionRecord,
  type HarnessAdapter,
  type HarnessId,
  type SessionListingRow,
  type SessionRecord,
} from "@volli/shared";

import {
  buildTicketChatSessionRows,
  buildTicketSessionRows,
  canResumeSession,
  filterChatSessionHistory,
  filterSessionHistory,
  groupSessionRows,
  latestResumableSession,
  mergeSessionRailRows,
  nextSessionRailAgeChangeAt,
  nextTicketSessionStatusChangeAt,
  sessionRailRowStampAt,
  sessionSourceLabel,
  ticketOutputStamps,
  ticketSessionProvenance,
  type SessionRailRow,
  type TicketSessionRow,
  type TicketSessionRowsInput,
} from "./session-history";
import { WORKING_WINDOW_MS, ticketScope, type SessionTab } from "../../stores/sessions";

function terminalRow(session: SessionRecord): SessionListingRow {
  return {
    kind: "terminal",
    record: session,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  };
}

/**
 * The built-ins, which is what these cases are about. The lookup is a parameter
 * so a BYO harness can be handed in deliberately — see the registered-manifest
 * case below, which is the regression this parameter exists to prevent.
 */
const resumable = (session: SessionRecord) =>
  canResumeSession(terminalRow(session), getHarnessAdapter);
const latestResumable = (records: readonly SessionRecord[]) =>
  latestResumableSession(records.map(terminalRow), getHarnessAdapter);
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
    lastActivityAt: 1,
    bornTicketless: false,
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
              adapter: {
                injection: { kind: "claude-settings-json", flag: "--settings" },
                startupEvent: "session.started",
                events: [
                  { event: "session.started", native: "SessionStart", delivery: "async" },
                  { event: "input.needed", native: "Notification", delivery: "async" },
                ],
              },
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

  // A chat row has no PTY to describe, so it names its own thing — whether the
  // structured attachment is still open — instead of borrowing terminal words.
  it("names a chat row by its liveness, not a harness", () => {
    expect(sessionSourceLabel({ kind: "chat", record: chatRecord({ live: true }) })).toBe(
      "Chat · Live",
    );
    expect(sessionSourceLabel({ kind: "chat", record: chatRecord({ live: false }) })).toBe("Chat");
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
    expect(resumable(record({ launchKind: "agent", endedAt: null }))).toBe(false);
  });

  it("is false for a bare shell, whether live or ended", () => {
    expect(resumable(record({ launchKind: "shell", endedAt: null }))).toBe(false);
    expect(resumable(record({ launchKind: "shell", endedAt: 10 }))).toBe(false);
  });

  it("is false for an ended session whose harness has no known resume support", () => {
    expect(
      resumable(
        record({ launchKind: "agent", endedAt: 10, harnessId: "my-custom-harness" as HarnessId }),
      ),
    ).toBe(false);
  });

  it("is true for an ended Claude Code agent session", () => {
    expect(
      resumable(
        record({
          launchKind: "agent",
          endedAt: 10,
          harnessId: "claude-code",
          harnessSessionId: null,
        }),
      ),
    ).toBe(true);
  });

  // The whole reason the lookup is a parameter. A registered manifest that
  // declares a resume line can genuinely be resumed, and a built-ins-only
  // lookup would deny it the affordance while claiming the harness has none —
  // so the same record answers differently depending on what the caller knows,
  // and the caller has to be the one that knows.
  it("resumes a BYO harness when the lookup can describe it, and not when it cannot", () => {
    const byo = "my-custom-harness" as HarnessId;
    const ended = record({ launchKind: "agent", endedAt: 10, harnessId: byo });
    const knows = (id: HarnessId): HarnessAdapter | undefined =>
      id === byo
        ? {
            ...getHarnessAdapter("claude-code")!,
            id: byo,
            resume: { byId: null, latest: ["--continue"], userResumeTokens: [] },
          }
        : getHarnessAdapter(id);

    expect(canResumeSession(terminalRow(ended), knows)).toBe(true);
    expect(resumable(ended)).toBe(false);
  });

  // Main builds the resume line off the running harness, so the affordance has
  // to be decided about that one or the rail offers a Resume that cannot happen
  // — and hides one that can.
  it("judges resumability by the harness that was running when it ended", () => {
    expect(
      resumable(
        record({
          launchKind: "agent",
          endedAt: 10,
          harnessId: "my-custom-harness" as HarnessId,
          activeHarnessId: "claude-code",
        }),
      ),
    ).toBe(true);
    expect(
      resumable(
        record({
          launchKind: "agent",
          endedAt: 10,
          harnessId: "claude-code",
          activeHarnessId: "my-custom-harness" as HarnessId,
        }),
      ),
    ).toBe(false);
  });

  // There is no terminal behind a chat row to resume as — deep chat
  // activation is a different, future affordance.
  it("is false for a chat row, live or ended", () => {
    expect(
      canResumeSession({ kind: "chat", record: chatRecord({ live: true }) }, getHarnessAdapter),
    ).toBe(false);
    expect(
      canResumeSession({ kind: "chat", record: chatRecord({ live: false }) }, getHarnessAdapter),
    ).toBe(false);
  });
});

describe("latestResumableSession", () => {
  it("returns null when no record qualifies", () => {
    expect(
      latestResumable([
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

    expect(latestResumable([unresumableNewest, older, newer])).toEqual(newer);
    expect(latestResumable([newer, unresumableNewest, older])).toEqual(newer);
  });

  it("skips chat rows even when they would otherwise be newest", () => {
    const older = terminalRow(
      record({
        id: "older",
        launchKind: "agent",
        harnessId: "claude-code",
        createdAt: 10,
        endedAt: 20,
      }),
    );
    const chat: SessionListingRow = {
      kind: "chat",
      record: chatRecord({ createdAt: 999 }),
      usage: EMPTY_SESSION_USAGE_SUMMARY,
      provenance: PERSON_STARTED,
    };

    expect(latestResumableSession([chat, older], getHarnessAdapter)).toEqual(older.record);
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

describe("buildTicketChatSessionRows", () => {
  it("names each row by its title, open only while its attachment is live", () => {
    expect(
      buildTicketChatSessionRows([
        chatRecord({ sessionId: "live", title: "Plan the migration", live: true }),
        chatRecord({ sessionId: "ended", title: "Draft the RFC", live: false }),
      ]),
    ).toEqual([
      {
        record: chatRecord({ sessionId: "live", title: "Plan the migration", live: true }),
        title: "Plan the migration",
        isOpen: true,
      },
      {
        record: chatRecord({ sessionId: "ended", title: "Draft the RFC", live: false }),
        title: "Draft the RFC",
        isOpen: false,
      },
    ]);
  });

  it("is empty for a ticket with no chat Sessions", () => {
    expect(buildTicketChatSessionRows([])).toEqual([]);
  });
});

describe("filterChatSessionHistory", () => {
  // [0] is live, [1] is ended — the source line each matches on differs.
  const chatRows = buildTicketChatSessionRows([
    chatRecord({ sessionId: "live", title: "Plan the migration", live: true }),
    chatRecord({ sessionId: "ended", title: "Review auth flow", live: false }),
  ]);

  it("matches titles and source metadata case-insensitively", () => {
    expect(filterChatSessionHistory(chatRows, "AUTH")).toEqual([chatRows[1]]);
    // "Chat · Live" is the live row's source line, and nothing else's.
    expect(filterChatSessionHistory(chatRows, "live")).toEqual([chatRows[0]]);
    expect(filterChatSessionHistory(chatRows, "chat")).toEqual(chatRows);
  });

  it("returns every row for a blank query", () => {
    expect(filterChatSessionHistory(chatRows, "   ")).toEqual(chatRows);
  });
});

describe("mergeSessionRailRows", () => {
  const terminalOld = row({ record: record({ id: "terminal-old", createdAt: 10 }) });
  const terminalNew = row({ record: record({ id: "terminal-new", createdAt: 30 }) });
  const chatRows = buildTicketChatSessionRows([chatRecord({ sessionId: "chat", createdAt: 20 })]);

  // What this replaced: concatenating the two kinds sank every chat Session
  // below every terminal one, however recent it was.
  it("interleaves both kinds newest first rather than grouping by kind", () => {
    expect(
      mergeSessionRailRows([terminalNew, terminalOld], chatRows).map((entry) =>
        entry.kind === "terminal" ? entry.row.record.id : entry.row.record.sessionId,
      ),
    ).toEqual(["terminal-new", "chat", "terminal-old"]);
  });

  it("keeps a list of one kind exactly as it was", () => {
    expect(mergeSessionRailRows([terminalNew, terminalOld], [])).toEqual([
      { kind: "terminal", row: terminalNew },
      { kind: "terminal", row: terminalOld },
    ]);
    expect(mergeSessionRailRows([], chatRows)).toEqual([{ kind: "chat", row: chatRows[0] }]);
  });
});

describe("ticketOutputStamps", () => {
  it("keeps only the stamps this ticket's terminal records can be read by", () => {
    expect(
      ticketOutputStamps({
        lastOutputAt: { s1: 10, s3: 30, "another-ticket": 40 },
        rows: [
          terminalRow(record({ id: "s1" })),
          {
            kind: "chat",
            record: chatRecord({ sessionId: "s2" }),
            usage: EMPTY_SESSION_USAGE_SUMMARY,
            provenance: PERSON_STARTED,
          },
          terminalRow(record({ id: "s3" })),
        ],
      }),
    ).toEqual({ s1: 10, s3: 30 });
  });

  it("omits a record with no stamp rather than mapping it to undefined", () => {
    // The point of the projection is that an unchanged key set shallow-compares
    // equal; a present-but-undefined key is a key, and it would still compare
    // equal — but it would also make `lastOutputAt[id] ?? null` and
    // `id in lastOutputAt` disagree for a pane that has simply never printed.
    const stamps = ticketOutputStamps({
      lastOutputAt: {},
      rows: [terminalRow(record({ id: "quiet" }))],
    });

    expect(stamps).toEqual({});
    expect(Object.keys(stamps)).toEqual([]);
  });
});

describe("ticketSessionProvenance", () => {
  const run = { kind: "automation", automationName: "Nightly sweep" } as const;
  const child = {
    kind: "session",
    parentSessionId: "session-parent",
    parentTitle: "Orchestrator",
  } as const;

  it("keys both kinds by the id the rail's rows answer to", () => {
    expect(
      ticketSessionProvenance([
        { ...terminalRow(record({ id: "s1" })), provenance: run },
        {
          kind: "chat",
          record: chatRecord({ sessionId: "c1" }),
          usage: EMPTY_SESSION_USAGE_SUMMARY,
          provenance: child,
        },
      ]),
    ).toEqual({ s1: run, c1: child });
  });

  // The resting case is stored as its own absence, which is what makes a ticket
  // nobody automated cost this read nothing at all (VC-131).
  it("gives a Session a person started no entry", () => {
    const provenance = ticketSessionProvenance([
      terminalRow(record({ id: "s1" })),
      {
        kind: "chat",
        record: chatRecord({ sessionId: "c1" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
    ]);

    expect(provenance).toEqual({});
    expect(Object.keys(provenance)).toEqual([]);
  });
});

describe("nextTicketSessionStatusChangeAt", () => {
  const printedAt = 900_000;

  it("waits for the instant a working row goes quiet", () => {
    expect(
      nextTicketSessionStatusChangeAt(
        rowsInput({ lastOutputAt: { s1: printedAt }, now: printedAt + 1 }),
      ),
    ).toBe(printedAt + WORKING_WINDOW_MS + 1);
  });

  it("has no boundary once the window has already closed", () => {
    // The row reads `idle` and stays `idle` until new output moves the stamp,
    // which is an input change and not a clock one.
    expect(nextTicketSessionStatusChangeAt(rowsInput({ lastOutputAt: { s1: printedAt } }))).toBe(
      null,
    );
  });

  it("has no boundary for a pane that has never printed", () => {
    expect(nextTicketSessionStatusChangeAt(rowsInput())).toBe(null);
  });

  it("has no boundary for a record with no live pane", () => {
    expect(
      nextTicketSessionStatusChangeAt(
        rowsInput({ tabs: [], lastOutputAt: { s1: printedAt }, now: printedAt + 1 }),
      ),
    ).toBe(null);
  });

  it("has no boundary for a pane that has exited", () => {
    // `exited` outranks every other rung, so that row's word is permanent.
    expect(
      nextTicketSessionStatusChangeAt(
        rowsInput({
          tabs: [tab({ sessionId: "s1", layout: { kind: "pane", sessionId: "s1", exitCode: 0 } })],
          lastOutputAt: { s1: printedAt },
          now: printedAt + 1,
        }),
      ),
    ).toBe(null);
  });

  it("takes the soonest window across every live pane", () => {
    const input = rowsInput({
      records: [record({ id: "mid" }), record({ id: "soonest" }), record({ id: "latest" })],
      tabs: [
        tab({ sessionId: "mid" }),
        tab({ sessionId: "soonest" }),
        tab({ sessionId: "latest" }),
      ],
      lastOutputAt: { mid: printedAt, soonest: printedAt - 500, latest: printedAt + 500 },
      now: printedAt + 1,
    });

    expect(nextTicketSessionStatusChangeAt(input)).toBe(printedAt - 500 + WORKING_WINDOW_MS + 1);
  });
});

describe("sessionRailRowStampAt", () => {
  it("dates a chat row by when it last said anything", () => {
    const rows = buildTicketChatSessionRows([chatRecord({ lastActivityAt: 4242 })]);

    expect(sessionRailRowStampAt({ kind: "chat", row: rows[0] })).toBe(4242);
  });

  it("dates a terminal row by when it ended", () => {
    expect(
      sessionRailRowStampAt({
        kind: "terminal",
        row: row({ record: record({ createdAt: 10, endedAt: 900 }) }),
      }),
    ).toBe(900);
  });

  it("falls back to creation for a record that never got an end stamp", () => {
    expect(
      sessionRailRowStampAt({
        kind: "terminal",
        row: row({ record: record({ createdAt: 10, endedAt: null }) }),
      }),
    ).toBe(10);
  });
});

describe("nextSessionRailAgeChangeAt", () => {
  const now = 1_000_000;
  // "just now" for another 15s; the minute bucket it sits in closes later.
  const fresh: SessionRailRow = {
    kind: "terminal",
    row: row({ record: record({ id: "fresh", endedAt: now - 30_000 }) }),
  };
  const older: SessionRailRow = {
    kind: "terminal",
    row: row({ record: record({ id: "older", endedAt: now - 90_000 }) }),
  };

  it("is null when nothing is on screen to age", () => {
    expect(nextSessionRailAgeChangeAt([], now)).toBe(null);
  });

  it("takes the soonest instant any visible stamp reads differently, in either order", () => {
    expect(nextSessionRailAgeChangeAt([fresh, older], now)).toBe(now - 30_000 + 45_000);
    expect(nextSessionRailAgeChangeAt([older, fresh], now)).toBe(now - 30_000 + 45_000);
  });
});
