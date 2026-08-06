import {
  createSessionHarnessState,
  HARNESS_EVENT_GRACE_MS,
  receiveHarnessEvent,
  type ChatSessionRecord,
  type CreateSessionHarnessStateInput,
  type HarnessEvent,
  type HarnessEventNotice,
  type SessionHarnessState,
  type SessionRecord,
  type Ticket,
  type LatestSessionSignal,
} from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  subscribeHarnessEvents,
  ticketScope,
  useSessionsStore,
  type SessionLaunch,
} from "../../stores/sessions";

import {
  ACTIVE_QUIET_WINDOW_MS,
  buildActiveSessionListing,
  DONE_LINGER_MS,
  isCleanupExempt,
  isConcludedBusiness,
  PREVIOUS_MAX_AGE_MS,
} from "./active-session-listing";

/** A bare shell launch: no harness command line was written, so no expectation. */
const shellLaunch = (title: string): SessionLaunch => ({
  title,
  harnessId: "claude-code",
  launchKind: "shell",
  createdAt: 0,
});

function ticket(overrides: Partial<Ticket> & { id: string; status: Ticket["status"] }): Ticket {
  return {
    id: overrides.id,
    projectId: "p1",
    ticketNumber: overrides.ticketNumber ?? 1,
    title: overrides.title ?? "Ship the feature",
    body: "",
    status: overrides.status,
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 1,
  };
}

function record(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    id: overrides.id,
    projectId: overrides.projectId ?? "p1",
    ticketId: overrides.ticketId ?? null,
    harnessId: overrides.harnessId ?? "claude-code",
    activeHarnessId: overrides.activeHarnessId ?? null,
    harnessSessionId: overrides.harnessSessionId ?? null,
    launchKind: overrides.launchKind ?? "agent",
    placement: overrides.placement ?? "tab",
    title: overrides.title ?? "Session",
    cwd: overrides.cwd ?? "/tmp",
    createdAt: overrides.createdAt ?? 1,
    endedAt: overrides.endedAt ?? null,
    exitCode: overrides.exitCode ?? null,
    lastActivityAt: overrides.lastActivityAt ?? 1,
    bornTicketless: overrides.bornTicketless ?? (overrides.ticketId ?? null) === null,
  };
}

function chatSession(
  overrides: Partial<ChatSessionRecord> & { ticketId: string | null },
): ChatSessionRecord {
  return {
    sessionId: overrides.sessionId ?? "chat-1",
    title: overrides.title ?? "Chat session",
    projectId: overrides.projectId ?? "p1",
    ticketId: overrides.ticketId,
    createdAt: overrides.createdAt ?? 1,
    adapterId: overrides.adapterId ?? "opencode",
    live: overrides.live ?? true,
    activity: overrides.activity ?? "idle",
    waitingOn: overrides.waitingOn ?? null,
    lastActivityAt: overrides.lastActivityAt ?? 1,
    bornTicketless: overrides.bornTicketless ?? overrides.ticketId === null,
  };
}

/** A single-pane ticket tab, the common container shape in these fixtures. */
function paneTab(sessionId: string, title: string, exitCode: number | null = null) {
  return {
    sessionId,
    title,
    scope: { kind: "ticket", projectId: "p1", ticketId: "t1" } as const,
    layout: { kind: "pane", sessionId, exitCode } as const,
    activePaneId: sessionId,
  };
}

function container(activeSessionId: string | null, tabs: ReturnType<typeof paneTab>[]) {
  return { activeSessionId, tabs };
}

/** A single-pane SCRATCH tab: no ticket, filed in the store under the project id. */
function scratchTab(sessionId: string, title: string, exitCode: number | null = null) {
  return {
    sessionId,
    title,
    scope: { kind: "scratch", projectId: "p1" } as const,
    layout: { kind: "pane", sessionId, exitCode } as const,
    activePaneId: sessionId,
  };
}

/** The store's container for those tabs — the shared `container()` is typed to ticket tabs. */
function scratchOf(tabs: ReturnType<typeof scratchTab>[]) {
  return { activeSessionId: tabs[0]?.sessionId ?? null, tabs };
}

function signal(
  ticketId: string,
  sessionId: string,
  outcome: "done" | "blocked",
  reason: string | null,
  createdAt: number,
): LatestSessionSignal {
  return { ticketId, sessionId, signal: outcome, reason, createdAt };
}

const titles = (rows: readonly { title: string }[]): string[] => rows.map((row) => row.title);

