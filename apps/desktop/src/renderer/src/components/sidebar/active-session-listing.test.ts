import type { Ticket, TicketEvent } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { buildActiveSessionListing } from "./active-session-listing";

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
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 1,
  };
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
});
