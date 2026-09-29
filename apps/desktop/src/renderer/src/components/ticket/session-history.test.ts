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
  orderSessionRailRowsByAttention,
  orderSessionRailRowsByHold,
  sessionRailOrderMembers,
  sessionRailRowActivityAt,
  sessionRailRowDotState,
  sessionRailRowId,
  sessionRailRowPhase,
  sessionRailRowSessionId,
  sessionRailRowStampAt,
  SESSION_ROSTER_FILTER_THRESHOLD,
  ticketOutputStamps,
  ticketSessionProvenance,
  ticketSessionUnreadIds,
  type SessionRailRow,
  type TicketSessionRow,
  type TicketSessionRowsInput,
  type TicketSessionStatus,
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
  // The rule itself (agent launch, actually ended, a harness that can resume)
  // is `canResumeTerminalRecord` in @volli/session-presentation and is tested
  // there. What this door owns is the row kind and the caller's catalogue.
  it("carries the portable rule's answer for a terminal row", () => {
    expect(resumable(record({ launchKind: "agent", endedAt: 10, harnessId: "claude-code" }))).toBe(
      true,
    );
    expect(resumable(record({ launchKind: "agent", endedAt: null }))).toBe(false);
    expect(resumable(record({ launchKind: "shell", endedAt: 10 }))).toBe(false);
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
  it("keeps attachment behavior under the non-visual isOpen name", () => {
    expect(
      buildTicketChatSessionRows([
        chatRecord({ sessionId: "attached", title: "Plan the migration", live: true }),
        chatRecord({ sessionId: "closed", title: "Draft the RFC", live: false }),
      ]),
    ).toEqual([
      {
        record: chatRecord({ sessionId: "attached", title: "Plan the migration", live: true }),
        title: "Plan the migration",
        isOpen: true,
        isLive: true,
      },
      {
        record: chatRecord({ sessionId: "closed", title: "Draft the RFC", live: false }),
        title: "Draft the RFC",
        isOpen: false,
        // Closed, and still LIVE: an attachment is not a lifecycle (VC-406).
        // This is the pair the roster splits on, and they disagree here on
        // purpose.
        isLive: true,
      },
    ]);
  });

  it("reads liveness off the record, never off the attachment (VC-406)", () => {
    const rows = buildTicketChatSessionRows([
      // Blocked on a person with nothing attached — the row that made the old
      // split visible, because it folded under "Earlier".
      chatRecord({ sessionId: "waiting", activity: "waiting", live: false }),
      // The last turn died and nobody decided that (VC-324): still a Session
      // to go back to.
      chatRecord({ sessionId: "interrupted", activity: "interrupted", live: false }),
      // Somebody ended it (VC-86): the one deliberate end a chat has.
      chatRecord({ sessionId: "stopped", activity: "stopped", live: true }),
    ]);

    expect(rows.map((chatRow) => [chatRow.record.sessionId, chatRow.isLive])).toEqual([
      ["waiting", true],
      ["interrupted", true],
      ["stopped", false],
    ]);
  });

  it("is empty for a ticket with no chat Sessions", () => {
    expect(buildTicketChatSessionRows([])).toEqual([]);
  });

  // A subagent inherits its parent's Ticket, so the ticket's own listing hands
  // one over; the roster is where it stops (VC-279). Both lifecycle halves,
  // because the rail splits these rows into Sessions and History and a child
  // must reach neither.
  it("drops a Subagent Session, live or finished", () => {
    expect(
      buildTicketChatSessionRows([
        chatRecord({ sessionId: "parent", title: "The chat that delegated" }),
        chatRecord({
          sessionId: "child-live",
          title: "Find the auth refresh",
          role: "subagent",
          parentSessionId: "parent",
          live: true,
        }),
        chatRecord({
          sessionId: "child-done",
          title: "Summarise the diff",
          role: "subagent",
          parentSessionId: "parent",
          live: false,
        }),
      ]).map((chatRow) => chatRow.record.sessionId),
    ).toEqual(["parent"]);
  });

  it("keeps a Session another Session STARTED — a peer is not a subagent", () => {
    expect(
      buildTicketChatSessionRows([
        chatRecord({ sessionId: "peer", parentSessionId: "parent" }),
      ]).map((chatRow) => chatRow.record.sessionId),
    ).toEqual(["peer"]);
  });
});

