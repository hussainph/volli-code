import type { SessionRecord, Ticket, TicketEvent } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { buildActiveSessionListing, SETTLED_RECENCY_MS } from "./active-session-listing";

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
    harnessSessionId: overrides.harnessSessionId ?? null,
    launchKind: overrides.launchKind ?? "agent",
    placement: overrides.placement ?? "tab",
    title: overrides.title ?? "Session",
    cwd: overrides.cwd ?? "/tmp",
    createdAt: overrides.createdAt ?? 1,
    endedAt: overrides.endedAt ?? null,
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
  it("lists every live tab on a Doing ticket as its own in-progress destination", () => {
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
      now: 100_000,
    });

    expect(result.needsYou).toEqual([]);
    expect(result.settled).toEqual([]);
    expect(result.inProgress.map((row) => ({ title: row.title, target: row.target }))).toEqual([
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
      now: 100_000,
    });

    expect(result.needsYou).toMatchObject([
      {
        title: "Agent review",
        attention: { signal: "blocked", reason: "Approve access" },
        target: { tabId: "s2", paneId: "s2" },
      },
    ]);
    expect(result.inProgress.map((row) => row.title)).toEqual(["Keep building"]);
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
      now: 100_000,
    });

    expect(result.needsYou.map((row) => ({ title: row.title, target: row.target }))).toEqual([
      { title: "Current tab", target: { tabId: "s2", paneId: "s2" } },
      { title: "Review finished work", target: null },
    ]);
    expect(result.inProgress.map((row) => row.title)).toEqual(["Earlier tab"]);
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
      now: 100,
    });

    expect(result.needsYou[0]).toMatchObject({
      attention: { signal: "blocked", reason: "Choose an option" },
      target: { tabId: "root", paneId: "split" },
    });
  });

  it("orders live work by activity and excludes fully exited tabs", () => {
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
      now: 100_000,
    });

    expect(result.inProgress.map((row) => `${row.title}:${row.activity}`)).toEqual([
      "Working:working",
      "Idle:idle",
      "Parked:parked",
    ]);
  });

  it("surfaces a doing ticket's ended session in the settled tail as a resume seed", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {},
      eventsByTicket: {},
      records: [
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
      now,
    });

    expect(result.needsYou).toEqual([]);
    expect(result.inProgress).toEqual([]);
    expect(result.settled).toMatchObject([
      {
        title: "Claude run",
        outcome: "ended",
        resumable: true,
        target: null,
        endedAt: now - 1_000,
      },
    ]);
  });

  it("labels settled outcome from a still-mounted exited pane and orders by recency", () => {
    const now = 1_000_000;
    const result = buildActiveSessionListing({
      tickets: [ticket({ id: "t1", status: "doing" })],
      containers: {
        t1: container("failed", [
          paneTab("failed", "Broke the build", 1),
          paneTab("clean", "Finished cleanly", 0),
        ]),
      },
      eventsByTicket: {},
      records: [
        record({ id: "failed", ticketId: "t1", title: "Broke the build", endedAt: now - 5_000 }),
        record({ id: "clean", ticketId: "t1", title: "Finished cleanly", endedAt: now - 1_000 }),
      ],
      lastOutputAt: {},
      parkState: {},
      now,
    });

    // Recency desc: the clean exit (more recent) sorts above the failure.
    expect(
      result.settled.map((row) => ({ title: row.title, outcome: row.outcome, target: row.target })),
    ).toEqual([
      { title: "Finished cleanly", outcome: "done", target: { tabId: "clean", paneId: "clean" } },
      {
        title: "Broke the build",
        outcome: "failed",
        target: { tabId: "failed", paneId: "failed" },
      },
    ]);
    expect(result.inProgress).toEqual([]);
  });

  it("excludes split panes, done-ticket sessions, and stale records from the settled tail", () => {
    const now = 10_000_000;
    const result = buildActiveSessionListing({
      tickets: [
        ticket({ id: "t1", status: "doing" }),
        ticket({ id: "t2", status: "done", ticketNumber: 2 }),
      ],
      containers: {},
      eventsByTicket: {},
      records: [
        record({ id: "fresh", ticketId: "t1", title: "Fresh", endedAt: now - 1_000 }),
        record({
          id: "split",
          ticketId: "t1",
          title: "Split pane",
          placement: "split",
          endedAt: now - 1_000,
        }),
        record({
          id: "done-ticket",
          ticketId: "t2",
          title: "On a done ticket",
          endedAt: now - 1_000,
        }),
        record({
          id: "stale",
          ticketId: "t1",
          title: "Long gone",
          endedAt: now - SETTLED_RECENCY_MS - 1,
        }),
        record({ id: "live", ticketId: "t1", title: "Still running", endedAt: null }),
      ],
      lastOutputAt: {},
      parkState: {},
      now,
    });

    expect(result.settled.map((row) => row.title)).toEqual(["Fresh"]);
  });

  it("keeps a promoted Needs Review attention session out of the settled tail", () => {
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
      now,
    });

    expect(result.needsYou).toMatchObject([
      { title: "Agent", attention: { signal: "blocked", reason: "Approve" } },
    ]);
    expect(result.settled).toEqual([]);
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
      now,
    });

    expect(result.needsYou.map((row) => row.title)).toEqual([
      "Blocked session",
      "Done session",
      "Bare review",
    ]);
  });
});
