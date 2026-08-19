import { describe, expect, it } from "vite-plus/test";
import type { ChatSessionRecord, SessionHarnessState } from "@volli/shared";

import {
  buildBoardSessionActivity,
  type BuildBoardSessionActivityInput,
} from "./board-session-activity";
import { WORKING_WINDOW_MS, type SessionContainer } from "../../stores/sessions";

const NOW = 1_000_000;

function pane(sessionId: string, exitCode: number | null = null) {
  return { kind: "pane" as const, sessionId, exitCode };
}

function container(...sessionIds: string[]): SessionContainer {
  return {
    tabs: sessionIds.map((sessionId) => ({
      sessionId,
      title: sessionId,
      scope: { kind: "ticket" as const, projectId: "p1", ticketId: "t1" },
      layout: pane(sessionId),
      activePaneId: sessionId,
    })),
    activeSessionId: sessionIds[0] ?? null,
  };
}

function chat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: "c1",
    title: "Chat",
    projectId: "p1",
    ticketId: "t1",
    createdAt: 1,
    adapterId: "pi",
    live: true,
    activity: "idle",
    waitingOn: null,
    lastActivityAt: 1,
    bornTicketless: false,
    ...overrides,
  };
}

function build(overrides: Partial<BuildBoardSessionActivityInput> = {}) {
  return buildBoardSessionActivity({
    ticketIds: ["t1"],
    containers: {},
    lastOutputAt: {},
    parkState: {},
    harness: {},
    chatSessions: [],
    now: NOW,
    ...overrides,
  });
}

describe("buildBoardSessionActivity", () => {
  it("says nothing about a board with nothing running on it", () => {
    expect(build()).toEqual({ byTicket: {}, nextBoundaryAt: null });
  });

  it("lights a ticket whose terminal printed inside the working window", () => {
    const result = build({
      containers: { t1: container("s1") },
      lastOutputAt: { s1: NOW - 1_000 },
    });

    expect(result.byTicket).toEqual({ t1: "working" });
    expect(result.nextBoundaryAt).toBe(NOW - 1_000 + WORKING_WINDOW_MS + 1);
  });

  it("leaves a terminal that has gone quiet dark, and reports no boundary for it", () => {
    const result = build({
      containers: { t1: container("s1") },
      lastOutputAt: { s1: NOW - WORKING_WINDOW_MS - 1 },
    });

    expect(result.byTicket).toEqual({});
    // The window has already closed, so there is nothing ahead to wake for.
    expect(result.nextBoundaryAt).toBeNull();
  });

  it("does not light an exited or parked pane", () => {
    expect(
      buildBoardSessionActivity({
        ticketIds: ["t1"],
        containers: {
          t1: {
            tabs: [
              {
                sessionId: "s1",
                title: "s1",
                scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
                layout: pane("s1", 0),
                activePaneId: "s1",
              },
            ],
            activeSessionId: "s1",
          },
        },
        lastOutputAt: { s1: NOW },
        parkState: {},
        harness: {},
        chatSessions: [],
        now: NOW,
      }).byTicket,
    ).toEqual({});

    expect(
      build({
        containers: { t1: container("s1") },
        lastOutputAt: { s1: NOW },
        parkState: { s1: { parked: true, keepAwake: false } },
      }).byTicket,
    ).toEqual({});
  });

  it("takes the harness's declared word over output recency", () => {
    const harness = {
      s1: { declared: "waiting" } as unknown as SessionHarnessState,
    };
    const result = build({
      containers: { t1: container("s1") },
      lastOutputAt: { s1: NOW },
      harness,
    });

    expect(result.byTicket).toEqual({ t1: "waiting" });
  });

  it("lights a ticket from its chat Session's own reported activity", () => {
    expect(build({ chatSessions: [chat({ activity: "working" })] }).byTicket).toEqual({
      t1: "working",
    });
    expect(build({ chatSessions: [chat({ activity: "waiting" })] }).byTicket).toEqual({
      t1: "waiting",
    });
    expect(build({ chatSessions: [chat({ activity: "idle" })] }).byTicket).toEqual({});
  });

  it("lets waiting outrank working whichever order the Sessions arrive in", () => {
    // A ticket with one agent producing and another blocked needs a person, and
    // that is what the card must say — see the module doc's precedence note.
    expect(
      build({
        containers: { t1: container("s1") },
        lastOutputAt: { s1: NOW },
        chatSessions: [chat({ sessionId: "c1", activity: "waiting" })],
      }).byTicket,
    ).toEqual({ t1: "waiting" });

    expect(
      build({
        chatSessions: [
          chat({ sessionId: "c1", activity: "waiting" }),
          chat({ sessionId: "c2", activity: "working" }),
        ],
      }).byTicket,
    ).toEqual({ t1: "waiting" });
  });

  it("ignores a ticketless chat — a Project Session has no card to light", () => {
    expect(build({ chatSessions: [chat({ ticketId: null })] }).byTicket).toEqual({});
  });

  it("ignores a container for a ticket this board does not show", () => {
    expect(
      build({
        ticketIds: ["t1"],
        containers: { t2: container("s1") },
        lastOutputAt: { s1: NOW },
      }).byTicket,
    ).toEqual({});
  });

  it("reports the SOONEST boundary across several panes, in either arrival order", () => {
    const soonest = NOW - 5_000 + WORKING_WINDOW_MS + 1;
    expect(
      build({
        ticketIds: ["t1", "t2"],
        containers: { t1: container("s1"), t2: container("s2") },
        lastOutputAt: { s1: NOW - 1_000, s2: NOW - 5_000 },
      }).nextBoundaryAt,
    ).toBe(soonest);

    // The later boundary arriving second must not overwrite the earlier one.
    expect(
      build({
        ticketIds: ["t1", "t2"],
        containers: { t1: container("s1"), t2: container("s2") },
        lastOutputAt: { s1: NOW - 5_000, s2: NOW - 1_000 },
      }).nextBoundaryAt,
    ).toBe(soonest);
  });

  it("falls back to output recency when a harness is registered but has declared nothing", () => {
    const result = build({
      containers: { t1: container("s1") },
      lastOutputAt: { s1: NOW },
      harness: { s1: { declared: null } as unknown as SessionHarnessState },
    });

    expect(result.byTicket).toEqual({ t1: "working" });
  });

  it("walks every pane of a split tab, not just its root", () => {
    const result = buildBoardSessionActivity({
      ticketIds: ["t1"],
      containers: {
        t1: {
          tabs: [
            {
              sessionId: "s1",
              title: "split",
              scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
              layout: {
                kind: "split",
                id: "split-1",
                direction: "vertical",
                ratio: 0.5,
                first: pane("s1"),
                second: pane("s2"),
              },
              activePaneId: "s1",
            },
          ],
          activeSessionId: "s1",
        },
      },
      // Only the BACKGROUND pane is producing. A derivation that read the tab's
      // root would call this ticket quiet.
      lastOutputAt: { s2: NOW },
      parkState: {},
      harness: {},
      chatSessions: [],
      now: NOW,
    });

    expect(result.byTicket).toEqual({ t1: "working" });
  });

  it("reports a boundary for a pane whose declared state currently outranks recency", () => {
    // The override can lapse without anything else moving, so the board still
    // has to be woken when the recency window under it closes.
    const result = build({
      containers: { t1: container("s1") },
      lastOutputAt: { s1: NOW - 1_000 },
      harness: { s1: { declared: "waiting" } as unknown as SessionHarnessState },
    });

    expect(result.nextBoundaryAt).toBe(NOW - 1_000 + WORKING_WINDOW_MS + 1);
  });
});