describe("buildActiveSessionListing — the Active band", () => {
  it("lists every live tab on a Doing ticket as its own active destination", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {
        t1: {
          activeSessionId: "s2",
          tabs: [
            {
              sessionId: "s1",
              title: "Implement UI",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "s1", exitCode: null },
              activePaneId: "s1",
            },
            {
              sessionId: "s2",
              title: "Run checks",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "s2", exitCode: null },
              activePaneId: "s2",
            },
          ],
        },
      },
      signalsByTicket: {},
      records: [],
      lastOutputAt: { s1: 99_000 },
      parkState: {},
      harness: {},
      now: 100_000,
    });

    expect(result.previous).toEqual([]);
    expect(result.active.map((row) => ({ title: row.title, target: row.target }))).toEqual([
      { title: "Implement UI", target: { tabId: "s1", paneId: "s1" } },
      { title: "Run checks", target: { tabId: "s2", paneId: "s2" } },
    ]);
  });

  it("sorts Active by group: waiting, then working, then recently quiet, then the board guarantee", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [
        ticket({ id: "t-wait", status: "doing", ticketNumber: 1 }),
        ticket({ id: "t-work", status: "doing", ticketNumber: 2 }),
        ticket({ id: "t-quiet", status: "doing", ticketNumber: 3 }),
        ticket({ id: "t-board", status: "doing", ticketNumber: 4, title: "Nothing live" }),
      ],
      containers: {
        "t-wait": container("s-wait", [paneTab("s-wait", "Waiting on a human")]),
        "t-work": container("s-work", [paneTab("s-work", "Working now")]),
        "t-quiet": container("s-quiet", [paneTab("s-quiet", "Quiet a while")]),
      },
      signalsByTicket: {},
      records: [],
      // The waiting row's stamp is the OLDEST of the three, so only the group
      // ordering can put it first.
      lastOutputAt: { "s-wait": now - 600_000, "s-work": now - 1_000, "s-quiet": now - 60_000 },
      parkState: {},
      harness: { "s-wait": reporting("input.needed", now - 700_000) },
      now,
    });

    expect(titles(result.active)).toEqual([
      "Waiting on a human",
      "Working now",
      "Quiet a while",
      "Nothing live",
    ]);
  });

  it("orders the working group by recency", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [
        ticket({ id: "t1", status: "doing", ticketNumber: 1 }),
        ticket({ id: "t2", status: "doing", ticketNumber: 2 }),
      ],
      containers: {
        t1: container("s1", [paneTab("s1", "Older output")]),
        t2: container("s2", [paneTab("s2", "Newer output")]),
      },
      signalsByTicket: {},
      records: [],
      lastOutputAt: { s1: now - 9_000, s2: now - 1_000 },
      parkState: {},
      harness: {},
      now,
    });

    expect(titles(result.active)).toEqual(["Newer output", "Older output"]);
  });

  it("orders live work within the quiet group by recency and files a fully exited tab under Previous", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {
        t1: {
          activeSessionId: "working",
          tabs: [
            {
              sessionId: "parked",
              title: "Parked",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "parked", exitCode: null },
              activePaneId: "parked",
            },
            {
              sessionId: "exited",
              title: "Exited",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "exited", exitCode: 0 },
              activePaneId: "exited",
            },
            {
              sessionId: "idle",
              title: "Idle",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "idle", exitCode: null },
              activePaneId: "idle",
            },
            {
              sessionId: "working",
              title: "Working",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "working", exitCode: null },
              activePaneId: "working",
            },
          ],
        },
      },
      signalsByTicket: {},
      records: [],
      lastOutputAt: { working: 999_000, idle: 900_000, parked: 800_000 },
      parkState: { parked: { parked: true, keepAwake: false } },
      harness: {},
      now,
    });

    // Working leads on its group; idle and parked are both merely quiet now, so
    // what separates them is when they last said anything, not which lifecycle
    // word the PTY heuristic reached for.
    expect(result.active.map((row) => `${row.title}:${row.activity}`)).toEqual([
      "Working:working",
      "Idle:idle",
      "Parked:parked",
    ]);
    // The ticket has live work, so the exited tab is not its board row — it is
    // an ended Session, and ended Sessions live in Previous.
    expect(result.previous).toMatchObject([
      { title: "Exited", kind: "terminal", target: { tabId: "exited", paneId: "exited" } },
    ]);
  });

  it("keeps a Session in Active until the quiet window elapses, and drops it the instant it does", () => {
    const quietAt = 5_000_000;
    const listing = (now: number) =>
      buildActiveSessionListing({
        tickets: [ticket({ id: "t1", status: "todo" })],
        containers: { t1: container("s1", [paneTab("s1", "Gone quiet")]) },
        signalsByTicket: {},
        records: [],
        lastOutputAt: { s1: quietAt },
        parkState: {},
        harness: {},
        now,
      });

    expect(titles(listing(quietAt + ACTIVE_QUIET_WINDOW_MS - 1).active)).toEqual(["Gone quiet"]);
    expect(listing(quietAt + ACTIVE_QUIET_WINDOW_MS).active).toEqual([]);
    expect(titles(listing(quietAt + ACTIVE_QUIET_WINDOW_MS).previous)).toEqual(["Gone quiet"]);
    expect(listing(quietAt + ACTIVE_QUIET_WINDOW_MS + 1).active).toEqual([]);
  });

  it("keeps a Session waiting on a human in Active however long it has been quiet", () => {
    // The window is asked LAST, after the attention: an agent blocked on a
    // permission prompt overnight is exactly what the band exists to surface,
    // and ageing it out would hide the only row anyone had to act on.
    const now = 10_000_000;
    const quietAt = now - 4 * ACTIVE_QUIET_WINDOW_MS;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "needs_review" })],
      containers: { t1: container("s1", [paneTab("s1", "Blocked run")]) },
      signalsByTicket: { t1: signal("t1", "s1", "blocked", "Approve access", quietAt) },
      records: [],
      lastOutputAt: { s1: quietAt },
      parkState: {},
      harness: {},
      now,
    });

    expect(result.active).toMatchObject([
      { title: "Blocked run", attention: { signal: "blocked", reason: "Approve access" } },
    ]);
    expect(result.previous).toEqual([]);
  });

  it("keeps a live terminal nothing can date in Active rather than letting it vanish", () => {
    // The post-relaunch shape: `lastOutputAt` lives in the renderer store and
    // died with the last window, so a genuinely busy terminal has no stamp.
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "todo" })],
      containers: { t1: container("s1", [paneTab("s1", "No stamp anywhere")]) },
      signalsByTicket: {},
      records: [record({ id: "s1", ticketId: "t1", endedAt: null })],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 10_000_000,
    });

    expect(titles(result.active)).toEqual(["No stamp anywhere"]);
    expect(result.previous).toEqual([]);
  });

  it("routes the latest Needs Review signal to its exact session while keeping sibling tabs in Active", () => {
    const latest = signal("t1", "s2", "blocked", "Approve access", 80_000);
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "needs_review" })],
      containers: {
        t1: {
          activeSessionId: "s1",
          tabs: [
            {
              sessionId: "s1",
              title: "Keep building",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "s1", exitCode: null },
              activePaneId: "s1",
            },
            {
              sessionId: "s2",
              title: "Agent review",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "s2", exitCode: null },
              activePaneId: "s2",
            },
          ],
        },
      },
      signalsByTicket: { t1: latest },
      records: [],
      lastOutputAt: { s1: 99_000 },
      parkState: {},
      harness: {},
      now: 100_000,
    });

    // The attention row leads the band; the sibling stays its own destination,
    // one group down because it is merely working.
    expect(result.active).toMatchObject([
      {
        title: "Agent review",
        attention: { signal: "blocked", reason: "Approve access" },
        target: { tabId: "s2", paneId: "s2" },
      },
      { title: "Keep building", attention: null },
    ]);
  });

  it("falls back truthfully to the active tab, or the ticket when no live session can be identified", () => {
    const result = buildActiveSessionListing({
      tickets: [
        ticket({ id: "t1", status: "needs_review", ticketNumber: 1 }),
        ticket({
          id: "t2",
          status: "needs_review",
          ticketNumber: 2,
          title: "Review finished work",
        }),
      ],
      containers: {
        t1: {
          activeSessionId: "s2",
          tabs: [
            {
              sessionId: "s1",
              title: "Earlier tab",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "s1", exitCode: null },
              activePaneId: "s1",
            },
            {
              sessionId: "s2",
              title: "Current tab",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "s2", exitCode: null },
              activePaneId: "s2",
            },
          ],
        },
      },
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 100_000,
    });

    // Nothing has said why either ticket needs a human, so no row carries an
    // attention; the promoted tab still leads its ticket's rows, and the ticket
    // with nothing live keeps its board row at the bottom.
    expect(result.active.map((row) => ({ title: row.title, target: row.target }))).toEqual([
      { title: "Current tab", target: { tabId: "s2", paneId: "s2" } },
      { title: "Earlier tab", target: { tabId: "s1", paneId: "s1" } },
      { title: "Review finished work", target: null },
    ]);
  });

  it("maps the latest signal from a split pane back to its containing tab and exact pane", () => {
    const latest = signal("t1", "split", "blocked", "Choose an option", 20);
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "needs_review" })],
      containers: {
        t1: {
          activeSessionId: "root",
          tabs: [
            {
              sessionId: "root",
              title: "Agent and logs",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: {
                kind: "split",
                id: "split",
                direction: "vertical",
                ratio: 0.5,
                first: { kind: "pane", sessionId: "root", exitCode: null },
                second: { kind: "pane", sessionId: "split", exitCode: null },
              },
              activePaneId: "root",
            },
          ],
        },
      },
      signalsByTicket: { t1: latest },
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 100,
    });

    expect(result.active[0]).toMatchObject({
      attention: { signal: "blocked", reason: "Choose an option" },
      target: { tabId: "root", paneId: "split" },
    });
  });

  it("falls back to the active tab when the signalled session is in no tab any more", () => {
    const latest = signal("t1", "long-gone", "blocked", "Approve", 80_000);
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "needs_review" })],
      containers: { t1: container("s1", [paneTab("s1", "Still open")]) },
      signalsByTicket: { t1: latest },
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 100_000,
    });

    // A signal that cannot be routed to a pane says nothing about any row we
    // can show, so the row it lands on claims no attention at all.
    expect(result.active).toMatchObject([{ title: "Still open", attention: null }]);
  });

  it("orders the waiting group by recency rather than by how much the signal has to say", () => {
    const now = 1_000_000;
    const blocked = signal("t-blocked", "sb", "blocked", null, now - 100);
    const done = signal("t-done", "sd", "done", null, now - 100);
    const result = buildActiveSessionListing({
      tickets: [
        ticket({
          id: "t-done",
          status: "needs_review",
          ticketNumber: 1,
          title: "Done work",
          updatedAt: now - 100,
        }),
        ticket({ id: "t-bare", status: "needs_review", ticketNumber: 2, title: "Bare review" }),
        ticket({
          id: "t-blocked",
          status: "needs_review",
          ticketNumber: 3,
          title: "Blocked work",
          updatedAt: now - 5_000,
        }),
      ],
      containers: {
        "t-done": {
          activeSessionId: "sd",
          tabs: [
            {
              sessionId: "sd",
              title: "Done session",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t-done" },
              layout: { kind: "pane", sessionId: "sd", exitCode: null },
              activePaneId: "sd",
            },
          ],
        },
        "t-blocked": {
          activeSessionId: "sb",
          tabs: [
            {
              sessionId: "sb",
              title: "Blocked session",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t-blocked" },
              layout: { kind: "pane", sessionId: "sb", exitCode: null },
              activePaneId: "sb",
            },
          ],
        },
      },
      signalsByTicket: { "t-blocked": blocked, "t-done": done },
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // `blocked` no longer outranks `done`: both are rows a human is holding up,
    // and the useful question between two of them is which one is fresher. The
    // bare review prompt is a board row, so it sits below both regardless.
    expect(titles(result.active)).toEqual(["Done session", "Blocked session", "Bare review"]);
  });
});

