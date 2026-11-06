import { describe, expect, it } from "vite-plus/test";

import type { SessionStartedNotice } from "../../../../ipc/contract";
import { sessionStartToastModel } from "./session-start-toast";

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

describe("sessionStartToastModel", () => {
  it("names the human actor and targets the session's chat tab", () => {
    expect(sessionStartToastModel(notice())).toEqual({
      message: "Session started on VC-4 · You",
      target: {
        projectId: "project-one",
        ticketId: "ticket-one",
        sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
      },
    });
  });

  it("names the driving session's own ticket when the door derived one", () => {
    expect(sessionStartToastModel(notice({ actor: "session", actorTicket: "VC-9" })).message).toBe(
      "Session started on VC-4 · VC-9",
    );
  });

  it("still announces a Board Session's start without inventing a ticket", () => {
    expect(sessionStartToastModel(notice({ actor: "session" })).message).toBe(
      "Session started on VC-4 · Another Session",
    );
  });

  it("names automation plainly", () => {
    expect(sessionStartToastModel(notice({ actor: "automation" })).message).toBe(
      "Session started on VC-4 · Automation",
    );
  });

  // VC-163 widened the actor union, and the old `: "You"` fallback would have
  // announced a caller Volli could not identify as the person reading the
  // toast. No door produces this today; the point of the test is that the day
  // one does, it does not arrive wearing the user's name.
  it("never announces an unidentified caller as the person reading the toast", () => {
    expect(sessionStartToastModel(notice({ actor: "unauthenticated" })).message).toBe(
      "Session started on VC-4 · An unauthenticated caller",
    );
  });
});
