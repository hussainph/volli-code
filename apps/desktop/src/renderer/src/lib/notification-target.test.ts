/**
 * The two halves of a notification's relationship with what is on screen
 * (VC-295): what this window is showing (so main can suppress an alert for it)
 * and where a clicked alert has to take the person.
 *
 * Round 2 sharpened both. What a window reports now carries the ITEM it is
 * showing, because a Session id alone made one question swallow the alert about
 * the failure beside it; and a route now knows a terminal Session from a chat
 * one, because a harness that is waiting on a human is waiting in a terminal —
 * `chat:<sessionId>` opened a tab that does not exist.
 */
import { describe, expect, it } from "vite-plus/test";
import type { NotificationTarget } from "@volli/shared";

import {
  activeNotificationTarget,
  notificationRoute,
  staleNotificationItemMessage,
  type TerminalSessionPlacement,
} from "./notification-target";

const NO_ITEM = { interactionId: null, attentionId: null } as const;

/** The reading a window makes when it is showing nothing in particular. */
const QUIET = {
  projectId: "p1" as string | null,
  nav: "home" as "home" | "automations" | "configure",
  openTicketId: null as string | null,
  activeTicketTabId: null as string | null,
  homeActiveTab: "board",
  terminalSessionId: null as string | null,
  chatItem: NO_ITEM,
};

describe("activeNotificationTarget", () => {
  it("names the chat Session in front of a ticket workspace, and the item it shows", () => {
    expect(
      activeNotificationTarget({
        ...QUIET,
        openTicketId: "t1",
        activeTicketTabId: "chat:s1",
        chatItem: { interactionId: "i1", attentionId: null },
      }),
    ).toEqual({
      kind: "session",
      projectId: "p1",
      ticketId: "t1",
      sessionId: "s1",
      interactionId: "i1",
      attentionId: null,
    });
  });

  it("names the failure a chat Session is showing rather than a question", () => {
    // The item comes from `sessionNotificationItem`, which is also what the
    // producer used — so the comparison is between two answers to one question.
    expect(
      activeNotificationTarget({
        ...QUIET,
        openTicketId: "t1",
        activeTicketTabId: "chat:s1",
        chatItem: { interactionId: null, attentionId: "a1" },
      }),
    ).toMatchObject({ sessionId: "s1", interactionId: null, attentionId: "a1" });
  });

  it("names the terminal Session a ticket's terminal tab is showing", () => {
    // A harness alert names a terminal Session, so a window with that terminal
    // in front has to report the same thing or the alert is shouted twice.
    expect(
      activeNotificationTarget({
        ...QUIET,
        openTicketId: "t1",
        activeTicketTabId: "term-root",
        terminalSessionId: "term-pane",
      }),
    ).toEqual({
      kind: "session",
      projectId: "p1",
      ticketId: "t1",
      sessionId: "term-pane",
      interactionId: null,
      attentionId: null,
    });
  });

  it("names a Board terminal Session Home has in front", () => {
    expect(
      activeNotificationTarget({
        ...QUIET,
        homeActiveTab: "term-root",
        terminalSessionId: "term-root",
      }),
    ).toEqual({
      kind: "session",
      projectId: "p1",
      ticketId: null,
      sessionId: "term-root",
      interactionId: null,
      attentionId: null,
    });
  });

  it("names the ticket when its non-chat, non-terminal tab is in front", () => {
    expect(
      activeNotificationTarget({
        ...QUIET,
        openTicketId: "t1",
        activeTicketTabId: "diff:src/app.ts",
      }),
    ).toEqual({ kind: "ticket", projectId: "p1", ticketId: "t1" });
  });

  it("names the ticket when its strip has nothing in front yet", () => {
    expect(activeNotificationTarget({ ...QUIET, openTicketId: "t1" })).toEqual({
      kind: "ticket",
      projectId: "p1",
      ticketId: "t1",
    });
  });

  it("names a Board chat Session that Home has in front", () => {
    expect(
      activeNotificationTarget({
        ...QUIET,
        homeActiveTab: "chat:s9",
        chatItem: { interactionId: "i9", attentionId: null },
      }),
    ).toEqual({
      kind: "session",
      projectId: "p1",
      ticketId: null,
      sessionId: "s9",
      interactionId: "i9",
      attentionId: null,
    });
  });

  it("shows nothing suppressible on the board itself", () => {
    expect(activeNotificationTarget(QUIET)).toBeNull();
  });

  it("shows nothing on the other nav pages", () => {
    for (const nav of ["automations", "configure"] as const) {
      expect(
        activeNotificationTarget({
          ...QUIET,
          nav,
          openTicketId: "t1",
          activeTicketTabId: "chat:s1",
        }),
      ).toBeNull();
    }
  });

  it("shows nothing before a project is chosen", () => {
    expect(
      activeNotificationTarget({
        ...QUIET,
        projectId: null,
        openTicketId: "t1",
        activeTicketTabId: "chat:s1",
      }),
    ).toBeNull();
  });
});