describe("buildActiveSessionListing — the board guarantee", () => {
  it("keeps a Doing ticket visible after relaunch as a record-backed resume row", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      signalsByTicket: {},
      records: [
        record({
          id: "old",
          ticketId: "t1",
          title: "Earlier run",
          endedAt: now - 60_000,
        }),
        record({
          id: "split",
          ticketId: "t1",
          title: "Split pane",
          placement: "split",
          endedAt: now - 500,
        }),
        record({ id: "live", ticketId: "t1", title: "Still open", endedAt: null }),
        record({
          id: "s1",
          ticketId: "t1",
          title: "Claude run",
          harnessSessionId: "resume-seed-1",
          endedAt: now - 1_000,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // The newest ended tab-placement record wins: split panes never stand alone
    // and a not-yet-ended record is not a concluded run. `resumable` reads
    // `canResumeSession` — the same predicate the rail asks — rather than the
    // seed alone; the seed-less half of that is pinned by the mounted-tab tests
    // below, whose records carry no `harnessSessionId` at all.
    expect(result.active).toMatchObject([
      {
        title: "Claude run",
        activity: null,
        lastRun: { endedAt: now - 1_000, resumable: true },
        target: null,
      },
    ]);
    // The record the board row speaks for is consumed; the other ended run is
    // still a Session, and Previous is where it goes.
    expect(titles(result.previous)).toEqual(["Earlier run"]);
  });

  it("prefers a still-mounted exited tab for the fallback row, reopenable in place", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {
        t1: container("quit", [
          paneTab("clean", "Finished cleanly", 0),
          paneTab("quit", "Quit the agent", 1),
        ]),
      },
      signalsByTicket: {},
      records: [
        record({ id: "quit", ticketId: "t1", title: "Quit the agent", endedAt: now - 5_000 }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // One board row per unrepresented ticket: the container's active tab,
    // reopenable in place, dated by its durable record.
    expect(result.active).toMatchObject([
      {
        title: "Quit the agent",
        lastRun: { endedAt: now - 5_000, resumable: true },
        target: { tabId: "quit", paneId: "quit" },
      },
    ]);
    expect(titles(result.previous)).toEqual(["Finished cleanly"]);
  });

  it("takes the last tab when the container names no active one", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {
        t1: container(null, [paneTab("first", "First", 0), paneTab("last", "Last", 0)]),
      },
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.active).toMatchObject([{ title: "Last", target: { tabId: "last" } }]);
    expect(titles(result.previous)).toEqual(["First"]);
  });

  it("reads a manually quit agent's nonzero exit code as ended, never as a failure", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {
        // opencode exits 1 when the user quits it; the shell that ran it then
        // carries that 1 out as its own status on Ctrl-D.
        t1: container("s1", [paneTab("s1", "Quit the agent", 1)]),
      },
      signalsByTicket: {},
      records: [
        record({ id: "s1", ticketId: "t1", title: "Quit the agent", endedAt: now - 1_000 }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.active).toMatchObject([{ lastRun: { endedAt: now - 1_000, resumable: true } }]);
  });

  it("reads the 129 a SIGHUP-trapping shell exits with on tab close as ended", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {
        // Volli's own tab close kills the PTY with SIGHUP; zsh traps it and
        // exits 129, so this code is the app closing a tab the user asked it to.
        t1: container("s1", [paneTab("s1", "Closed the tab", 129)]),
      },
      signalsByTicket: {},
      records: [
        record({ id: "s1", ticketId: "t1", title: "Closed the tab", endedAt: now - 1_000 }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.active).toMatchObject([{ lastRun: { endedAt: now - 1_000, resumable: true } }]);
  });

  it("never claims a still-live tab ended, however long it has been quiet", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: { t1: container("s1", [paneTab("s1", "Open and silent")]) },
      signalsByTicket: {},
      records: [],
      lastOutputAt: { s1: now - 2 * ACTIVE_QUIET_WINDOW_MS },
      parkState: {},
      harness: {},
      now,
    });

    // The tab aged out of Active on its own, which leaves its Doing ticket
    // unrepresented — so the board row picks it back up. It is still running,
    // so it gets a muted presence row and no "Ended" claim, and it does not
    // also appear down in Previous.
    expect(result.active).toMatchObject([
      {
        title: "Open and silent",
        activity: null,
        lastRun: null,
        target: { tabId: "s1", paneId: "s1" },
      },
    ]);
    expect(result.previous).toEqual([]);
  });

  it("gives every unrepresented Doing ticket exactly one board row, ordered by recency", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [
        ticket({ id: "t-live", status: "doing", ticketNumber: 1 }),
        ticket({ id: "t-done", status: "doing", ticketNumber: 2 }),
        ticket({ id: "t-nonzero", status: "doing", ticketNumber: 3 }),
        ticket({ id: "t-finished", status: "done", ticketNumber: 4 }),
      ],
      containers: {
        "t-live": {
          activeSessionId: "s-live",
          tabs: [
            {
              sessionId: "s-live",
              title: "Live agent",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t-live" },
              layout: { kind: "pane", sessionId: "s-live", exitCode: null },
              activePaneId: "s-live",
            },
          ],
        },
      },
      signalsByTicket: {},
      records: [
        record({
          id: "r-done",
          ticketId: "t-done",
          title: "Clean run",
          exitCode: 0,
          endedAt: now - 5_000,
        }),
        record({
          id: "r-nonzero",
          ticketId: "t-nonzero",
          title: "Nonzero run",
          exitCode: 2,
          endedAt: now - 1_000,
        }),
        record({
          id: "r-finished",
          ticketId: "t-finished",
          title: "On a done ticket",
          exitCode: 0,
          endedAt: now - 1_000,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // Board rows trail the live one, most recently ended first. The clean run
    // and the nonzero one are ordered by when they ended and nothing else — a 0
    // and a 2 read the same here, because the shell's code is not a verdict on
    // the agent.
    expect(
      result.active.map((row) => ({ title: row.title, endedAt: row.lastRun?.endedAt ?? null })),
    ).toEqual([
      { title: "Live agent", endedAt: null },
      { title: "Nonzero run", endedAt: now - 1_000 },
      { title: "Clean run", endedAt: now - 5_000 },
    ]);
    // A Done-column ticket gets no board row — it is not in flight — but its
    // Session is still a Session, and Previous is where it goes.
    expect(titles(result.previous)).toEqual(["On a done ticket"]);
  });

  it("gives a Doing ticket with no sessions at all a bare presence row", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing", title: "Just moved here" })],
      containers: {},
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 100_000,
    });

    expect(result.active).toMatchObject([
      { title: "Just moved here", source: "No live session", lastRun: null, target: null },
    ]);
  });

  it("gives a promoted Needs Review attention session no duplicate row in either band", () => {
    const now = 1_000_000;
    const latest = signal("t1", "s1", "blocked", "Approve", now - 2_000);
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "needs_review" })],
      containers: {
        t1: container("s1", [paneTab("s1", "Agent", 1)]),
      },
      signalsByTicket: { t1: latest },
      records: [record({ id: "s1", ticketId: "t1", title: "Agent", endedAt: now - 1_000 })],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // An exited tab the agent signalled from is still what the ticket is about,
    // so the promotion keeps it in Active — and nothing repeats it in Previous.
    expect(result.active).toMatchObject([
      { title: "Agent", attention: { signal: "blocked", reason: "Approve" } },
    ]);
    expect(result.previous).toEqual([]);
  });

  it("uses the Session Engine's projected latest signal", () => {
    const latest = signal("t1", "s1", "blocked", "Approve access", 50);
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "needs_review" })],
      containers: { t1: container("s1", [paneTab("s1", "Agent review")]) },
      signalsByTicket: { t1: latest },
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 100,
    });

    // The Session Engine has already reduced durable Session evidence to the latest signal.
    expect(result.active[0]).toMatchObject({
      attention: { signal: "blocked", reason: "Approve access" },
    });
  });

  it("keeps the truly most-recent resume record even when it is not last in the array", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      signalsByTicket: {},
      records: [
        record({ id: "later", ticketId: "t1", title: "Actually latest", endedAt: now - 1_000 }),
        record({ id: "earlier", ticketId: "t1", title: "Really earlier", endedAt: now - 5_000 }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // The earlier-ended record, though it comes second, must never overwrite
    // the true latest found first.
    expect(result.active).toMatchObject([{ title: "Actually latest" }]);
    expect(titles(result.previous)).toEqual(["Really earlier"]);
  });

  it("still names the mounted tab's stale pane as the target, and ends from the record", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {
        t1: {
          activeSessionId: "s1",
          tabs: [
            {
              sessionId: "s1",
              title: "Ran the suite",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "s1", exitCode: 1 },
              activePaneId: "stale-pane",
            },
          ],
        },
      },
      signalsByTicket: {},
      records: [
        record({
          id: "s1",
          ticketId: "t1",
          title: "Ran the suite",
          exitCode: 0,
          endedAt: now - 5_000,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // The tab's active pane id is stale, so its layout can answer nothing about
    // the run; `endedAt` comes off the ticket's durable record. The target still
    // names the stale pane, because reopening the tab is what recovers it.
    expect(result.active).toMatchObject([
      {
        lastRun: { endedAt: now - 5_000, resumable: true },
        target: { tabId: "s1", paneId: "stale-pane" },
      },
    ]);
  });

  it("says a run ended without an endedAt when neither the layout nor a record can date it", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {
        t1: {
          activeSessionId: "s1",
          tabs: [
            {
              sessionId: "s1",
              title: "Mystery exit",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: { kind: "pane", sessionId: "s1", exitCode: 1 },
              activePaneId: "stale-pane",
            },
          ],
        },
      },
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 1_000_000,
    });

    // The pane says the run is over; nothing says WHEN. `activePaneId` names a
    // pane the layout does not hold and no durable record was fetched, so the
    // row reports an end it cannot date rather than inventing one.
    expect(result.active).toMatchObject([
      { source: "Terminal", lastRun: { endedAt: null, resumable: false } },
    ]);
  });

  it("orders two board rows by recency even when one has no matching record yet", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [
        ticket({
          id: "t-recent",
          status: "doing",
          ticketNumber: 1,
          updatedAt: now - 200,
          title: "Recently touched",
        }),
        ticket({
          id: "t-stale",
          status: "doing",
          ticketNumber: 2,
          updatedAt: now - 900_000,
          title: "Long untouched",
        }),
      ],
      containers: {
        "t-recent": container("s-recent", [paneTab("s-recent", "Recently exited", 0)]),
      },
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // Both rows are board rows with no ended time of their own to sort by — one
    // from a mounted tab whose record hasn't landed yet, the other with no
    // session at all — so both must fall back to the ticket's own recency
    // instead of crashing or silently tying.
    expect(titles(result.active)).toEqual(["Recently exited", "Long untouched"]);
    expect(result.previous).toEqual([]);
  });
});

