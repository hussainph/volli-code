import { NO_AUTOMATION_TRIGGER, PERSON_STARTED } from "@volli/shared";
import type {
  Automation,
  ChatSessionRecord,
  Project,
  SessionProvenance,
  SessionRecord,
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

function terminal(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    id: overrides.id,
    projectId: overrides.projectId ?? "p1",
    ticketId: overrides.ticketId ?? null,
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "agent",
    placement: overrides.placement ?? "tab",
    title: overrides.title ?? "Session 2",
    cwd: "/repo",
    createdAt: 0,
    endedAt: overrides.endedAt === undefined ? 5_000 : overrides.endedAt,
    exitCode: overrides.exitCode ?? null,
    lastActivityAt: 5_000,
    bornTicketless: overrides.bornTicketless ?? (overrides.ticketId ?? null) === null,
  };
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
    outcome: null,
    lastActivityAt: 0,
    bornTicketless: false,
    role: "ticket",
    parentSessionId: null,
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

  it("lists multiple live tabs per ticket plus Board Sessions", () => {
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

  /**
   * ⌘K fetched every project's saved Session rows and then dropped every closed
   * terminal among them, so a terminal you closed this morning was unfindable
   * in the app's one global search (VC-290). It is now a row — pointed at its
   * saved record, which is the only thing left to open.
   */
  describe("closed terminals", () => {
    const alpha = project("p1", "Alpha", "ALP");
    const linked = ticket("t1", alpha.id, 1, "Fix auth", 10);

    it("lists a closed ticket terminal, addressed to its saved record", () => {
      const result = buildCommandPaletteItems(
        [alpha],
        { [alpha.id]: [linked] },
        {},
        alpha.id,
        [],
        {},
        {},
        [terminal({ id: "s1", ticketId: linked.id, title: "Session 2" })],
      );

      expect(result.sessions).toEqual([
        expect.objectContaining({
          sessionId: "s1",
          sessionKind: "terminal",
          title: "Session 2",
          destination: "detail",
          ticketDisplayId: "ALP-1",
          ticketTitle: "Fix auth",
        }),
      ]);
    });

    it("lists a closed project terminal too", () => {
      const result = buildCommandPaletteItems(
        [alpha],
        { [alpha.id]: [] },
        {},
        alpha.id,
        [],
        {},
        {},
        [terminal({ id: "s1", ticketId: null, title: "Poke at the repo" })],
      );

      expect(result.sessions).toEqual([
        expect.objectContaining({
          sessionId: "s1",
          destination: "detail",
          scope: projectScope(alpha.id),
          ticketDisplayId: null,
        }),
      ]);
    });

    // An open tab is still the live terminal; its record is the same Session
    // seen from the durable side, and two rows for one Session would make the
    // reader choose between a terminal and a description of it.
    it("keeps the open tab as the destination for a terminal that is still open", () => {
      const result = buildCommandPaletteItems(
        [alpha],
        { [alpha.id]: [linked] },
        {
          [linked.id]: container({
            sessionId: "s1",
            title: "Live tab title",
            scope: ticketScope(alpha.id, linked.id),
            layout: { kind: "pane", sessionId: "s1", exitCode: null },
            activePaneId: "s1",
          }),
        },
        alpha.id,
        [],
        {},
        {},
        [terminal({ id: "s1", ticketId: linked.id, title: "Stale record title", endedAt: null })],
      );

      expect(result.sessions).toEqual([
        expect.objectContaining({ sessionId: "s1", title: "Live tab title", destination: "tab" }),
      ]);
    });

    it("omits a live record with no tab, which is a Session this window cannot show", () => {
      const result = buildCommandPaletteItems(
        [alpha],
        { [alpha.id]: [linked] },
        {},
        alpha.id,
        [],
        {},
        {},
        [terminal({ id: "s1", ticketId: linked.id, endedAt: null })],
      );

      expect(result.sessions).toEqual([]);
    });

    // A split pane is part of a tab, never a destination of its own — the same
    // rule the sidebar's Previous band applies to the same records.
    it("omits a closed split pane", () => {
      const result = buildCommandPaletteItems(
        [alpha],
        { [alpha.id]: [linked] },
        {},
        alpha.id,
        [],
        {},
        {},
        [terminal({ id: "s1", ticketId: linked.id, placement: "split" })],
      );

      expect(result.sessions).toEqual([]);
    });

    it("drops a closed terminal only when its project is no longer tracked", () => {
      const result = buildCommandPaletteItems(
        [alpha],
        { [alpha.id]: [linked] },
        {},
        alpha.id,
        [],
        {},
        {},
        [terminal({ id: "s1", projectId: "gone", ticketId: null })],
      );

      expect(result.sessions).toEqual([]);
    });

    it("keeps an unavailable Ticket Session without relabelling it as project-scoped", () => {
      const result = buildCommandPaletteItems(
        [alpha],
        { [alpha.id]: [linked] },
        {},
        alpha.id,
        [],
        {},
        {},
        [
          terminal({ id: "s1", ticketId: "missing-ticket", bornTicketless: false }),
          // The database uses ON DELETE SET NULL, so this is the ordinary
          // deleted-ticket shape: only the immutable birth fact survives.
          terminal({ id: "s2", ticketId: null, bornTicketless: false }),
        ],
      );

      expect(result.sessions).toEqual([
        expect.objectContaining({ sessionId: "s1", scope: { kind: "unavailable" } }),
        expect.objectContaining({ sessionId: "s2", scope: { kind: "unavailable" } }),
      ]);
    });

    it("marks a closed terminal a Run started, like every other row", () => {
      const RUN: SessionProvenance = { kind: "automation", automationName: "Nightly sweep" };
      const result = buildCommandPaletteItems(
        [alpha],
        { [alpha.id]: [linked] },
        {},
        alpha.id,
        [],
        {},
        { s1: RUN },
        [terminal({ id: "s1", ticketId: linked.id })],
      );

      expect(result.sessions[0]?.provenance).toEqual(RUN);
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