describe("notificationRoute", () => {
  const sessionTarget: NotificationTarget = {
    kind: "session",
    projectId: "p1",
    ticketId: "t1",
    sessionId: "s1",
    interactionId: "i1",
    attentionId: null,
  };

  it("opens a ticket Session's chat tab, and says which item to reveal", () => {
    expect(notificationRoute(sessionTarget, null)).toEqual({
      kind: "ticket-session",
      projectId: "p1",
      ticketId: "t1",
      sessionId: "s1",
      tabId: "chat:s1",
      interactionId: "i1",
      attentionId: null,
    });
  });

  it("opens a Board Session on Home rather than inventing a ticket", () => {
    expect(
      notificationRoute({ ...sessionTarget, ticketId: null, interactionId: null }, null),
    ).toEqual({
      kind: "project-session",
      projectId: "p1",
      sessionId: "s1",
      tabId: "chat:s1",
      interactionId: null,
      attentionId: null,
    });
  });

  it("opens the terminal a harness is waiting in, not a chat tab of the same id", () => {
    // The round-1 bug, stated: every Session target became `chat:<id>`, so a
    // harness alert opened a chat tab that does not exist and left the terminal
    // asking behind it.
    const placement: TerminalSessionPlacement = {
      ownerId: "t1",
      tabId: "term-root",
      paneId: "term-pane",
      scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
    };
    expect(notificationRoute({ ...sessionTarget, sessionId: "term-pane" }, placement)).toEqual({
      kind: "ticket-terminal",
      projectId: "p1",
      ticketId: "t1",
      tabId: "term-root",
      paneId: "term-pane",
    });
  });

  it("opens a Board terminal on Home", () => {
    const placement: TerminalSessionPlacement = {
      ownerId: "p1",
      tabId: "term-root",
      paneId: "term-root",
      scope: { kind: "project", projectId: "p1" },
    };
    expect(notificationRoute({ ...sessionTarget, sessionId: "term-root" }, placement)).toEqual({
      kind: "project-terminal",
      projectId: "p1",
      tabId: "term-root",
      paneId: "term-root",
    });
  });

  it("trusts where the terminal actually lives over what the alert remembered", () => {
    // A Session's placement is live truth; the alert's ticket id is a memory
    // from whenever it was posted.
    const placement: TerminalSessionPlacement = {
      ownerId: "t9",
      tabId: "term-root",
      paneId: "term-root",
      scope: { kind: "ticket", projectId: "p9", ticketId: "t9" },
    };
    expect(
      notificationRoute({ ...sessionTarget, sessionId: "term-root" }, placement),
    ).toMatchObject({ projectId: "p9", ticketId: "t9" });
  });

  it("opens a ticket", () => {
    expect(notificationRoute({ kind: "ticket", projectId: "p1", ticketId: "t1" }, null)).toEqual({
      kind: "ticket",
      projectId: "p1",
      ticketId: "t1",
    });
  });

  it("opens the update surface", () => {
    expect(notificationRoute({ kind: "update" }, null)).toEqual({ kind: "update" });
  });
});

describe("staleNotificationItemMessage", () => {
  it("says nothing when the alert named no item", () => {
    expect(
      staleNotificationItemMessage(
        { interactionId: null, attentionId: null },
        { interactionIds: [], attentionIds: [] },
      ),
    ).toBeNull();
  });

  it("says nothing while the question it named is still open", () => {
    expect(
      staleNotificationItemMessage(
        { interactionId: "i1", attentionId: null },
        { interactionIds: ["i1"], attentionIds: [] },
      ),
    ).toBeNull();
  });

  it("says nothing while the failure it named is still active", () => {
    expect(
      staleNotificationItemMessage(
        { interactionId: null, attentionId: "a1" },
        { interactionIds: [], attentionIds: ["a1"] },
      ),
    ).toBeNull();
  });

  it("explains a question that has already been answered", () => {
    expect(
      staleNotificationItemMessage(
        { interactionId: "i1", attentionId: null },
        { interactionIds: ["i2"], attentionIds: [] },
      ),
    ).toBe("That question was already answered.");
  });

  it("explains a failure that has since cleared", () => {
    expect(
      staleNotificationItemMessage(
        { interactionId: null, attentionId: "a1" },
        { interactionIds: [], attentionIds: [] },
      ),
    ).toBe("That problem is no longer active.");
  });

  it("names the question first when an alert carried both", () => {
    expect(
      staleNotificationItemMessage(
        { interactionId: "i1", attentionId: "a1" },
        { interactionIds: [], attentionIds: [] },
      ),
    ).toBe("That question was already answered.");
  });

  it("waits rather than claiming staleness before the Session has loaded", () => {
    expect(
      staleNotificationItemMessage({ interactionId: "i1", attentionId: null }, null),
    ).toBeNull();
  });
});
