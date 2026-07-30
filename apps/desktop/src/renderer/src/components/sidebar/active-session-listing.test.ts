import {
  createSessionHarnessState,
  HARNESS_EVENT_GRACE_MS,
  receiveHarnessEvent,
  type CreateSessionHarnessStateInput,
  type HarnessEvent,
  type HarnessEventNotice,
  type SessionHarnessState,
  type SessionRecord,
  type Ticket,
  type TicketEvent,
} from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  subscribeHarnessEvents,
  ticketScope,
  useSessionsStore,
  type SessionLaunch,
} from "../../stores/sessions";

import { buildActiveSessionListing } from "./active-session-listing";

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

describe("buildActiveSessionListing", () => {
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
      eventsByTicket: {},
      records: [],
      lastOutputAt: { s1: 99_000 },
      parkState: {},
      harness: {},
      now: 100_000,
    });

    expect(result.needsYou).toEqual([]);
    expect(result.active.map((row) => ({ title: row.title, target: row.target }))).toEqual([
      { title: "Implement UI", target: { tabId: "s1", paneId: "s1" } },
      { title: "Run checks", target: { tabId: "s2", paneId: "s2" } },
    ]);
  });

  it("routes the latest Needs Review signal to its exact session while keeping sibling tabs active", () => {
    const signal: TicketEvent = {
      id: "e1",
      ticketId: "t1",
      actor: "automation",
      actorContext: { ticketId: "t1", sessionId: "s2" },
      createdAt: 80_000,
      payload: { kind: "session_signal", signal: "blocked", reason: "Approve access" },
    };
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
      eventsByTicket: { t1: [signal] },
      records: [],
      lastOutputAt: { s1: 99_000 },
      parkState: {},
      harness: {},
      now: 100_000,
    });

    expect(result.needsYou).toMatchObject([
      {
        title: "Agent review",
        attention: { signal: "blocked", reason: "Approve access" },
        target: { tabId: "s2", paneId: "s2" },
      },
    ]);
    expect(result.active.map((row) => row.title)).toEqual(["Keep building"]);
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
      eventsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 100_000,
    });

    expect(result.needsYou.map((row) => ({ title: row.title, target: row.target }))).toEqual([
      { title: "Current tab", target: { tabId: "s2", paneId: "s2" } },
      { title: "Review finished work", target: null },
    ]);
    expect(result.active.map((row) => row.title)).toEqual(["Earlier tab"]);
  });

  it("maps the latest signal from a split pane back to its containing tab and exact pane", () => {
    const older: TicketEvent = {
      id: "old",
      ticketId: "t1",
      actor: "automation",
      actorContext: { ticketId: "t1", sessionId: "root" },
      createdAt: 10,
      payload: { kind: "session_signal", signal: "done", reason: null },
    };
    const latest: TicketEvent = {
      id: "latest",
      ticketId: "t1",
      actor: "automation",
      actorContext: { ticketId: "t1", sessionId: "split" },
      createdAt: 20,
      payload: { kind: "session_signal", signal: "blocked", reason: "Choose an option" },
    };
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
      eventsByTicket: { t1: [older, latest] },
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 100,
    });

    expect(result.needsYou[0]).toMatchObject({
      attention: { signal: "blocked", reason: "Choose an option" },
      target: { tabId: "root", paneId: "split" },
    });
  });

  it("orders live work by activity and folds fully exited tabs into one concluded row", () => {
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
      eventsByTicket: {},
      records: [],
      lastOutputAt: { working: 99_000 },
      parkState: { parked: { parked: true, keepAwake: false } },
      harness: {},
      now: 100_000,
    });

    // The exited tab produces no row of its own: the ticket has live work, so
    // the tier already mirrors the board without a concluded fallback.
    expect(result.active.map((row) => `${row.title}:${row.activity}`)).toEqual([
      "Working:working",
      "Idle:idle",
      "Parked:parked",
    ]);
  });

  it("keeps a Doing ticket visible after relaunch as a record-backed resume row", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      eventsByTicket: {},
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
    // and a not-yet-ended record is not a concluded run.
    //
    // `resumable` is true here with no `harnessSessionId`, and that is the fix:
    // the badge used to test the seed alone, so it hid Resume for every claude
    // session that had never reported an id — while the rail, asking
    // `canResumeSession`, offered it. Claude resumes latest-in-cwd without a
    // seed. Both surfaces now ask the one predicate.
    expect(result.needsYou).toEqual([]);
    expect(result.active).toMatchObject([
      {
        title: "Claude run",
        activity: null,
        lastRun: { outcome: "ended", endedAt: now - 1_000, resumable: true },
        target: null,
      },
    ]);
  });

  it("prefers a still-mounted exited tab for the fallback row and labels its outcome", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {
        t1: container("quit", [
          paneTab("clean", "Finished cleanly", 0),
          paneTab("quit", "Quit the agent", 1),
        ]),
      },
      eventsByTicket: {},
      records: [
        record({ id: "quit", ticketId: "t1", title: "Quit the agent", endedAt: now - 5_000 }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // One row per concluded ticket: the container's active tab, reopenable in
    // place, with the outcome read from its exited pane.
    expect(result.active).toMatchObject([
      {
        title: "Quit the agent",
        lastRun: { outcome: "ended", endedAt: now - 5_000, resumable: true },
        target: { tabId: "quit", paneId: "quit" },
      },
    ]);
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
      eventsByTicket: {},
      records: [
        record({ id: "s1", ticketId: "t1", title: "Quit the agent", endedAt: now - 1_000 }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.active).toMatchObject([
      { lastRun: { outcome: "ended", endedAt: now - 1_000, resumable: true } },
    ]);
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
      eventsByTicket: {},
      records: [
        record({ id: "s1", ticketId: "t1", title: "Closed the tab", endedAt: now - 1_000 }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.active).toMatchObject([
      { lastRun: { outcome: "ended", endedAt: now - 1_000, resumable: true } },
    ]);
  });

  it("calls only a clean record exit code done and orders concluded rows after live ones by recency", () => {
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
      eventsByTicket: {},
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

    // Done-column tickets contribute nothing; concluded Doing rows trail the
    // live one, most recently ended first.
    expect(
      result.active.map((row) => ({ title: row.title, outcome: row.lastRun?.outcome ?? null })),
    ).toEqual([
      { title: "Live agent", outcome: null },
      { title: "Nonzero run", outcome: "ended" },
      { title: "Clean run", outcome: "done" },
    ]);
  });

  it("gives a Doing ticket with no sessions at all a bare presence row", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing", title: "Just moved here" })],
      containers: {},
      eventsByTicket: {},
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

  it("gives a promoted Needs Review attention session no duplicate active row", () => {
    const now = 1_000_000;
    const signal: TicketEvent = {
      id: "e1",
      ticketId: "t1",
      actor: "automation",
      actorContext: { ticketId: "t1", sessionId: "s1" },
      createdAt: now - 2_000,
      payload: { kind: "session_signal", signal: "blocked", reason: "Approve" },
    };
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "needs_review" })],
      containers: {
        t1: container("s1", [paneTab("s1", "Agent", 1)]),
      },
      eventsByTicket: { t1: [signal] },
      records: [record({ id: "s1", ticketId: "t1", title: "Agent", endedAt: now - 1_000 })],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.needsYou).toMatchObject([
      { title: "Agent", attention: { signal: "blocked", reason: "Approve" } },
    ]);
    expect(result.active).toEqual([]);
  });

  it("ignores a non-signal event and follows the true latest signal by timestamp, not array order", () => {
    const newerButFirst: TicketEvent = {
      id: "newer",
      ticketId: "t1",
      actor: "automation",
      actorContext: { ticketId: "t1", sessionId: "s1" },
      createdAt: 50,
      payload: { kind: "session_signal", signal: "blocked", reason: "Approve access" },
    };
    const olderButSecond: TicketEvent = {
      id: "older",
      ticketId: "t1",
      actor: "automation",
      actorContext: { ticketId: "t1", sessionId: "s1" },
      createdAt: 10,
      payload: { kind: "session_signal", signal: "done", reason: null },
    };
    const unrelated: TicketEvent = {
      id: "comment",
      ticketId: "t1",
      actor: "user",
      createdAt: 999,
      payload: { kind: "commented", commentId: "c1" },
    };
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "needs_review" })],
      containers: { t1: container("s1", [paneTab("s1", "Agent review")]) },
      eventsByTicket: { t1: [newerButFirst, olderButSecond, unrelated] },
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 100,
    });

    // The non-signal event is skipped entirely, and the earlier-in-array signal
    // never overwrites the later-timestamped one it follows.
    expect(result.needsYou[0]).toMatchObject({
      attention: { signal: "blocked", reason: "Approve access" },
    });
  });

  it("keeps the truly most-recent resume record even when it is not last in the array", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      eventsByTicket: {},
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
  });

  it("falls back to the record's exit code when the mounted tab's active pane id no longer resolves", () => {
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
      eventsByTicket: {},
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

    // The tab's own layout can't answer (its active pane id is stale), so the
    // outcome is read from the ticket's durable record instead. A clean record
    // code is what proves that hop happened: every other code now lands on the
    // same `ended` as having no code at all.
    expect(result.active).toMatchObject([
      {
        lastRun: { outcome: "done", endedAt: now - 5_000, resumable: true },
        target: { tabId: "s1", paneId: "stale-pane" },
      },
    ]);
  });

  it("gives an honest unknown outcome when neither the tab's layout nor a record can say how it ended", () => {
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
      eventsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now: 1_000_000,
    });

    // Neither the (unresolvable) pane nor a durable record has an exit code to
    // offer, so the row says "ended" rather than guessing it finished cleanly.
    expect(result.active).toMatchObject([
      { lastRun: { outcome: "ended", endedAt: null, resumable: false } },
    ]);
  });

  it("orders two concluded fallback rows by recency even when one has no matching record yet", () => {
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
      eventsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    // Both rows are concluded fallbacks with no ended time of their own to sort
    // by — one from a mounted tab whose record hasn't landed yet, the other
    // with no session at all — so both must fall back to the ticket's own
    // recency instead of crashing or silently tying.
    expect(result.active.map((row) => row.title)).toEqual(["Recently exited", "Long untouched"]);
  });

  it("orders needsYou blocked before done before a bare review prompt", () => {
    const now = 1_000_000;
    const blocked: TicketEvent = {
      id: "b",
      ticketId: "t-blocked",
      actor: "automation",
      actorContext: { ticketId: "t-blocked", sessionId: "sb" },
      createdAt: now - 100,
      payload: { kind: "session_signal", signal: "blocked", reason: null },
    };
    const done: TicketEvent = {
      id: "d",
      ticketId: "t-done",
      actor: "automation",
      actorContext: { ticketId: "t-done", sessionId: "sd" },
      createdAt: now - 100,
      payload: { kind: "session_signal", signal: "done", reason: null },
    };
    const result = buildActiveSessionListing({
      tickets: [
        ticket({ id: "t-done", status: "needs_review", ticketNumber: 1, title: "Done work" }),
        ticket({ id: "t-bare", status: "needs_review", ticketNumber: 2, title: "Bare review" }),
        ticket({ id: "t-blocked", status: "needs_review", ticketNumber: 3, title: "Blocked work" }),
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
      eventsByTicket: { "t-blocked": [blocked], "t-done": [done] },
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: {},
      now,
    });

    expect(result.needsYou.map((row) => row.title)).toEqual([
      "Blocked session",
      "Done session",
      "Bare review",
    ]);
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
  it("moves a Doing ticket whose agent is blocked on a human into Needs you", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: { t1: container("s1", [paneTab("s1", "Implement UI")]) },
      eventsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: { s1: reporting("input.needed") },
      now: 100_000,
    });

    expect(result.needsYou.map((row) => ({ title: row.title, activity: row.activity }))).toEqual([
      { title: "Implement UI", activity: "waiting" },
    ]);
    expect(result.active).toEqual([]);
  });

  it("shows a Needs Review ticket's hook-declared wait as its attention when no CLI signal exists", () => {
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "needs_review" })],
      containers: { t1: container("s1", [paneTab("s1", "Agent review")]) },
      eventsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: { s1: reporting("input.needed") },
      now: 100_000,
    });

    // No `volli session` signal was ever sent, so the involuntary hook channel
    // is the only source of attention here.
    expect(result.needsYou).toMatchObject([
      { title: "Agent review", attention: { signal: "waiting", reason: null } },
    ]);
  });

  it("keeps a cursor session out of Needs you even when something claims it is blocked", () => {
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
      eventsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: { s1: cursor },
      now: 100_000,
    });

    expect(result.needsYou).toEqual([]);
    expect(result.active.map((row) => row.activity)).toEqual(["idle"]);
  });

  it("lets the agent's own blocked signal outrank a hook-declared wait", () => {
    const signal: TicketEvent = {
      id: "e1",
      ticketId: "t2",
      actor: "session",
      actorContext: { ticketId: "t2", sessionId: "s2" },
      createdAt: 80_000,
      payload: { kind: "session_signal", signal: "blocked", reason: "Approve the deploy" },
    };
    const result = buildActiveSessionListing({
      tickets: [
        // The waiting one is the more recently touched, so only priority can
        // put the blocked one first.
        ticket({ id: "t1", status: "doing", ticketNumber: 1, updatedAt: 90_000 }),
        ticket({ id: "t2", status: "needs_review", ticketNumber: 2, updatedAt: 10_000 }),
      ],
      containers: {
        t1: container("s1", [paneTab("s1", "Implement UI")]),
        t2: container("s2", [paneTab("s2", "Ship it")]),
      },
      eventsByTicket: { t2: [signal] },
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: { s1: reporting("input.needed") },
      now: 100_000,
    });

    // Both need a human; the one that can say WHY it needs one comes first.
    expect(result.needsYou.map((row) => row.attention)).toEqual([
      { signal: "blocked", reason: "Approve the deploy" },
      { signal: "waiting", reason: null },
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
      eventsByTicket: {},
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
      eventsByTicket: {},
      records: [
        record({ id: "s1", ticketId: "t1", launchKind: "shell", placement: "split" }),
        record({ id: "s2", ticketId: "t1", launchKind: "agent" }),
      ],
      lastOutputAt: {},
      parkState: {},
      harness: { s2: reporting("input.needed") },
      now: 100_000,
    });

    expect(result.needsYou).toMatchObject([
      {
        activity: "waiting",
        // Previously "inferred", read off the shell in front — the row claimed
        // a harness-declared wait and denied that anything was reporting.
        activitySource: "reported",
        source: "Claude Code",
        target: { tabId: "s1", paneId: "s2" },
      },
    ]);
    expect(result.active).toEqual([]);
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
        eventsByTicket: {},
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
      eventsByTicket: {},
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

  it("fills Needs you from one pushed event, with no agent cooperation", () => {
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
      eventsByTicket: {},
      records: [],
      lastOutputAt: {},
      parkState: {},
      harness: useSessionsStore.getState().harness,
      now: 100_000,
    });

    expect(result.needsYou).toMatchObject([
      { title: "Implement UI", activity: "waiting", attention: { signal: "waiting" } },
    ]);
    expect(result.active).toEqual([]);
  });
});