describe("buildActiveSessionListing — chat Sessions", () => {
  it("puts a live chat Session in Active on its own recency, with no terminal involved", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      signalsByTicket: {},
      records: [],
      chatSessions: [chatSession({ ticketId: "t1", title: "Plan the migration", live: true })],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 100_000,
    });

    // The ticket is represented by the chat itself now, so no board row is
    // added behind it.
    expect(result.active).toMatchObject([
      { title: "Plan the migration", source: "Chat · Live", lastRun: null, target: null },
    ]);
    expect(result.previous).toEqual([]);
  });

  it("lets a chat Session's own activity decide its group", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [
        ticket({ id: "t1", status: "todo", ticketNumber: 1 }),
        ticket({ id: "t2", status: "todo", ticketNumber: 2 }),
        ticket({ id: "t3", status: "todo", ticketNumber: 3 }),
      ],
      containers: {},
      signalsByTicket: {},
      records: [],
      chatSessions: [
        // The idle one is the freshest, so only the grouping can sink it.
        chatSession({
          sessionId: "c-idle",
          ticketId: "t1",
          title: "Idle chat",
          activity: "idle",
          lastActivityAt: now - 100,
        }),
        chatSession({
          sessionId: "c-waiting",
          ticketId: "t2",
          title: "Waiting chat",
          activity: "waiting",
          lastActivityAt: now - 10_000,
        }),
        chatSession({
          sessionId: "c-working",
          ticketId: "t3",
          title: "Working chat",
          activity: "working",
          lastActivityAt: now - 5_000,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.active.map((row) => ({ title: row.title, attention: row.attention }))).toEqual([
      { title: "Waiting chat", attention: { signal: "waiting", reason: null } },
      { title: "Working chat", attention: null },
      { title: "Idle chat", attention: null },
    ]);
  });

  it("never calls a closed chat Session working, however it last described itself", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [
        ticket({ id: "t1", status: "todo", ticketNumber: 1 }),
        ticket({ id: "t2", status: "todo", ticketNumber: 2 }),
      ],
      containers: {},
      signalsByTicket: {},
      records: [],
      chatSessions: [
        chatSession({
          sessionId: "c-closed",
          ticketId: "t1",
          title: "Closed mid-turn",
          activity: "working",
          live: false,
          lastActivityAt: now - 100,
        }),
        chatSession({
          sessionId: "c-open",
          ticketId: "t2",
          title: "Actually working",
          activity: "working",
          live: true,
          lastActivityAt: now - 5_000,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // The closed one keeps its recency and stays visible — it is only minutes
    // old — but it joins the quiet group rather than claiming a turn is running
    // inside an attachment that is gone.
    expect(titles(result.active)).toEqual(["Actually working", "Closed mid-turn"]);
  });

  it("prefers a terminal record over a chat Session when the board row picks between them", () => {
    const now = 5_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      signalsByTicket: {},
      records: [record({ id: "s1", ticketId: "t1", title: "Terminal run", endedAt: now - 1_000 })],
      chatSessions: [chatSession({ ticketId: "t1", title: "Plan the migration", live: true })],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.active).toMatchObject([{ title: "Terminal run" }]);
    expect(titles(result.previous)).toEqual(["Plan the migration"]);
  });

  it("prefers a live chat Session over an ended one for the same ticket", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      signalsByTicket: {},
      records: [],
      chatSessions: [
        chatSession({
          sessionId: "ended",
          ticketId: "t1",
          title: "Older",
          live: false,
          createdAt: 50,
        }),
        chatSession({
          sessionId: "live",
          ticketId: "t1",
          title: "Newer, live",
          live: true,
          createdAt: 10,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 5_000_000,
    });

    // Both chats are long past the quiet window, so the board row is what picks
    // between them — and the Session it names is not repeated in Previous.
    expect(result.active).toMatchObject([{ title: "Newer, live" }]);
    expect(titles(result.previous)).toEqual(["Older"]);
  });

  it("keeps a live chat Session over a newer ended one, array order reversed from the other case", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      signalsByTicket: {},
      records: [],
      chatSessions: [
        chatSession({
          sessionId: "live",
          ticketId: "t1",
          title: "Older, live",
          live: true,
          createdAt: 10,
        }),
        chatSession({
          sessionId: "ended",
          ticketId: "t1",
          title: "Newer, ended",
          live: false,
          createdAt: 50,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 5_000_000,
    });

    expect(result.active).toMatchObject([{ title: "Older, live" }]);
  });

  it("breaks a tie between two ended chat Sessions by recency, regardless of array order", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      signalsByTicket: {},
      records: [],
      chatSessions: [
        chatSession({
          sessionId: "older",
          ticketId: "t1",
          title: "Older",
          live: false,
          createdAt: 10,
        }),
        chatSession({
          sessionId: "newer",
          ticketId: "t1",
          title: "Newer",
          live: false,
          createdAt: 50,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 5_000_000,
    });

    expect(result.active).toMatchObject([{ title: "Newer" }]);
  });

  it("breaks a tie between two live chat Sessions by recency, regardless of array order", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      signalsByTicket: {},
      records: [],
      chatSessions: [
        chatSession({
          sessionId: "newer",
          ticketId: "t1",
          title: "Newer",
          live: true,
          createdAt: 50,
        }),
        chatSession({
          sessionId: "older",
          ticketId: "t1",
          title: "Older",
          live: true,
          createdAt: 10,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 5_000_000,
    });

    expect(result.active).toMatchObject([{ title: "Newer" }]);
  });

  it("falls back to No live session when a ticket has neither a terminal record nor a chat Session", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      signalsByTicket: {},
      records: [],
      chatSessions: [chatSession({ ticketId: "t2", title: "Someone else's ticket", live: false })],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 5_000_000,
    });

    expect(result.active).toMatchObject([{ title: "Ship the feature", source: "No live session" }]);
    // The other ticket is not on this board at all, so its closed chat can
    // navigate nowhere — cleanup rule (a) takes it.
    expect(result.previous).toEqual([]);
  });

  it("never reaches the chat fallback when a live terminal tab already covers the ticket", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: { t1: container("s1", [paneTab("s1", "Implement UI")]) },
      signalsByTicket: {},
      records: [],
      chatSessions: [chatSession({ ticketId: "t1", title: "Quiet since yesterday" })],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 5_000_000,
    });

    // The chat is no longer discarded for having lost to a terminal — it is a
    // Previous row.
    expect(titles(result.active)).toEqual(["Implement UI"]);
    expect(titles(result.previous)).toEqual(["Quiet since yesterday"]);
  });

  it("omits the chat fallback entirely when `chatSessions` is absent", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 100_000,
    });

    expect(result.active).toMatchObject([{ title: "Ship the feature", source: "No live session" }]);
  });
});

