import { NO_AUTOMATION_TRIGGER, PERSON_STARTED } from "@volli/shared";
import type {
  Automation,
  ChatSessionRecord,
  Project,
  SessionProvenance,
  Ticket,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAutomationRunItems,
  buildCommandPaletteItems,
  buildEditorCommandItems,
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

  // The palette is the app's one GLOBAL Session listing — every project's, in
  // one list — so it is the surface where a Run's Session is likeliest to be
  // taken for one a person opened. "Everywhere a Session appears" includes it
  // (VC-131).
  describe("who started each listed Session", () => {
    const RUN: SessionProvenance = { kind: "automation", automationName: "Nightly sweep" };
    const CHILD: SessionProvenance = {
      kind: "session",
      parentSessionId: "session-parent",
      parentTitle: "Orchestrator",
    };

    it("carries provenance onto both kinds of row from one sparse map", () => {
      const alpha = project("p1", "Alpha", "ALP");
      const linked = ticket("t1", alpha.id, 1, "Fix auth", 10);

      const result = buildCommandPaletteItems(
        [alpha],
        { [alpha.id]: [linked] },
        {
          [linked.id]: container({
            sessionId: "s1",
            title: "Nightly sweep",
            scope: ticketScope(alpha.id, linked.id),
            layout: { kind: "pane", sessionId: "s1", exitCode: null },
            activePaneId: "s1",
          }),
        },
        alpha.id,
        [chat()],
        {},
        { s1: RUN, "chat-1": CHILD },
      );

      // A terminal row reaches this list through the open-tab store, which
      // carries no provenance of its own — so the two kinds must be answered
      // from the same map or one of them can never be marked.
      expect(result.sessions.find((item) => item.sessionId === "s1")?.provenance).toEqual(RUN);
      expect(result.sessions.find((item) => item.sessionId === "chat-1")?.provenance).toEqual(
        CHILD,
      );
    });

    // The holes ARE the answer, and the resting answer is the one frozen
    // constant: a palette full of person-started Sessions allocates nothing and
    // draws nothing.
    it("reads a Session the map says nothing about as person-started, by identity", () => {
      const alpha = project("p1", "Alpha", "ALP");
      const linked = ticket("t1", alpha.id, 1, "Fix auth", 10);

      const result = buildCommandPaletteItems([alpha], { [alpha.id]: [linked] }, {}, alpha.id, [
        chat(),
      ]);

      expect(result.sessions[0]?.provenance).toBe(PERSON_STARTED);
    });
  });
});

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    projectId: "p1",
    name: "Review",
    instructions: "/review go",
    trigger: NO_AUTOMATION_TRIGGER,
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

describe("buildEditorCommandItems", () => {
  it("offers Go to Line when an editor is on screen to answer it", () => {
    expect(buildEditorCommandItems(true)).toEqual([
      {
        kind: "editor-command",
        id: "go-to-line",
        title: "Go to Line…",
        hint: "In the editor you were last in",
      },
    ]);
  });

  it("offers nothing when no editor is open", () => {
    // A row that opened a line prompt over no document would be a lie the
    // palette tells before the user even presses it.
    expect(buildEditorCommandItems(false)).toEqual([]);
  });
});
