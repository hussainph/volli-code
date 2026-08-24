import type { Automation, ChatSessionRecord, Project, Ticket } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAutomationRunItems,
  buildCommandPaletteItems,
  paletteRunContext,
} from "./command-palette-model";
import { projectScope, ticketScope, type SessionContainer } from "@renderer/stores/sessions";

function project(id: string, name: string, ticketPrefix: string): Project {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    ticketPrefix,
    colorIndex: 0,
    sortOrder: 0,
    baseBranch: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function ticket(
  id: string,
  projectId: string,
  number: number,
  title: string,
  updatedAt: number,
): Ticket {
  return {
    id,
    projectId,
    ticketNumber: number,
    title,
    body: "",
    status: "todo",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    order: 0,
    createdAt: 0,
    updatedAt,
  };
}

function container(...tabs: SessionContainer["tabs"]): SessionContainer {
  return { tabs, activeSessionId: tabs[0]?.sessionId ?? null };
}

function chat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: "chat-1",
    title: "Plan the migration",
    projectId: "p1",
    ticketId: "t1",
    createdAt: 0,
    adapterId: "pi",
    live: true,
    activity: "idle",
    waitingOn: null,
    lastActivityAt: 0,
    bornTicketless: false,
    ...overrides,
  };
}

describe("buildCommandPaletteItems", () => {
  it("lists every ticket with current-project and recency ordering", () => {
    const alpha = project("p1", "Alpha", "ALP");
    const beta = project("p2", "Beta", "BET");
    const old = ticket("t1", alpha.id, 1, "Old", 10);
    const recent = ticket("t2", beta.id, 2, "Recent", 50);

    const result = buildCommandPaletteItems(
      [alpha, beta],
      { [alpha.id]: [old], [beta.id]: [recent] },
      {},
      alpha.id,
    );

    expect(result.tickets.map((item) => `${item.displayId}:${item.title}`)).toEqual([
      "ALP-1:Old",
      "BET-2:Recent",
    ]);
  });

  it("lists multiple live tabs per ticket plus Project Sessions", () => {
    const alpha = project("p1", "Alpha", "ALP");
    const linked = ticket("t1", alpha.id, 1, "Fix auth", 10);
    const scope = ticketScope(alpha.id, linked.id);

    const result = buildCommandPaletteItems(
      [alpha],
      { [alpha.id]: [linked] },
      {
        [linked.id]: container(
          {
            sessionId: "s1",
            title: "Claude review",
            scope,
            layout: { kind: "pane", sessionId: "s1", exitCode: null },
            activePaneId: "s1",
          },
          {
            sessionId: "s2",
            title: "Test runner",
            scope,
            layout: { kind: "pane", sessionId: "s2", exitCode: null },
            activePaneId: "s2",
          },
        ),
        [alpha.id]: container({
          sessionId: "project-session",
          title: "Project terminal",
          scope: projectScope(alpha.id),
          layout: { kind: "pane", sessionId: "project-session", exitCode: null },
          activePaneId: "project-session",
        }),
      },
      alpha.id,
    );

    expect(result.sessions.map((item) => item.title)).toEqual([
      "Claude review",
      "Project terminal",
      "Test runner",
    ]);
    expect(result.sessions.find((item) => item.sessionId === "s1")?.ticketDisplayId).toBe("ALP-1");
    expect(
      result.sessions.find((item) => item.sessionId === "project-session")?.ticketDisplayId,
    ).toBeNull();
  });

  it("adds durable chats and overlays a title that just changed in a resident client", () => {
    const alpha = project("p1", "Alpha", "ALP");
    const linked = ticket("t1", alpha.id, 1, "Fix auth", 10);

    const result = buildCommandPaletteItems(
      [alpha],
      { [alpha.id]: [linked] },
      {},
      alpha.id,
      [chat()],
      { "chat-1": "Validate ALP-1" },
    );

    expect(result.sessions).toEqual([
      expect.objectContaining({
        sessionId: "chat-1",
        sessionKind: "chat",
        title: "Validate ALP-1",
        ticketDisplayId: "ALP-1",
      }),
    ]);
  });

  it("drops stale session scopes whose project or ticket no longer exists", () => {
    const alpha = project("p1", "Alpha", "ALP");
    const stale = ticketScope(alpha.id, "missing-ticket");
    const result = buildCommandPaletteItems(
      [alpha],
      { [alpha.id]: [] },
      {
        stale: container({
          sessionId: "stale",
          title: "Stale",
          scope: stale,
          layout: { kind: "pane", sessionId: "stale", exitCode: null },
          activePaneId: "stale",
        }),
      },
      alpha.id,
    );
    expect(result.sessions).toEqual([]);
  });
});

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    projectId: "p1",
    name: "Review",
    instructions: "/review go",
    runtime: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("paletteRunContext", () => {
  it("resolves the open Ticket against the live board, with its display id", () => {
    const alpha = project("p1", "Alpha", "ALP");
    const open = ticket("t1", "p1", 12, "Live ticket", 0);
    expect(paletteRunContext("t1", alpha, [open])).toEqual({
      ticketId: "t1",
      displayId: "ALP-12",
    });
  });

  it("offers nothing without an open Ticket, a project, or a live board row for it", () => {
    const alpha = project("p1", "Alpha", "ALP");
    const foreign = ticket("t2", "other", 3, "Foreign", 0);
    expect(paletteRunContext(null, alpha, [])).toBeNull();
    expect(paletteRunContext("t1", null, [])).toBeNull();
    expect(paletteRunContext("t1", alpha, [])).toBeNull();
    expect(paletteRunContext("t2", alpha, [foreign])).toBeNull();
  });
});

describe("buildAutomationRunItems", () => {
  it("offers every listed Automation against the open Ticket, keeping main's order", () => {
    const rows = buildAutomationRunItems(
      [automation(), automation({ id: "automation-2", projectId: null, name: "Global TDD" })],
      { ticketId: "t1", displayId: "ALP-12" },
    );
    expect(rows).toEqual([
      {
        kind: "automation-run",
        automationId: "automation-1",
        name: "Review",
        ownership: "project",
        ticketId: "t1",
        ticketDisplayId: "ALP-12",
      },
      {
        kind: "automation-run",
        automationId: "automation-2",
        name: "Global TDD",
        ownership: "global",
        ticketId: "t1",
        ticketDisplayId: "ALP-12",
      },
    ]);
  });

  it("offers no run rows without a target Ticket", () => {
    expect(buildAutomationRunItems([automation()], null)).toEqual([]);
  });
});
