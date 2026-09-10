/**
 * The producer→category map and the click target (VC-295).
 *
 * The tests that matter here are the EXHAUSTIVENESS ones: the whole bug this
 * catalog exists to prevent is a switch with no producer behind it (a control
 * that lies) or a producer with no policy (an alert nobody can mute). Both are
 * assertions over the tables rather than over one call.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  NOTIFICATION_PRODUCERS,
  NOTIFICATION_PRODUCER_POLICY,
  notificationProducerAllowed,
  notificationProducerPolicy,
  notificationTargetMatches,
  operationalNotificationProducers,
  parseNotificationTarget,
  producersForNotificationEvent,
  type NotificationTarget,
} from "./notification-catalog";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_EVENTS,
  type NotificationPreferences,
} from "./notification-preferences";

/** A Session target, for the identity cases below. */
const session = (sessionId: string, extra: Record<string, unknown> = {}): NotificationTarget => ({
  kind: "session",
  projectId: "p1",
  ticketId: "t1",
  sessionId,
  interactionId: null,
  attentionId: null,
  ...extra,
});

const prefs = (overrides: Partial<NotificationPreferences["events"]> = {}, enabled = true) => ({
  enabled,
  events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, ...overrides },
});

describe("producer catalog", () => {
  it("gives every producer exactly one policy", () => {
    expect(Object.keys(NOTIFICATION_PRODUCER_POLICY).toSorted()).toEqual(
      [...NOTIFICATION_PRODUCERS].toSorted(),
    );
    for (const producer of NOTIFICATION_PRODUCERS) {
      expect(notificationProducerPolicy(producer)).toBe(NOTIFICATION_PRODUCER_POLICY[producer]);
    }
  });

  it("leaves no preference event without a producer", () => {
    // The acceptance criterion in words: no visible switch may be a control
    // that does nothing. A category that loses its last producer fails here.
    for (const event of NOTIFICATION_EVENTS) {
      expect(producersForNotificationEvent(event).length).toBeGreaterThan(0);
    }
  });

  it("maps each preference event to the producers this build actually posts", () => {
    expect([...producersForNotificationEvent("needs-you")]).toEqual([
      "run-attention",
      "session-watchdog",
      "harness-input-needed",
    ]);
    expect([...producersForNotificationEvent("finished")]).toEqual(["pull-request-merged"]);
    // Maintenance that takes back a resource nobody is using: the folder
    // (VC-113), and the processes still running inside it (VC-341).
    expect([...producersForNotificationEvent("swept")]).toEqual([
      "worktree-reclaimed",
      "orphan-processes-reaped",
    ]);
    expect([...producersForNotificationEvent("update")]).toEqual(["update-ready"]);
  });

  it("names the operational alerts and says why each is outside the switches", () => {
    expect([...operationalNotificationProducers()]).toEqual([
      "ticket-moved-to-doing",
      "agent-notify",
      "worktree-record-failed",
      "cli-socket-failed",
    ]);
    for (const producer of operationalNotificationProducers()) {
      const policy = notificationProducerPolicy(producer);
      expect(policy.kind).toBe("operational");
      if (policy.kind === "operational") expect(policy.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("notificationProducerAllowed", () => {
  it("honours the category switch of every preference-controlled producer", () => {
    for (const event of NOTIFICATION_EVENTS) {
      for (const producer of producersForNotificationEvent(event)) {
        expect(notificationProducerAllowed(prefs({ [event]: false }), producer)).toBe(false);
        expect(notificationProducerAllowed(prefs({ [event]: true }), producer)).toBe(true);
      }
    }
  });

  it("mutes one category without touching another", () => {
    const muted = prefs({ "needs-you": false });
    expect(notificationProducerAllowed(muted, "run-attention")).toBe(false);
    expect(notificationProducerAllowed(muted, "pull-request-merged")).toBe(true);
    expect(notificationProducerAllowed(muted, "worktree-reclaimed")).toBe(true);
    expect(notificationProducerAllowed(muted, "update-ready")).toBe(true);
  });

  it("silences every preference-controlled producer when the master switch is off", () => {
    const off = prefs({}, false);
    for (const event of NOTIFICATION_EVENTS) {
      for (const producer of producersForNotificationEvent(event)) {
        expect(notificationProducerAllowed(off, producer)).toBe(false);
      }
    }
  });

  it("never lets a preference silence an operational alert", () => {
    // A failed CLI socket and a failed durable write are faults, not tastes:
    // the app has no other voice for them (CLAUDE.md's never-swallow rule), and
    // `volli notify` is an alert a person's own agent was told to send.
    const off = prefs({}, false);
    for (const producer of operationalNotificationProducers()) {
      expect(notificationProducerAllowed(off, producer)).toBe(true);
    }
  });
});

describe("notificationTargetMatches", () => {
  it("matches only when the window is showing the very item the alert names", () => {
    // VC-295 round 2: a Session id is not the target. A person looking at one
    // question in a Session must still be told about the failure that just
    // stopped it, so the whole scoped target has to agree.
    expect(
      notificationTargetMatches(
        session("s1", { interactionId: "i1" }),
        session("s1", { interactionId: "i1" }),
      ),
    ).toBe(true);
  });

  it("does not match a different question in the same Session", () => {
    expect(
      notificationTargetMatches(
        session("s1", { interactionId: "i2" }),
        session("s1", { interactionId: "i1" }),
      ),
    ).toBe(false);
  });

  it("does not match a failure against the question on screen beside it", () => {
    expect(
      notificationTargetMatches(
        session("s1", { attentionId: "a1" }),
        session("s1", { interactionId: "i1" }),
      ),
    ).toBe(false);
  });

  it("does not match an item-bearing alert against a Session showing nothing", () => {
    // A terminal Session, or a chat with no open card: the window is not
    // showing the question, so the alert is still news.
    expect(notificationTargetMatches(session("s1", { interactionId: "i1" }), session("s1"))).toBe(
      false,
    );
  });

  it("matches a Session with no item against the same Session showing none", () => {
    // The harness case: a terminal in front, and an alert about that terminal.
    expect(notificationTargetMatches(session("s1"), session("s1"))).toBe(true);
  });

  it("does not match the same local id under another project", () => {
    // Round 3. Ids are UUIDs today, but the scope is part of the target and a
    // comparison that drops it is one import, one fixture, or one future
    // scoped-id scheme away from silencing another workspace's alert.
    expect(notificationTargetMatches(session("s1"), session("s1", { projectId: "p2" }))).toBe(
      false,
    );
  });

  it("does not match the same Session id claimed under another ticket", () => {
    expect(notificationTargetMatches(session("s1"), session("s1", { ticketId: "t2" }))).toBe(false);
    expect(notificationTargetMatches(session("s1"), session("s1", { ticketId: null }))).toBe(false);
  });

  it("does not match a ticket id under another project", () => {
    expect(
      notificationTargetMatches(
        { kind: "ticket", projectId: "p1", ticketId: "t1" },
        { kind: "ticket", projectId: "p2", ticketId: "t1" },
      ),
    ).toBe(false);
  });

  it("does not match a different Session", () => {
    expect(notificationTargetMatches(session("s1"), session("s2"))).toBe(false);
  });

  it("matches a ticket target only against the same ticket", () => {
    const ticket: NotificationTarget = { kind: "ticket", projectId: "p1", ticketId: "t1" };
    expect(
      notificationTargetMatches(ticket, { kind: "ticket", projectId: "p1", ticketId: "t1" }),
    ).toBe(true);
    expect(
      notificationTargetMatches(ticket, { kind: "ticket", projectId: "p1", ticketId: "t2" }),
    ).toBe(false);
  });

  it("never matches across kinds — a ticket on screen is not its Session", () => {
    expect(
      notificationTargetMatches(session("s1"), { kind: "ticket", projectId: "p1", ticketId: "t1" }),
    ).toBe(false);
    expect(
      notificationTargetMatches({ kind: "ticket", projectId: "p1", ticketId: "t1" }, session("s1")),
    ).toBe(false);
  });

  it("matches the update surface with itself", () => {
    expect(notificationTargetMatches({ kind: "update" }, { kind: "update" })).toBe(true);
    expect(notificationTargetMatches({ kind: "update" }, session("s1"))).toBe(false);
  });

  it("never matches a null target — an alert with nowhere to go is never suppressed", () => {
    expect(notificationTargetMatches(null, session("s1"))).toBe(false);
    expect(notificationTargetMatches(session("s1"), null)).toBe(false);
    expect(notificationTargetMatches(null, null)).toBe(false);
  });
});

describe("parseNotificationTarget", () => {
  it("keeps a whole Session target, and only this vocabulary", () => {
    expect(
      parseNotificationTarget({
        kind: "session",
        projectId: "p1",
        ticketId: "t1",
        sessionId: "s1",
        interactionId: "i1",
        attentionId: "a1",
        smuggled: "drop me",
      }),
    ).toEqual({
      kind: "session",
      projectId: "p1",
      ticketId: "t1",
      sessionId: "s1",
      interactionId: "i1",
      attentionId: "a1",
    });
  });

  it("reads a Board Session, which has no ticket and no open question", () => {
    expect(parseNotificationTarget({ kind: "session", projectId: "p1", sessionId: "s1" })).toEqual({
      kind: "session",
      projectId: "p1",
      ticketId: null,
      sessionId: "s1",
      interactionId: null,
      attentionId: null,
    });
  });

  it("reads ticket and update targets", () => {
    expect(parseNotificationTarget({ kind: "ticket", projectId: "p1", ticketId: "t1" })).toEqual({
      kind: "ticket",
      projectId: "p1",
      ticketId: "t1",
    });
    expect(parseNotificationTarget({ kind: "update" })).toEqual({ kind: "update" });
  });

  it("answers null for anything that is not one", () => {
    expect(parseNotificationTarget(null)).toBeNull();
    expect(parseNotificationTarget("session")).toBeNull();
    expect(parseNotificationTarget({ kind: "inbox" })).toBeNull();
    expect(parseNotificationTarget({ kind: "session", projectId: "p1" })).toBeNull();
    expect(parseNotificationTarget({ kind: "session", projectId: "", sessionId: "s1" })).toBeNull();
    expect(parseNotificationTarget({ kind: "session", projectId: "p1", sessionId: "" })).toBeNull();
    expect(parseNotificationTarget({ kind: "session", projectId: 7, sessionId: "s1" })).toBeNull();
    expect(parseNotificationTarget({ kind: "ticket", projectId: "p1" })).toBeNull();
    expect(parseNotificationTarget({ kind: "ticket", projectId: "p1", ticketId: "" })).toBeNull();
    expect(parseNotificationTarget({ kind: "ticket", projectId: "", ticketId: "t1" })).toBeNull();
  });

  it("drops an id that is present but empty rather than storing a blank", () => {
    expect(
      parseNotificationTarget({
        kind: "session",
        projectId: "p1",
        ticketId: "",
        sessionId: "s1",
        interactionId: 7,
      }),
    ).toEqual({
      kind: "session",
      projectId: "p1",
      ticketId: null,
      sessionId: "s1",
      interactionId: null,
      attentionId: null,
    });
  });
});