describe("filterChatSessionHistory", () => {
  const chatRows = buildTicketChatSessionRows([
    chatRecord({ sessionId: "attached", title: "Plan the migration", live: true }),
    chatRecord({ sessionId: "closed", title: "Review auth flow", live: false }),
  ]);

  it("matches titles and source metadata case-insensitively", () => {
    expect(filterChatSessionHistory(chatRows, "AUTH")).toEqual([chatRows[1]]);
    expect(filterChatSessionHistory(chatRows, "live")).toEqual([]);
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

describe("sessionRailRowActivityAt", () => {
  it("dates a live chat row from when the Session last said anything", () => {
    const rows = buildTicketChatSessionRows([chatRecord({ lastActivityAt: 4242 })]);

    expect(sessionRailRowActivityAt({ kind: "chat", row: rows[0]! }, {})).toBe(4242);
  });

  it("dates a live terminal row from the last line it printed", () => {
    // A live pane has no ENDING to date itself from, which is what separates
    // this reading from `sessionRailRowStampAt`.
    const entry: SessionRailRow = {
      kind: "terminal",
      row: row({ record: record({ id: "pane", createdAt: 10, endedAt: null }) }),
    };

    expect(sessionRailRowActivityAt(entry, { pane: 555 })).toBe(555);
  });

  it("falls back to creation for a pane that has printed nothing", () => {
    // The oldest instant that is certainly true of it — never a fabricated
    // "now", which would make a silent pane look busy.
    const entry: SessionRailRow = {
      kind: "terminal",
      row: row({ record: record({ id: "pane", createdAt: 10, endedAt: null }) }),
    };

    expect(sessionRailRowActivityAt(entry, {})).toBe(10);
  });
});

describe("sessionRailRowDotState", () => {
  it("spells a terminal's setup, and defers everything else to the shared map", () => {
    // `setup` is the worktree's ensure script — named by this surface rather
    // than reported by a PTY — so it is the one state spelled here.
    expect(sessionRailRowDotState({ kind: "terminal", row: row({ status: "setup" }) })).toBe(
      "setup",
    );
    expect(sessionRailRowDotState({ kind: "terminal", row: row({ status: "working" }) })).toBe(
      "working",
    );
  });

  it("reads a chat row's dot from its own activity", () => {
    const rows = buildTicketChatSessionRows([chatRecord({ activity: "waiting" })]);

    expect(sessionRailRowDotState({ kind: "chat", row: rows[0]! })).toBe("waiting");
  });
});

describe("orderSessionRailRowsByAttention", () => {
  const waiting: SessionRailRow = {
    kind: "chat",
    row: buildTicketChatSessionRows([
      chatRecord({ sessionId: "waiting", activity: "waiting" }),
    ])[0]!,
  };
  const idle: SessionRailRow = {
    kind: "chat",
    row: buildTicketChatSessionRows([chatRecord({ sessionId: "idle", activity: "idle" })])[0]!,
  };
  const working: SessionRailRow = {
    kind: "terminal",
    row: row({ record: record({ id: "working" }), status: "working" }),
  };

  it("leads with whatever is asking for a person", () => {
    expect(
      orderSessionRailRowsByAttention([idle, working, waiting]).map((entry) =>
        entry.kind === "chat" ? entry.row.record.sessionId : entry.row.record.id,
      ),
    ).toEqual(["waiting", "working", "idle"]);
  });

  it("keeps the order it was given inside one rank", () => {
    // `toSorted` is stable by specification, which is what makes "newest first
    // within a rank" a property of this function rather than of the engine.
    const second: SessionRailRow = {
      kind: "chat",
      row: buildTicketChatSessionRows([chatRecord({ sessionId: "idle-2", activity: "idle" })])[0]!,
    };

    expect(
      orderSessionRailRowsByAttention([idle, second]).map((entry) =>
        entry.kind === "chat" ? entry.row.record.sessionId : entry.row.record.id,
      ),
    ).toEqual(["idle", "idle-2"]);
  });

  it("does not mutate the list it was handed", () => {
    const rows = [idle, waiting];
    orderSessionRailRowsByAttention(rows);
    expect(rows[0]).toBe(idle);
  });
});

/* ------------------------------------------------ the rail's held order (VC-30) */

/** One chat rail row, by Session id and activity. */
function chatRail(sessionId: string, activity: ChatSessionRecord["activity"]): SessionRailRow {
  return {
    kind: "chat",
    row: buildTicketChatSessionRows([chatRecord({ sessionId, activity })])[0]!,
  };
}

/** One terminal rail row, by record id and displayed status. */
function terminalRail(id: string, status: TicketSessionStatus = "idle"): SessionRailRow {
  return { kind: "terminal", row: row({ record: record({ id }), status }) };
}

describe("sessionRailRowId", () => {
  // The peek and the held order address a rail row by the SAME id the sidebar's
  // listing mints, which is what lets one committed order serve both surfaces.
  it("uses the sidebar's own row vocabulary for both kinds", () => {
    expect(sessionRailRowId(chatRail("chat-1", "idle"))).toBe("chat:chat-1");
    expect(sessionRailRowId(terminalRail("terminal-0"))).toBe("session:terminal-0");
  });
});

describe("sessionRailRowSessionId", () => {
  it("is the bare Session id, whichever kind the row is", () => {
    expect(sessionRailRowSessionId(chatRail("chat-1", "idle"))).toBe("chat-1");
    expect(sessionRailRowSessionId(terminalRail("terminal-0"))).toBe("terminal-0");
  });
});

describe("sessionRailRowPhase", () => {
  it("calls a row that is asking for a person waiting", () => {
    expect(sessionRailRowPhase(chatRail("asking", "waiting"))).toBe("waiting");
  });

  it("calls both spellings of running work working", () => {
    // The rail's own `setup` word is work too — the order lifts on what the
    // row's mark is drawing, and the mark draws a spinner for both.
    expect(sessionRailRowPhase(terminalRail("running", "working"))).toBe("working");
    expect(sessionRailRowPhase(terminalRail("booting", "setup"))).toBe("working");
  });

  it("calls everything else resting", () => {
    expect(sessionRailRowPhase(chatRail("quiet", "idle"))).toBe("resting");
    expect(sessionRailRowPhase(chatRail("cut-off", "interrupted"))).toBe("resting");
  });
});

describe("sessionRailOrderMembers", () => {
  it("names the rail's membership in the held order's vocabulary, in place order", () => {
    expect(
      sessionRailOrderMembers([
        chatRail("asking", "waiting"),
        terminalRail("running", "working"),
        chatRail("quiet", "idle"),
      ]),
    ).toEqual([
      { id: "chat:asking", phase: "waiting" },
      { id: "session:running", phase: "working" },
      { id: "chat:quiet", phase: "resting" },
    ]);
  });
});

describe("orderSessionRailRowsByHold", () => {
  const asking = chatRail("asking", "waiting");
  const quiet = chatRail("quiet", "idle");
  const running = terminalRail("running", "working");

  it("draws the live rows in the order the rail's key committed to", () => {
    expect(
      orderSessionRailRowsByHold(
        [quiet, running, asking],
        ["chat:asking", "session:running", "chat:quiet"],
      ).map(sessionRailRowId),
    ).toEqual(["chat:asking", "session:running", "chat:quiet"]);
  });

  it("keeps a row the order has not heard of, at the end, in its own order", () => {
    // A Session that appeared since the last commit is still on screen — the
    // order is applied, never used as a filter (`applyHeldOrder`).
    expect(
      orderSessionRailRowsByHold([quiet, running, asking], ["chat:asking"]).map(sessionRailRowId),
    ).toEqual(["chat:asking", "chat:quiet", "session:running"]);
  });

  it("ignores an id the rail is not drawing and does not mutate its input", () => {
    // The hold is global and the order outlives a build, so it can still name a
    // row this ticket has retired.
    const rows = [quiet, asking];
    expect(
      orderSessionRailRowsByHold(rows, ["chat:gone", "chat:asking"]).map(sessionRailRowId),
    ).toEqual(["chat:asking", "chat:quiet"]);
    expect(rows[0]).toBe(quiet);
  });
});

describe("ticketSessionUnreadIds", () => {
  it("collects the unread Sessions by the id the rail's rows answer to", () => {
    const unread = ticketSessionUnreadIds([
      { ...terminalRow(record({ id: "s1" })), read: { unreadSince: 7 } },
      {
        kind: "chat",
        record: chatRecord({ sessionId: "c1" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
        read: { unreadSince: 9 },
      },
    ]);

    expect([...unread]).toEqual(["s1", "c1"]);
  });

  it("leaves out a row with no receipt and one that has been read", () => {
    // Sparse is the resting case (`isSessionUnread`): a builder with no receipt
    // reader marks nothing rather than guessing.
    const unread = ticketSessionUnreadIds([
      terminalRow(record({ id: "s1" })),
      {
        kind: "chat",
        record: chatRecord({ sessionId: "c1" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
        read: { unreadSince: null },
      },
    ]);

    expect(unread.size).toBe(0);
  });
});

describe("SESSION_ROSTER_FILTER_THRESHOLD", () => {
  it("is the reviewed four, for both scopes", () => {
    expect(SESSION_ROSTER_FILTER_THRESHOLD).toBe(4);
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

  it("waits on the stamp the caller is actually printing", () => {
    // A live row prints its ACTIVITY age, not an ending it does not have, so
    // the timer has to be armed on that reading — two readings is how a column
    // wakes on a boundary belonging to a stamp it is not showing (VC-406).
    const live: SessionRailRow = {
      kind: "terminal",
      row: row({ record: record({ id: "live", createdAt: 1, endedAt: null }) }),
    };

    expect(
      nextSessionRailAgeChangeAt([live], now, (entry) =>
        sessionRailRowActivityAt(entry, { live: now - 30_000 }),
      ),
    ).toBe(now - 30_000 + 45_000);
    // …and the default reading, on the same row, is the record's creation.
    expect(nextSessionRailAgeChangeAt([live], now)).not.toBe(now - 30_000 + 45_000);
  });
});