describe("buildActiveSessionListing — the scratch container", () => {
  it("lists a live scratch terminal in Active, with no ticket", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [],
      containers: {},
      scratchContainer: scratchOf([scratchTab("scratch-1", "Poke at the repo")]),
      signalsByTicket: {},
      records: [],
      lastOutputAt: { "scratch-1": now - 1_000 },
      parkState: {},
      harness: {},
      now,
    });

    expect(titles(result.active)).toEqual(["Poke at the repo"]);
    expect(result.active[0]?.ticket).toBeNull();
    expect(result.active[0]?.target).toEqual({ tabId: "scratch-1", paneId: "scratch-1" });
    expect(result.previous).toEqual([]);
  });

  // The regression this whole pass exists for: `containers` is walked by
  // ticket, so before the scratch container arrived on its own key a live
  // scratch terminal reached neither band.
  it("reaches no band for a live scratch terminal handed over only under the project key", () => {
    const now = 10_000_000;
    const withoutScratch = buildActiveSessionListing({
      tickets: [],
      // The store's real shape: one flat map, scratch keyed by PROJECT id.
      containers: { p1: scratchOf([scratchTab("scratch-1", "Poke at the repo")]) },
      signalsByTicket: {},
      records: [],
      lastOutputAt: { "scratch-1": now - 1_000 },
      parkState: {},
      harness: {},
      now,
    });

    expect(withoutScratch.active).toEqual([]);
    expect(withoutScratch.previous).toEqual([]);
  });

  it("drops a quiet scratch terminal into Previous once the window closes", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [],
      containers: {},
      scratchContainer: scratchOf([scratchTab("scratch-1", "Poke at the repo")]),
      signalsByTicket: {},
      records: [],
      lastOutputAt: { "scratch-1": now - ACTIVE_QUIET_WINDOW_MS - 1 },
      parkState: {},
      harness: {},
      now,
    });

    expect(result.active).toEqual([]);
    expect(titles(result.previous)).toEqual(["Poke at the repo"]);
    expect(result.previous[0]?.ticket).toBeNull();
    expect(result.previous[0]?.kind).toBe("terminal");
  });

  // A scratch container holding the pane is the proof of ticketless birth, so
  // the exemption survives the record being absent from the listing entirely —
  // which is the normal case for a pane that has not ended.
  it("exempts a scratch row from cleanup even with no durable record to ask", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [],
      containers: {},
      scratchContainer: scratchOf([scratchTab("scratch-1", "Poke at the repo")]),
      signalsByTicket: {},
      records: [],
      // Far past PREVIOUS_MAX_AGE_MS: a ticketed row this old is cleaned away.
      lastOutputAt: { "scratch-1": now - PREVIOUS_MAX_AGE_MS - 1 },
      parkState: {},
      harness: {},
      now,
    });

    expect(titles(result.previous)).toEqual(["Poke at the repo"]);
    expect(result.previous[0]?.cleaned).toBe(false);
  });

  it("files an exited scratch tab into Previous, still reachable and still exempt", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [],
      containers: {},
      scratchContainer: scratchOf([
        scratchTab("scratch-1", "Poke at the repo", 0),
        scratchTab("scratch-2", "Still going"),
      ]),
      signalsByTicket: {},
      records: [],
      lastOutputAt: { "scratch-1": now - PREVIOUS_MAX_AGE_MS - 1, "scratch-2": now - 1_000 },
      parkState: {},
      harness: {},
      now,
    });

    expect(titles(result.active)).toEqual(["Still going"]);
    expect(titles(result.previous)).toEqual(["Poke at the repo"]);
    expect(result.previous[0]?.cleaned).toBe(false);
    expect(result.previous[0]?.target).toEqual({ tabId: "scratch-1", paneId: "scratch-1" });
  });

  // The mounted pane wins: a live scratch tab and its own durable record are
  // one Session, and Previous must not grow a second row for it.
  it("never doubles a scratch Session that also has a durable record", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [],
      containers: {},
      scratchContainer: scratchOf([scratchTab("scratch-1", "Poke at the repo")]),
      signalsByTicket: {},
      records: [
        record({
          id: "scratch-1",
          ticketId: null,
          title: "Poke at the repo",
          endedAt: now - 5_000,
          bornTicketless: true,
        }),
      ],
      lastOutputAt: { "scratch-1": now - 1_000 },
      parkState: {},
      harness: {},
      now,
    });

    expect(titles(result.active)).toEqual(["Poke at the repo"]);
    expect(result.previous).toEqual([]);
  });

  // The post-relaunch case, with no ticket to borrow a date from: `lastOutputAt`
  // died with the window, so a scratch tab is datable only through its own
  // record's newest durable fact, and otherwise not at all. Both stay in Active
  // (the module's documented bias), and the one that can be dated sorts above
  // the one that cannot — 0 is "we could not establish this", never `now`.
  it("dates an unstamped scratch row by its record, and keeps an undatable one anyway", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [],
      containers: {},
      scratchContainer: scratchOf([
        scratchTab("scratch-undatable", "Nothing can date this"),
        scratchTab("scratch-dated", "Dated by its record"),
      ]),
      signalsByTicket: {},
      records: [
        record({
          id: "scratch-dated",
          ticketId: null,
          title: "Dated by its record",
          endedAt: null,
          lastActivityAt: now - 1_000,
          bornTicketless: true,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(titles(result.active)).toEqual(["Dated by its record", "Nothing can date this"]);
    expect(result.previous).toEqual([]);
  });

  // A scratch Session can never be the Needs-Review promotion (it has no
  // ticket and no column), so the hook channel is its ONLY route to an
  // attention — and a ticketless row is the one row with no board card to raise
  // the flag instead.
  it("raises a hook-declared wait on a scratch terminal, and pins it to the top", () => {
    const now = 100_000;
    const result = buildActiveSessionListing({
      tickets: [],
      containers: {},
      scratchContainer: scratchOf([
        scratchTab("scratch-quiet", "Just sitting there"),
        scratchTab("scratch-asking", "Asking for something"),
      ]),
      signalsByTicket: {},
      records: [],
      lastOutputAt: { "scratch-quiet": now - 500, "scratch-asking": now - 1_000 },
      parkState: {},
      harness: { "scratch-asking": reporting("input.needed") },
      now,
    });

    // Ahead of the more recently active row: attention outranks recency.
    expect(titles(result.active)).toEqual(["Asking for something", "Just sitting there"]);
    expect(result.active[0]?.attention).toEqual({ signal: "waiting", reason: null });
    expect(result.active[0]?.ticket).toBeNull();
  });

  it("makes no board guarantee for a scratch Session, having no ticket to guarantee", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      scratchContainer: scratchOf([scratchTab("scratch-1", "Poke at the repo")]),
      signalsByTicket: {},
      records: [],
      lastOutputAt: { "scratch-1": now - 1_000 },
      parkState: {},
      harness: {},
      now,
    });

    // The Doing ticket still gets its own bare row; the scratch row neither
    // satisfies nor suppresses it.
    expect(titles(result.active)).toEqual(["Poke at the repo", "Ship the feature"]);
    expect(result.active[1]?.source).toBe("No live session");
  });
});

