/**
 * The two halves of a notification's relationship with what is on screen
 * (VC-295): what this window is showing (so main can suppress an alert for it)
 * and where a clicked alert has to take the person.
 */
import { describe, expect, it } from "vite-plus/test";
import type { NotificationTarget } from "@volli/shared";

import {
  activeNotificationTarget,
  notificationRoute,
  staleNotificationItemMessage,
} from "./notification-target";

describe("activeNotificationTarget", () => {
  it("names the chat Session in front of a ticket workspace", () => {
    expect(
      activeNotificationTarget({
        projectId: "p1",
        nav: "home",
        openTicketId: "t1",
        activeTicketTabId: "chat:s1",
        homeActiveTab: "board",
      }),
    ).toEqual({
      kind: "session",
      projectId: "p1",
      ticketId: "t1",
      sessionId: "s1",
      interactionId: null,
      attentionId: null,
    });
  });

  it("names the ticket when its non-chat tab is in front", () => {
    // A file or diff tab is the ticket being looked at, not a Session: an alert
    // about one of its Sessions is still news.
    expect(
      activeNotificationTarget({
        projectId: "p1",
        nav: "home",
        openTicketId: "t1",
        activeTicketTabId: "diff:src/app.ts",
        homeActiveTab: "board",
      }),
    ).toEqual({ kind: "ticket", projectId: "p1", ticketId: "t1" });
  });

  it("names the ticket when its strip has nothing in front yet", () => {
    // A ticket opened from the board before any tab is recorded: the ticket is
    // what is on screen, and no Session is.
    expect(
      activeNotificationTarget({
        projectId: "p1",
        nav: "home",
        openTicketId: "t1",
        activeTicketTabId: null,
        homeActiveTab: "board",
      }),
    ).toEqual({ kind: "ticket", projectId: "p1", ticketId: "t1" });
  });

  it("names a Board Session that Home has in front", () => {
    expect(
      activeNotificationTarget({
        projectId: "p1",
        nav: "home",
        openTicketId: null,
        activeTicketTabId: null,
        homeActiveTab: "chat:s9",
      }),
    ).toEqual({
      kind: "session",
      projectId: "p1",
      ticketId: null,
      sessionId: "s9",
      interactionId: null,
      attentionId: null,
    });
  });

  it("shows nothing suppressible on the board itself", () => {
    // The board is not a Session and not one ticket, so nothing it displays is
    // "the target already in front of the person".
    expect(
      activeNotificationTarget({
        projectId: "p1",
        nav: "home",
        openTicketId: null,
        activeTicketTabId: null,
        homeActiveTab: "board",
      }),
    ).toBeNull();
  });

  it("shows nothing on the other nav pages", () => {
    for (const nav of ["automations", "configure"] as const) {
      expect(
        activeNotificationTarget({
          projectId: "p1",
          nav,
          openTicketId: "t1",
          activeTicketTabId: "chat:s1",
          homeActiveTab: "board",
        }),
      ).toBeNull();
    }
  });

  it("shows nothing before a project is chosen", () => {
    expect(
      activeNotificationTarget({
        projectId: null,
        nav: "home",
        openTicketId: "t1",
        activeTicketTabId: "chat:s1",
        homeActiveTab: "board",
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
    expect(notificationRoute(sessionTarget)).toEqual({
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
    expect(notificationRoute({ ...sessionTarget, ticketId: null, interactionId: null })).toEqual({
      kind: "project-session",
      projectId: "p1",
      sessionId: "s1",
      tabId: "chat:s1",
      interactionId: null,
      attentionId: null,
    });
  });

  it("opens a ticket", () => {
    expect(notificationRoute({ kind: "ticket", projectId: "p1", ticketId: "t1" })).toEqual({
      kind: "ticket",
      projectId: "p1",
      ticketId: "t1",
    });
  });

  it("opens the update surface", () => {
    expect(notificationRoute({ kind: "update" })).toEqual({ kind: "update" });
  });
});

describe("staleNotificationItemMessage", () => {
  it("says nothing when the alert named no item", () => {
    // Nothing was promised, so there is nothing to explain.
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
    // The Session still opens — the person asked to go there. What must not
    // happen is silence, which reads as the app losing the thing it announced.
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
    // A projection that has not arrived is not evidence that anything resolved,
    // and announcing "already answered" over it would be a lie the person would
    // then have to disprove by scrolling.
    expect(
      staleNotificationItemMessage({ interactionId: "i1", attentionId: null }, null),
    ).toBeNull();
  });
});
