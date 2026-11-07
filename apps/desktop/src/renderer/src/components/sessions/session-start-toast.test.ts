// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatSessionRecord } from "@volli/shared";

import type { SessionStartedNotice } from "../../../../ipc/contract";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { SessionStartToastTitle, sessionStartToastModel } from "./session-start-toast";

function notice(overrides: Partial<SessionStartedNotice> = {}): SessionStartedNotice {
  return {
    sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
    projectId: "project-one",
    ticketId: "ticket-one",
    ticketDisplayId: "VC-4",
    actor: "user",
    actorTicket: null,
    at: 1_000,
    ...overrides,
  };
}

function record(title: string, sessionId = notice().sessionId): ChatSessionRecord {
  return {
    sessionId,
    title,
    projectId: "project-one",
    ticketId: "ticket-one",
    createdAt: 1,
    adapterId: "pi",
    live: true,
    activity: "idle",
    waitingOn: null,
    outcome: null,
    lastActivityAt: 1,
    bornTicketless: false,
    role: "ticket",
    parentSessionId: null,
    model: null,
  };
}

function byProject(chat: ChatSessionRecord[]) {
  return { "project-one": { terminal: [], chat, provenance: {}, read: {} } };
}

afterEach(() => {
  useProjectSessionsStore.setState({ byProject: {} });
  vi.unstubAllGlobals();
});

describe("sessionStartToastModel", () => {
  it("names the launched Session, separates human provenance and targets the exact chat tab", () => {
    expect(sessionStartToastModel(notice(), "Review the migration")).toEqual({
      message: "Review the migration",
      description: "Started on VC-4 by you",
      target: {
        projectId: "project-one",
        ticketId: "ticket-one",
        sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
      },
    });
  });

  it.each([undefined, null, "", "   "])(
    "uses a truthful fallback for missing title %s",
    (title) => {
      expect(sessionStartToastModel(notice(), title).message).toBe("Session started");
    },
  );

  it.each([
    ["session", "VC-9", "VC-9"],
    ["session", null, "another Session"],
    ["automation", null, "automation"],
    ["unauthenticated", null, "an unauthenticated caller"],
  ] as const)(
    "keeps door-derived %s provenance separate from the launched title",
    (actor, actorTicket, starter) => {
      const model = sessionStartToastModel(notice({ actor, actorTicket }), "Clean up redundant UI");
      expect(model.message).toBe("Clean up redundant UI");
      expect(model.description).toBe(`Started on VC-4 by ${starter}`);
      expect(model.description).not.toContain("by you");
    },
  );

  it("preserves authored CJK, RTL, emoji and unbroken title text", () => {
    const title = `修正 היי 🧩 ${"x".repeat(1000)}`;
    expect(sessionStartToastModel(notice(), title).message).toBe(title);
  });

  it("updates the title from the matching existing roster without fetching, navigation or focus theft", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const input = document.createElement("input");
    document.body.append(input, host);
    input.focus();
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(SessionStartToastTitle, { notice: notice() })),
      );
      expect(host.textContent).toBe("Session started");
      await act(async () =>
        useProjectSessionsStore.setState({
          byProject: byProject([record("Wrong Session", "other-id")]),
        }),
      );
      expect(host.textContent).toBe("Session started");
      await act(async () =>
        useProjectSessionsStore.setState({
          byProject: { "other-project": byProject([record("Wrong project")])["project-one"] },
        }),
      );
      expect(host.textContent).toBe("Session started");
      for (const title of ["Clean up redundant UI", "Refined title", ""]) {
        await act(async () =>
          useProjectSessionsStore.setState({ byProject: byProject([record(title)]) }),
        );
        expect(host.textContent).toBe(title || "Session started");
        expect(document.activeElement).toBe(input);
      }
    } finally {
      await act(async () => root.unmount());
      input.remove();
      host.remove();
    }
  });
});
