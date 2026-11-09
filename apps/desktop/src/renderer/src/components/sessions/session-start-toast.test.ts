// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY, PERSON_STARTED, type ChatSessionRecord } from "@volli/shared";

const projection = vi.hoisted(() => vi.fn());
vi.mock("@renderer/chat/transport", () => ({
  chatTransportFor: () => ({ rpc: { session: { projection: { query: projection } } } }),
}));

import type { SessionStartedNotice } from "../../../../ipc/contract";
import {
  createSessionActivityIntake,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
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

beforeEach(() => {
  projection.mockReset().mockResolvedValue({ projection: {}, throughSequence: 0 });
});

afterEach(() => {
  useProjectSessionsStore.setState({ byProject: {}, listingState: {} });
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

  it("names an unhydrated project's Session through one exact read and the real activity intake", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const api = Object.getOwnPropertyDescriptor(window, "api");
    const list = vi.fn().mockResolvedValue({ ok: true, sessions: [] });
    Object.assign(window, { api: { sessions: { list } } });
    // Project A has actually been visited; project B has no baseline. Pushed
    // rows must not pretend that they are its complete project roster.
    await useProjectSessionsStore.getState().ensure("visited-project");
    const intake = createSessionActivityIntake(useProjectSessionsStore);
    const publish = (title: string, sessionId = notice().sessionId, projectId = "project-one") => {
      intake.push({
        projectId,
        ticketId: "ticket-one",
        row: {
          kind: "chat",
          record: { ...record(title, sessionId), projectId },
          usage: EMPTY_SESSION_USAGE_SUMMARY,
          provenance: PERSON_STARTED,
        },
      });
      intake.flush();
    };
    publish("Permanent title");
    expect(useProjectSessionsStore.getState().byProject["project-one"]).toBeUndefined();
    const read = Promise.withResolvers<{
      projection: {
        session: {
          id: string;
          projectId: string;
          title: string;
        };
      };
      throughSequence: number;
    }>();
    projection.mockReturnValueOnce(read.promise);
    const host = document.createElement("div");
    const input = document.createElement("input");
    document.body.append(input, host);
    input.focus();
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(SessionStartToastTitle, { notice: notice() })),
      );
      expect(projection).toHaveBeenCalledExactlyOnceWith({ sessionId: notice().sessionId });
      expect(host.textContent).toBe("Session started");
      await act(async () =>
        read.resolve({
          projection: {
            session: {
              id: notice().sessionId,
              projectId: notice().projectId,
              title: "Permanent title",
            },
          },
          throughSequence: 1,
        }),
      );
      expect(host.textContent).toBe("Permanent title");
      await act(async () => publish("Refined title"));
      expect(host.textContent).toBe("Refined title");
      await act(async () => {
        publish("Wrong Session", "other-id");
        publish("Wrong project", notice().sessionId, "other-project");
      });
      expect(host.textContent).toBe("Refined title");
      expect(document.activeElement).toBe(input);
      expect(list).toHaveBeenCalledExactlyOnceWith({ projectId: "visited-project" });
      expect(useProjectSessionsStore.getState().byProject["project-one"]).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      intake.dispose();
      input.remove();
      host.remove();
      if (api) Object.defineProperty(window, "api", api);
      else Reflect.deleteProperty(window, "api");
    }
  });

  it("keeps a newer intake title when the initial exact read completes late", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const read = Promise.withResolvers<{
      projection: {
        session: {
          id: string;
          projectId: string;
          title: string;
        };
      };
      throughSequence: number;
    }>();
    projection.mockReturnValueOnce(read.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const intake = createSessionActivityIntake(useProjectSessionsStore);
    try {
      await act(async () =>
        root.render(createElement(SessionStartToastTitle, { notice: notice() })),
      );
      await act(async () => {
        intake.push({
          projectId: notice().projectId,
          ticketId: notice().ticketId,
          row: {
            kind: "chat",
            record: record("Newer title"),
            usage: EMPTY_SESSION_USAGE_SUMMARY,
            provenance: PERSON_STARTED,
          },
        });
        intake.flush();
      });
      await act(async () =>
        read.resolve({
          projection: {
            session: {
              id: notice().sessionId,
              projectId: notice().projectId,
              title: "Older title",
            },
          },
          throughSequence: 1,
        }),
      );
      expect(host.textContent).toBe("Newer title");
    } finally {
      await act(async () => root.unmount());
      intake.dispose();
      host.remove();
    }
  });

  it("preserves authored CJK, RTL, emoji and unbroken title text", () => {
    const title = `修正 היי 🧩 ${"x".repeat(1000)}`;
    expect(sessionStartToastModel(notice(), title).message).toBe(title);
  });

  it("updates the title from the matching existing roster without navigation or focus theft", async () => {
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