describe("buildActiveSessionListing — the Previous band", () => {
  it("returns every ended Session the fetch handed over, newest first", () => {
    const now = 20_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "todo" })],
      containers: {},
      signalsByTicket: {},
      records: [
        record({ id: "r-old", ticketId: "t1", title: "Older run", endedAt: now - 4_000_000 }),
        record({ id: "r-new", ticketId: "t1", title: "Newer run", endedAt: now - 2_000_000 }),
        record({ id: "r-live", ticketId: "t1", title: "Never ended", endedAt: null }),
        record({
          id: "r-split",
          ticketId: "t1",
          title: "A split pane",
          placement: "split",
          endedAt: now - 1_000,
        }),
      ],
      chatSessions: [
        chatSession({
          sessionId: "c1",
          ticketId: "t1",
          title: "Quiet chat",
          live: false,
          lastActivityAt: now - 3_000_000,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // Split panes never stand alone as a row, and a record with no end is
    // either mounted somewhere or a live-looking leftover nothing can date.
    expect(result.active).toEqual([]);
    expect(result.previous.map((row) => ({ title: row.title, kind: row.kind }))).toEqual([
      { title: "Newer run", kind: "terminal" },
      { title: "Quiet chat", kind: "chat" },
      { title: "Older run", kind: "terminal" },
    ]);
  });

  it("lets the mounted tab speak for a Session rather than doubling it with its record", () => {
    const now = 5_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "todo" })],
      containers: { t1: container("s1", [paneTab("s1", "Live tab title", 0)]) },
      signalsByTicket: {},
      records: [
        record({ id: "s1", ticketId: "t1", title: "Stale record title", endedAt: now - 1_000 }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.previous).toMatchObject([
      { title: "Live tab title", endedOrQuietAt: now - 1_000, target: { tabId: "s1" } },
    ]);
  });

  it("dates an exited tab with no durable record from its ticket rather than from nothing", () => {
    const now = 5_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "todo", updatedAt: now - 4_000 })],
      containers: { t1: container("s1", [paneTab("s1", "Undated exit", 0)]) },
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.previous).toMatchObject([{ title: "Undated exit", endedOrQuietAt: now - 4_000 }]);
  });

  it("carries ticketless Sessions into both bands", () => {
    const now = 5_000_000;
    const result = buildActiveSessionListing({
      tickets: [],
      containers: {},
      signalsByTicket: {},
      records: [
        record({ id: "r1", ticketId: null, title: "Scratch terminal", endedAt: now - 1_000 }),
      ],
      chatSessions: [
        chatSession({
          sessionId: "c1",
          ticketId: null,
          title: "Scratch chat",
          activity: "working",
          lastActivityAt: now - 500,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.active).toMatchObject([{ title: "Scratch chat", ticket: null }]);
    expect(result.previous).toMatchObject([{ title: "Scratch terminal", ticket: null }]);
  });
});

describe("buildActiveSessionListing — cleanup", () => {
  const cleanupFacts = {
    ticketId: "t1",
    ticket: ticket({ id: "t1", status: "doing" }),
    createdAt: 1_000,
    endedOrQuietAt: 2_000,
    attached: false,
    bornTicketless: false,
    statusEnteredAt: new Map<string, number>(),
    now: 3_000,
  };

  it("exempts a born-ticketless Session and a still-attached one, not an orphan", () => {
    expect(isCleanupExempt({ ticketId: null, attached: false, bornTicketless: true })).toBe(true);
    expect(isCleanupExempt({ ticketId: "t1", attached: true, bornTicketless: false })).toBe(true);
    expect(isCleanupExempt({ ticketId: "t1", attached: false, bornTicketless: false })).toBe(false);
    // Ticketless by deletion, not by birth: the exemption does not apply.
    expect(isCleanupExempt({ ticketId: null, attached: false, bornTicketless: false })).toBe(false);
    // Nor does birth alone earn it. The exemption is about a Session having
    // nowhere else to be reached from; one sitting on a ticket has a board card
    // and a rail, whatever it was born as.
    expect(isCleanupExempt({ ticketId: "t1", attached: false, bornTicketless: true })).toBe(false);
  });

  it("(a) cleans a Session whose ticket has left the board", () => {
    expect(isConcludedBusiness({ ...cleanupFacts, ticket: null })).toBe(true);
    // A born-scratch Session never had a board row to lose.
    expect(
      isConcludedBusiness({
        ...cleanupFacts,
        ticketId: null,
        ticket: null,
        bornTicketless: true,
      }),
    ).toBe(false);
    // An orphan did: its ticket is gone, which is exactly what rule (a) cleans.
    expect(
      isConcludedBusiness({
        ...cleanupFacts,
        ticketId: null,
        ticket: null,
        bornTicketless: false,
      }),
    ).toBe(true);
  });

  it("(b) cleans a Done ticket's Sessions once it has lingered, and not a moment sooner", () => {
    const done = ticket({ id: "t1", status: "done" });
    const at = (enteredAt: number) =>
      isConcludedBusiness({
        ...cleanupFacts,
        ticket: done,
        now: 10_000_000,
        endedOrQuietAt: 10_000_000 - 1_000,
        statusEnteredAt: new Map([["t1", enteredAt]]),
        // Created after the entry, so rule (c) cannot answer for rule (b).
        createdAt: enteredAt + 1,
      });

    expect(at(10_000_000 - DONE_LINGER_MS + 1)).toBe(false);
    expect(at(10_000_000 - DONE_LINGER_MS)).toBe(true);
  });

  it("(b) stays silent for a Done ticket whose column history we do not have", () => {
    expect(
      isConcludedBusiness({
        ...cleanupFacts,
        ticket: ticket({ id: "t1", status: "done" }),
        statusEnteredAt: new Map(),
      }),
    ).toBe(false);
  });

  it("(c) cleans a Session that predates its ticket's entry into the current column", () => {
    const predates = (createdAt: number | null) =>
      isConcludedBusiness({
        ...cleanupFacts,
        createdAt,
        statusEnteredAt: new Map([["t1", 1_000]]),
      });

    expect(predates(999)).toBe(true);
    expect(predates(1_000)).toBe(false);
    // Nothing durable can date the Session, so the rule declines to guess.
    expect(predates(null)).toBe(false);
  });

  it("(d) cleans a Session once it is old enough, and not before", () => {
    const aged = (endedOrQuietAt: number) =>
      isConcludedBusiness({ ...cleanupFacts, now: 10_000_000, endedOrQuietAt });

    expect(aged(10_000_000 - PREVIOUS_MAX_AGE_MS + 1)).toBe(false);
    expect(aged(10_000_000 - PREVIOUS_MAX_AGE_MS)).toBe(true);
  });

  it("drops a Done ticket's lingered Sessions and a ticket's pre-move ones from Previous", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [
        ticket({ id: "t-done", status: "done", ticketNumber: 1 }),
        ticket({ id: "t-todo", status: "todo", ticketNumber: 2 }),
      ],
      containers: {},
      signalsByTicket: {},
      records: [
        record({
          id: "r-done",
          ticketId: "t-done",
          title: "On a finished ticket",
          endedAt: now - 1_000,
          createdAt: now - DONE_LINGER_MS + 1,
        }),
      ],
      chatSessions: [
        chatSession({
          sessionId: "c-todo",
          ticketId: "t-todo",
          title: "Predates the move",
          live: false,
          createdAt: 1,
          lastActivityAt: now - 2 * ACTIVE_QUIET_WINDOW_MS,
        }),
      ],
      statusEnteredAt: new Map([
        ["t-done", now - DONE_LINGER_MS],
        ["t-todo", now - 500],
      ]),
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.active).toEqual([]);
    expect(result.previous).toEqual([]);
  });

  it("never lets a cleanup rule reach the Active band", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing", title: "Still in flight" })],
      containers: {},
      signalsByTicket: {},
      records: [
        record({
          id: "r1",
          ticketId: "t1",
          title: "Predates the move",
          createdAt: 1,
          endedAt: now - 1_000,
        }),
      ],
      statusEnteredAt: new Map([["t1", now - 500]]),
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // Rule (c) matches this Session, and cleanup only ever runs over Previous —
    // the board still says the ticket is in flight, so its guarantee row names
    // the Session and Previous never sees it.
    expect(result.active).toMatchObject([{ title: "Predates the move", activity: null }]);
    expect(result.previous).toEqual([]);
  });

  it("never cleans a ticketless Session, however old", () => {
    const now = 10 * PREVIOUS_MAX_AGE_MS;
    const result = buildActiveSessionListing({
      tickets: [],
      containers: {},
      signalsByTicket: {},
      records: [record({ id: "r1", ticketId: null, title: "Ancient scratch", endedAt: 1 })],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(titles(result.previous)).toEqual(["Ancient scratch"]);
  });

  it("never cleans a Session whose terminal is still attached", () => {
    const now = 10_000_000;
    const listing = (exitCode: number | null) =>
      buildActiveSessionListing({
        tickets: [ticket({ id: "t1", status: "todo" })],
        containers: { t1: container("s1", [paneTab("s1", "Quiet but open", exitCode)]) },
        signalsByTicket: {},
        records: [record({ id: "s1", ticketId: "t1", createdAt: 1, endedAt: null })],
        statusEnteredAt: new Map([["t1", 500]]),
        lastOutputAt: { s1: now - 2 * ACTIVE_QUIET_WINDOW_MS },
        parkState: {},
        harness: {},
        now,
      });

    // Rule (c) matches both of these — the Session was created before the
    // ticket entered Todo — and only the exited one may be taken.
    expect(titles(listing(null).previous)).toEqual(["Quiet but open"]);
    expect(listing(0).previous).toEqual([]);
  });

  it("keeps a demoted tab that has no durable record, because no rule can date it", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "todo" })],
      containers: { t1: container("s1", [paneTab("s1", "No record at all", 0)]) },
      signalsByTicket: {},
      records: [],
      statusEnteredAt: new Map([["t1", now - 100]]),
      lastOutputAt: { s1: now - 2 * ACTIVE_QUIET_WINDOW_MS },
      parkState: {},
      harness: {},
      now,
    });

    // Rule (c) would fire on any Session created before `now - 100`, but
    // nothing here can date this one, so it stays.
    expect(titles(result.previous)).toEqual(["No record at all"]);
  });
});

