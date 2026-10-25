import { describe, expect, it } from "vite-plus/test";

import {
  projectComments,
  projectEvents,
  projectArchived,
  projectBoard,
  projectLabels,
  projectRows,
  type CloudLabelRow,
  type CloudTicketRow,
} from "./projection";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function cloudTicket(n: number, overrides: Partial<CloudTicketRow> = {}): CloudTicketRow {
  return {
    id: `ticket-${n}`,
    projectId: PROJECT,
    number: n,
    title: `Ticket ${n}`,
    status: "todo",
    priority: "medium",
    position: "a0",
    labelIds: [],
    checkoutMode: "worktree",
    preferredHarnessId: "claude-code",
    branch: null,
    baseBranch: null,
    pullRequests: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function label(id: string, name: string, overrides: Partial<CloudLabelRow> = {}): CloudLabelRow {
  return { id, projectId: PROJECT, name, color: null, mergedIntoId: null, ...overrides };
}

describe("the cloud board projection (VC-889)", () => {
  it("orders each column by position then number, and numbers the column from zero", () => {
    const { tickets } = projectBoard(
      {
        tickets: [
          cloudTicket(1, { position: "a2" }),
          cloudTicket(2, { status: "doing", position: "a0" }),
          cloudTicket(3, { position: "a1" }),
          cloudTicket(4, { position: "a1" }),
        ],
        labels: [],
      },
      new Map(),
    );
    expect(tickets.map(({ ticketNumber, status, order }) => [ticketNumber, status, order])).toEqual(
      [
        [3, "todo", 0],
        [4, "todo", 1],
        [1, "todo", 2],
        [2, "doing", 0],
      ],
    );
  });

  it("maps every card field, with paths left to a runner", () => {
    const [ticket] = projectBoard(
      {
        tickets: [
          cloudTicket(7, {
            checkoutMode: "main",
            branch: "volli/VC-7",
            baseBranch: "main",
            pullRequests: [{ url: "https://github.com/o/r/pull/1" }, { url: "https://x/2" }],
            priority: "high",
          }),
        ],
        labels: [],
      },
      new Map([["ticket-7", "the body"]]),
    ).tickets;
    expect(ticket).toEqual({
      id: "ticket-7",
      projectId: PROJECT,
      ticketNumber: 7,
      title: "Ticket 7",
      body: "the body",
      status: "todo",
      priority: "high",
      labels: [],
      usesWorktree: false,
      preferredHarnessId: "claude-code",
      order: 0,
      worktreePath: null,
      branch: "volli/VC-7",
      baseBranch: "main",
      prUrl: "https://github.com/o/r/pull/1",
      createdAt: 1,
      updatedAt: 2,
    });
  });

  it("marks a body this window has not read as a placeholder", () => {
    const board = projectBoard(
      { tickets: [cloudTicket(1), cloudTicket(2)], labels: [] },
      new Map([["ticket-2", ""]]),
    );
    expect(board.unloaded).toEqual(new Set(["ticket-1"]));
    expect(board.tickets.map(({ body }) => body)).toEqual(["", ""]);
    expect(board.tickets[0]!.usesWorktree).toBe(true);
    expect(board.tickets[0]!.prUrl).toBeNull();
  });

  it("wears labels through their merge chains, and lists only live labels", () => {
    const labels = [
      label("old", "old", { mergedIntoId: "new" }),
      label("new", "New", { color: "#ff0000" }),
      label("ui", "ui"),
    ];
    const board = projectBoard(
      { tickets: [cloudTicket(1, { labelIds: ["old", "ui", "new", "gone"] })], labels },
      new Map(),
    );
    expect(board.tickets[0]!.labels).toEqual(["New", "ui"]);
    expect(board.labels).toEqual([
      { id: "new", projectId: PROJECT, name: "New", color: "#ff0000" },
      { id: "ui", projectId: PROJECT, name: "ui", color: null },
    ]);
    expect(projectLabels([])).toEqual([]);
  });

  it("projects an Archive page with no body and its archive time", () => {
    expect(
      projectArchived(
        [
          { ...cloudTicket(1), archivedAt: 50 },
          { ...cloudTicket(2), archivedAt: null },
        ],
        [],
      ).map(({ id, body, archivedAt }) => [id, body, archivedAt]),
    ).toEqual([
      ["ticket-1", "", 50],
      ["ticket-2", "", 0],
    ]);
  });

  it("lists a Workspace's live projects as rail rows with no folder", () => {
    expect(
      projectRows([
        {
          id: "p1",
          name: "Volli",
          ticketPrefix: "VC",
          colorIndex: 2,
          createdAt: 1,
          updatedAt: 2,
          archivedAt: null,
        },
        {
          id: "p2",
          name: "Old",
          ticketPrefix: "OLD",
          colorIndex: 0,
          createdAt: 1,
          updatedAt: 2,
          archivedAt: 9,
        },
        {
          id: "p3",
          name: "Site",
          ticketPrefix: "WEB",
          colorIndex: 1,
          createdAt: 3,
          updatedAt: 4,
          archivedAt: null,
        },
      ]),
    ).toEqual([
      {
        id: "p1",
        name: "Volli",
        path: "",
        ticketPrefix: "VC",
        baseBranch: null,
        colorIndex: 2,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "p3",
        name: "Site",
        path: "",
        ticketPrefix: "WEB",
        baseBranch: null,
        colorIndex: 1,
        sortOrder: 1,
        createdAt: 3,
        updatedAt: 4,
      },
    ]);
  });
});

describe("a ticket's history and comments from Volli Cloud", () => {
  it("keeps the kinds the Activity feed draws, with who did them", () => {
    expect(
      projectEvents([
        {
          id: "e1",
          ticketId: "t1",
          actor: { kind: "person" },
          occurredAt: 10,
          payload: { kind: "created", status: "todo", title: "T" },
        },
        {
          id: "e2",
          ticketId: "t1",
          actor: { kind: "agent", sessionId: "s1" },
          occurredAt: 11,
          payload: { kind: "retitled", from: "T", to: "U" },
        },
        {
          id: "e3",
          ticketId: "t1",
          actor: { kind: "automation", sessionId: "s2", ticketId: "t9" },
          occurredAt: 12,
          payload: { kind: "status_changed", from: "todo", to: "doing" },
        },
        {
          id: "e4",
          ticketId: "t1",
          actor: { kind: "automation" },
          occurredAt: 13,
          payload: { kind: "archived" },
        },
        // Left out: a kind this window does not draw, a project fact, a payload with no kind.
        {
          id: "e5",
          ticketId: "t1",
          actor: { kind: "volli" },
          occurredAt: 14,
          payload: { kind: "session_failed" },
        },
        { id: "e6", ticketId: null, actor: { kind: "person" }, occurredAt: 15, payload: {} },
        { id: "e7", ticketId: "t1", actor: { kind: "person" }, occurredAt: 16, payload: null },
      ]),
    ).toEqual([
      {
        id: "e1",
        ticketId: "t1",
        actor: "user",
        actorContext: null,
        createdAt: 10,
        payload: { kind: "created", status: "todo", title: "T" },
      },
      {
        id: "e2",
        ticketId: "t1",
        actor: "session",
        actorContext: { sessionId: "s1", ticketId: "t1" },
        createdAt: 11,
        payload: { kind: "retitled", from: "T", to: "U" },
      },
      {
        id: "e3",
        ticketId: "t1",
        actor: "automation",
        actorContext: { sessionId: "s2", ticketId: "t9" },
        createdAt: 12,
        payload: { kind: "status_changed", from: "todo", to: "doing" },
      },
      {
        id: "e4",
        ticketId: "t1",
        actor: "automation",
        actorContext: null,
        createdAt: 13,
        payload: { kind: "archived" },
      },
    ]);
  });

  it("projects comments, a person's as the user's and an edit as the update time", () => {
    expect(
      projectComments([
        {
          id: "c1",
          ticketId: "t1",
          sessionId: null,
          author: { kind: "person" },
          body: "hi",
          createdAt: 1,
          editedAt: null,
        },
        {
          id: "c2",
          ticketId: "t1",
          sessionId: "s1",
          author: { kind: "agent", sessionId: "s1" },
          body: "done",
          createdAt: 2,
          editedAt: 5,
        },
      ]),
    ).toEqual([
      {
        id: "c1",
        ticketId: "t1",
        sessionId: null,
        actor: "user",
        body: "hi",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "c2",
        ticketId: "t1",
        sessionId: "s1",
        actor: "agent:pi",
        body: "done",
        createdAt: 2,
        updatedAt: 5,
      },
    ]);
  });
});