describe("buildActiveSessionListing — the Previous filter", () => {
  const now = 5_000_000;
  const input = {
    tickets: [ticket({ id: "t1", status: "todo" })],
    containers: {},
    signalsByTicket: {},
    records: [
      record({ id: "r1", ticketId: "t1", title: "Ended terminal", endedAt: now - 1_000 }),
      record({ id: "r-gone", ticketId: "t-archived", title: "Orphaned", endedAt: now - 500 }),
    ],
    chatSessions: [
      chatSession({
        sessionId: "c1",
        ticketId: "t1",
        title: "Quiet chat",
        live: false,
        lastActivityAt: now - 2 * ACTIVE_QUIET_WINDOW_MS,
      }),
    ],
    lastOutputAt: {},
    parkState: {},
    harness: {},
    now,
  };

  it("shows every kind when `kinds` is null", () => {
    const result = buildActiveSessionListing({
      ...input,
      filter: { kinds: null, showCleaned: false },
    });
    expect(titles(result.previous)).toEqual(["Ended terminal", "Quiet chat"]);
  });

  it("shows only the kinds asked for", () => {
    expect(
      titles(
        buildActiveSessionListing({
          ...input,
          filter: { kinds: new Set(["chat" as const]), showCleaned: false },
        }).previous,
      ),
    ).toEqual(["Quiet chat"]);
    expect(
      titles(
        buildActiveSessionListing({
          ...input,
          filter: { kinds: new Set(["terminal" as const]), showCleaned: false },
        }).previous,
      ),
    ).toEqual(["Ended terminal"]);
  });

  it("narrows Previous without narrowing Active, which is deliberately unfilterable", () => {
    const result = buildActiveSessionListing({
      ...input,
      containers: { t1: container("s-live", [paneTab("s-live", "Live terminal")]) },
      lastOutputAt: { "s-live": now - 60_000 },
      chatSessions: [
        ...input.chatSessions,
        chatSession({
          sessionId: "c-live",
          ticketId: "t1",
          title: "Live chat",
          activity: "working",
          live: true,
          lastActivityAt: now - 1_000,
        }),
      ],
      filter: { kinds: new Set(["chat" as const]), showCleaned: false },
    });

    // Terminals are filtered out of Previous and stay in Active: you do not get
    // to hide what is running, only what is over.
    expect(titles(result.active)).toEqual(["Live chat", "Live terminal"]);
    expect(titles(result.previous)).toEqual(["Quiet chat"]);
  });

  it("brings cleaned rows back, marked, when asked", () => {
    const hidden = buildActiveSessionListing(input);
    expect(titles(hidden.previous)).toEqual(["Ended terminal", "Quiet chat"]);

    const shown = buildActiveSessionListing({
      ...input,
      filter: { kinds: null, showCleaned: true },
    });
    expect(shown.previous.map((row) => ({ title: row.title, cleaned: row.cleaned }))).toEqual([
      { title: "Orphaned", cleaned: true },
      { title: "Ended terminal", cleaned: false },
      { title: "Quiet chat", cleaned: false },
    ]);
  });
});

describe("buildActiveSessionListing — nextBoundaryAt", () => {
  it("is null when nothing about the result depends on the clock", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 100_000,
    });

    expect(result.active).toHaveLength(1);
    expect(result.nextBoundaryAt).toBeNull();
  });

  it("names the moment an Active row ages out of its quiet window", () => {
    const now = 5_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "todo" })],
      containers: { t1: container("s1", [paneTab("s1", "Gone quiet")]) },
      signalsByTicket: {},
      records: [],
      lastOutputAt: { s1: now - 60_000 },
      parkState: {},
      harness: {},
      now,
    });

    expect(result.nextBoundaryAt).toBe(now - 60_000 + ACTIVE_QUIET_WINDOW_MS);
  });

  it("ignores a boundary that has already passed", () => {
    const now = 5_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "todo" })],
      containers: {},
      signalsByTicket: {},
      records: [],
      chatSessions: [
        // A chat still reporting a running turn while its newest fact is hours
        // old: it belongs in Active on what it says, and there is nothing for
        // the window to do about it.
        chatSession({
          ticketId: "t1",
          title: "Long turn",
          activity: "working",
          live: true,
          lastActivityAt: now - 4 * ACTIVE_QUIET_WINDOW_MS,
        }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(titles(result.active)).toEqual(["Long turn"]);
    expect(result.nextBoundaryAt).toBeNull();
  });

  it("does not name a waiting row's quiet window, which cannot expire it", () => {
    const now = 5_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "needs_review" })],
      containers: { t1: container("s1", [paneTab("s1", "Blocked run")]) },
      signalsByTicket: { t1: signal("t1", "s1", "blocked", "Approve access", now - 60_000) },
      records: [],
      lastOutputAt: { s1: now - 60_000 },
      parkState: {},
      harness: {},
      now,
    });

    // The row has a stamp inside the window, so there IS a `quietAt + window`
    // instant to offer — and offering it would wake the caller for a change
    // that cannot happen, because an attention row leaves when its agent moves.
    expect(result.active).toMatchObject([{ attention: { signal: "blocked" } }]);
    expect(result.nextBoundaryAt).toBeNull();
  });

  it("names the moment a Done ticket's linger expires", () => {
    const now = 10_000_000;
    const enteredAt = now - 1_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "done" })],
      containers: {},
      signalsByTicket: {},
      records: [
        record({
          id: "r1",
          ticketId: "t1",
          title: "Finished run",
          createdAt: enteredAt + 1,
          endedAt: now - 500,
        }),
      ],
      statusEnteredAt: new Map([["t1", enteredAt]]),
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(titles(result.previous)).toEqual(["Finished run"]);
    expect(result.nextBoundaryAt).toBe(enteredAt + DONE_LINGER_MS);
  });

  it("names the moment a Previous row reaches its maximum age", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "todo" })],
      containers: {},
      signalsByTicket: {},
      records: [record({ id: "r1", ticketId: "t1", title: "Old run", endedAt: now - 1_000 })],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.nextBoundaryAt).toBe(now - 1_000 + PREVIOUS_MAX_AGE_MS);
  });

  it("takes the earliest boundary across every source", () => {
    const now = 10_000_000;
    const quietAt = now - 60_000;
    const enteredAt = now - 1_000;
    const result = buildActiveSessionListing({
      tickets: [
        ticket({ id: "t-live", status: "todo", ticketNumber: 1 }),
        ticket({ id: "t-done", status: "done", ticketNumber: 2 }),
        ticket({ id: "t-old", status: "todo", ticketNumber: 3 }),
      ],
      containers: { "t-live": container("s1", [paneTab("s1", "Gone quiet")]) },
      signalsByTicket: {},
      records: [
        record({
          id: "r-done",
          ticketId: "t-done",
          title: "Finished run",
          createdAt: enteredAt + 1,
          endedAt: now - 500,
        }),
        record({ id: "r-old", ticketId: "t-old", title: "Old run", endedAt: now - 500 }),
      ],
      statusEnteredAt: new Map([["t-done", enteredAt]]),
      lastOutputAt: { s1: quietAt },
      parkState: {},
      harness: {},
      now,
    });

    // The quiet window (30m) fires before the Done linger (1h), which fires
    // long before the seven-day age limit.
    expect(result.nextBoundaryAt).toBe(quietAt + ACTIVE_QUIET_WINDOW_MS);
  });
});

/** An injected adapter that speaks at boot and binds exactly `events`. */
function hookedAdapter(events: readonly HarnessEvent[]): CreateSessionHarnessStateInput["adapter"] {
  return {
    injection: { kind: "claude-settings-json", flag: "--settings" },
    startupEvent: "session.started",
    events: events.map((event) => ({ event, native: event, delivery: "async" })),
  };
}

/** A hooked claude-code session that has reported `event` most recently. */
function reporting(event: HarnessEvent, startedAt = 90_000): SessionHarnessState {
  return receiveHarnessEvent(
    createSessionHarnessState({
      harnessId: "claude-code",
      adapter: hookedAdapter(["session.started", "turn.started", "input.needed"]),
      startedAt,
    }),
    event,
    null,
  );
}

describe("buildActiveSessionListing — harness-reported attention", () => {
  it("puts a Doing ticket whose agent is blocked on a human at the top of Active", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: { t1: container("s1", [paneTab("s1", "Implement UI")]) },
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: { s1: reporting("input.needed") },
      now: 100_000,
    });

    expect(
      result.active.map((row) => ({
        title: row.title,
        activity: row.activity,
        attention: row.attention,
      })),
    ).toEqual([
      {
        title: "Implement UI",
        activity: "waiting",
        attention: { signal: "waiting", reason: null },
      },
    ]);
    expect(result.previous).toEqual([]);
  });

  it("shows a Needs Review ticket's hook-declared wait as its attention when no CLI signal exists", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "needs_review" })],
      containers: { t1: container("s1", [paneTab("s1", "Agent review")]) },
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: { s1: reporting("input.needed") },
      now: 100_000,
    });

    // No `volli session` signal was ever sent, so the involuntary hook channel
    // is the only source of attention here.
    expect(result.active).toMatchObject([
      { title: "Agent review", attention: { signal: "waiting", reason: null } },
    ]);
  });

  it("never raises an attention on a cursor session, whatever claims it is blocked", () => {
    // Cursor's own source maps both permission and notification events to null,
    // so a blocking event bearing its name is noise, not a report.
    const cursor = receiveHarnessEvent(
      createSessionHarnessState({
        harnessId: "cursor",
        adapter: hookedAdapter(["session.started", "turn.started", "turn.completed"]),
        startedAt: 90_000,
      }),
      "input.needed",
      null,
    );
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: { t1: container("s1", [paneTab("s1", "Implement UI")]) },
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: { s1: cursor },
      now: 100_000,
    });

    expect(result.active).toMatchObject([{ activity: "idle", attention: null }]);
  });

  it("orders a hook-declared wait against an agent's own signal by recency alone", () => {
    const latest = signal("t2", "s2", "blocked", "Approve the deploy", 80_000);
    const result = buildActiveSessionListing({
      tickets: [
        ticket({ id: "t1", status: "doing", ticketNumber: 1, updatedAt: 90_000 }),
        ticket({ id: "t2", status: "needs_review", ticketNumber: 2, updatedAt: 10_000 }),
      ],
      containers: {
        t1: container("s1", [paneTab("s1", "Implement UI")]),
        t2: container("s2", [paneTab("s2", "Ship it")]),
      },
      signalsByTicket: { t2: latest },
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: { s1: reporting("input.needed") },
      now: 100_000,
    });

    // Both need a human, and neither claim outranks the other any more — the
    // more recently touched ticket leads.
    expect(result.active.map((row) => row.attention)).toEqual([
      { signal: "waiting", reason: null },
      { signal: "blocked", reason: "Approve the deploy" },
    ]);
  });

  it("says a session's activity is inferred when the hooks it promised never arrived", () => {
    const bypassed = createSessionHarnessState({
      harnessId: "claude-code",
      adapter: hookedAdapter(["session.started", "turn.started", "input.needed"]),
      startedAt: 1000,
    });
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: { t1: container("s1", [paneTab("s1", "Implement UI")]) },
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: { s1: bypassed },
      now: 100_000,
    });

    expect(result.active.map((row) => row.activitySource)).toEqual(["silent"]);
  });

  it("describes the pane it was promoted by, not whichever pane happened to be in front", () => {
    // A split whose visible pane is a plain shell and whose background pane is
    // the agent that just asked for a human. The row is promoted by the agent,
    // so everything it says has to be about the agent.
    const split = {
      sessionId: "s1",
      title: "Implement UI",
      scope: { kind: "ticket", projectId: "p1", ticketId: "t1" } as const,
      layout: {
        kind: "split",
        id: "sp1",
        direction: "vertical",
        ratio: 0.5,
        first: { kind: "pane", sessionId: "s1", exitCode: null },
        second: { kind: "pane", sessionId: "s2", exitCode: null },
      } as const,
      activePaneId: "s1",
    };
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: { t1: { activeSessionId: "s1", tabs: [split] } },
      signalsByTicket: {},
      records: [
        record({ id: "s1", ticketId: "t1", launchKind: "shell", placement: "split" }),
        record({ id: "s2", ticketId: "t1", launchKind: "agent" }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: { s2: reporting("input.needed") },
      now: 100_000,
    });

    expect(result.active).toMatchObject([
      {
        activity: "waiting",
        // Previously "inferred", read off the shell in front — the row claimed
        // a harness-declared wait and denied that anything was reporting.
        activitySource: "reported",
        source: "Claude Code",
        target: { tabId: "s1", paneId: "s2" },
      },
    ]);
    expect(result.previous).toEqual([]);
  });
});

describe("buildActiveSessionListing — fed by a real launch", () => {
  afterEach(() => {
    useSessionsStore.setState({ byOwner: {}, sessionOwner: {}, harness: {} });
  });

  it("lets an announced launch that never reports decay into 'not reporting' on its own", () => {
    // No hand-built harness state anywhere: the store registers the
    // expectation when the tab lands and anchors it when the wrapper announces,
    // which is what makes the silence below a fact about the injected hooks
    // rather than an absence of information.
    useSessionsStore.getState().addSession(ticketScope("p1", "t1"), "s1", {
      title: "Implement UI",
      harnessId: "claude-code",
      launchKind: "agent",
      createdAt: 1000,
    });

    const listing = (now: number) =>
      buildActiveSessionListing({
        tickets: [ticket({ id: "t1", status: "doing" })],
        containers: useSessionsStore.getState().byOwner,
        signalsByTicket: {},
        records: [],
        lastOutputAt: {},
        parkState: {},
        harness: useSessionsStore.getState().harness,
        now,
      });

    // Nothing has run yet — the terminal may sit here all day without being
    // accused of anything.
    expect(
      listing(1000 + HARNESS_EVENT_GRACE_MS + 1).active.map((row) => row.activitySource),
    ).toEqual(["inferred"]);

    useSessionsStore.getState().announceHarness("s1", "claude-code", 5000);

    expect(listing(5000 + HARNESS_EVENT_GRACE_MS).active.map((row) => row.activitySource)).toEqual([
      "inferred",
    ]);
    expect(
      listing(5000 + HARNESS_EVENT_GRACE_MS + 1).active.map((row) => row.activitySource),
    ).toEqual(["silent"]);
  });

  it("never accuses a bare shell of not reporting, however long it sits there", () => {
    useSessionsStore
      .getState()
      .addSession(ticketScope("p1", "t1"), "s1", shellLaunch("Terminal 1"));

    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: useSessionsStore.getState().byOwner,
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: useSessionsStore.getState().harness,
      now: 10_000_000,
    });

    expect(result.active.map((row) => row.activitySource)).toEqual(["inferred"]);
  });
});

describe("buildActiveSessionListing — fed by the live harness channel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useSessionsStore.setState({ byOwner: {}, sessionOwner: {}, harness: {} });
  });

  it("raises an attention from one pushed event, with no agent cooperation", () => {
    // The whole point of the involuntary channel: no `volli session blocked`,
    // no ticket event, nothing the agent had to choose to do.
    let push: ((notice: HarnessEventNotice) => void) | undefined;
    vi.stubGlobal("window", {
      api: {
        sessions: {
          onHarnessEvent: (callback: (notice: HarnessEventNotice) => void) => {
            push = callback;
            return () => {};
          },
        },
      },
    });
    useSessionsStore
      .getState()
      .addSession(ticketScope("p1", "t1"), "s1", shellLaunch("Implement UI"));
    subscribeHarnessEvents();

    push?.({
      sessionId: "s1",
      projectId: "p1",
      ticketId: "t1",
      harnessId: "claude-code",
      event: "input.needed",
      harnessSessionId: null,
      at: 90_000,
      firedAt: null,
    });

    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: useSessionsStore.getState().byOwner,
      signalsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: useSessionsStore.getState().harness,
      now: 100_000,
    });

    expect(result.active).toMatchObject([
      { title: "Implement UI", activity: "waiting", attention: { signal: "waiting" } },
    ]);
    expect(result.previous).toEqual([]);
  });
});
