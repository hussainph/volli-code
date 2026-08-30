/**
 * The notification rule, stated as the four acceptance criteria it has to meet
 * (VC-112's "Notification rule", VC-133):
 *
 *  - an unattended Run notifies on entering `waiting` or `error`;
 *  - never on start, never on finish;
 *  - an attended Run never notifies;
 *  - and the decision reads through VC-75's preferences.
 *
 * Most cases here assert SILENCE, which is what this feature is mostly made of.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  parseNotificationPreferences,
  type AutomationRunAttendance,
  type NotificationPreferences,
  type SessionProjection,
} from "@volli/shared";

import { createRunAttentionWatch, runAttentionNotification } from "./run-attention";

const SESSION_ID = "session-1";

interface Recorded {
  title: string;
  body: string;
}

function harness(
  options: {
    attendance?: AutomationRunAttendance | null;
    preferences?: NotificationPreferences;
  } = {},
) {
  const notified: Recorded[] = [];
  const errors: unknown[] = [];
  const watch = createRunAttentionWatch({
    attendanceOf: () => options.attendance ?? null,
    preferences: () => options.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES,
    notify: (input) => notified.push(input),
    onError: (error) => errors.push(error),
  });
  return { watch, notified, errors };
}

/** A projection in one of the states the rule reads, with a title to print. */
function state(
  kind: "idle" | "waiting" | "error" | "stopped",
  title: string | null = "Nightly sweep",
  sessionId = SESSION_ID,
): SessionProjection {
  const interactions = { active: kind === "waiting" ? [{ id: "ask-1" }] : [], all: [] };
  const attention = {
    active: kind === "error" ? [{ id: "a1", kind: "configuration_invalid" }] : [],
    all: [],
  };
  return {
    session: { id: sessionId, title },
    interactions,
    attention,
    stopped: kind === "stopped" ? { at: 1, reason: null, by: "user" } : null,
  } as unknown as SessionProjection;
}

describe("createRunAttentionWatch", () => {
  it("notifies when an unattended Run's Session enters waiting", () => {
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("idle"));
    h.watch.observe(state("waiting"));
    expect(h.notified).toEqual([
      { title: "An Automation is waiting on you", body: "Nightly sweep stopped to ask." },
    ]);
  });

  it("notifies when an unattended Run's Session enters error", () => {
    // VC-112's model clause rides this arm: a Run whose pinned model has become
    // unavailable fails its attach with `configuration_invalid` rather than
    // falling back, so it lands here and needs no second failure surface.
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("idle"));
    h.watch.observe(state("error"));
    expect(h.notified).toEqual([
      { title: "An Automation stopped", body: "Nightly sweep could not keep running." },
    ]);
  });

  it("never notifies on start", () => {
    // A Run opens its Session and starts working. Neither is a moment a person
    // is needed, and neither is representable as a need — so there is no edge.
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("idle"));
    h.watch.observe(state("idle"));
    expect(h.notified).toEqual([]);
  });

  it("never notifies on finish", () => {
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("idle"));
    h.watch.observe(state("waiting"));
    h.notified.length = 0;
    // The question is answered and the Run finishes. Leaving a need is not an
    // edge this rule speaks on.
    h.watch.observe(state("idle"));
    expect(h.notified).toEqual([]);
  });

  it("never notifies for an attended Run", () => {
    // A column drop, the rail's button, the palette. VC-112: a person is right
    // there, so the app has nothing to tell them.
    const h = harness({ attendance: "attended" });
    h.watch.observe(state("idle"));
    h.watch.observe(state("waiting"));
    h.watch.observe(state("error"));
    expect(h.notified).toEqual([]);
  });

  it("never notifies for a Session no Run owns", () => {
    // A chat a person opened. Also VC-131's pre-Run crash window, where a
    // Session is provably a Run's but its `automation_runs` row never landed:
    // both read `null`, and both stay quiet.
    const h = harness({ attendance: null });
    h.watch.observe(state("waiting"));
    expect(h.notified).toEqual([]);
  });

  it("says the same thing only once while the need stands", () => {
    // Every durable fact written near a waiting Session re-folds this observer.
    // A rule written on the state rather than the edge would post again on each
    // one, which is how a rescue becomes the reason someone mutes the app.
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("waiting"));
    h.watch.observe(state("waiting"));
    h.watch.observe(state("waiting"));
    expect(h.notified).toHaveLength(1);
  });

  it("speaks again when the errand changes from waiting to error", () => {
    // The person was going to answer a question and now there is nothing to
    // answer. That is a different trip, so it is a different notification.
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("waiting"));
    h.watch.observe(state("error"));
    expect(h.notified.map((n) => n.title)).toEqual([
      "An Automation is waiting on you",
      "An Automation stopped",
    ]);
  });

  it("speaks again when a need is cleared and then returns", () => {
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("waiting"));
    h.watch.observe(state("idle"));
    h.watch.observe(state("waiting"));
    expect(h.notified).toHaveLength(2);
  });

  it("stays silent for a Session that was stopped on purpose", () => {
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("stopped"));
    expect(h.notified).toEqual([]);
  });

  it("honours VC-75's needs-you switch rather than a setting of its own", () => {
    const off = parseNotificationPreferences({ enabled: true, events: { "needs-you": false } });
    const h = harness({ attendance: "unattended", preferences: off });
    h.watch.observe(state("waiting"));
    expect(h.notified).toEqual([]);
  });

  it("honours the master switch", () => {
    const off = parseNotificationPreferences({ enabled: false, events: { "needs-you": true } });
    const h = harness({ attendance: "unattended", preferences: off });
    h.watch.observe(state("waiting"));
    expect(h.notified).toEqual([]);
  });

  it("keeps other events' switches out of this decision", () => {
    // Muting "a session finishes" must not mute the one event that means
    // somebody is blocked.
    const prefs = parseNotificationPreferences({
      enabled: true,
      events: { "needs-you": true, finished: false, swept: false, update: false },
    });
    const h = harness({ attendance: "unattended", preferences: prefs });
    h.watch.observe(state("waiting"));
    expect(h.notified).toHaveLength(1);
  });

  it("tracks each Session separately", () => {
    const notified: Recorded[] = [];
    const watch = createRunAttentionWatch({
      attendanceOf: (sessionId) => (sessionId === "run-session" ? "unattended" : "attended"),
      preferences: () => DEFAULT_NOTIFICATION_PREFERENCES,
      notify: (input) => notified.push(input),
    });
    watch.observe(state("waiting", "Person's chat", "human-session"));
    watch.observe(state("waiting", "Nightly sweep", "run-session"));
    expect(notified).toHaveLength(1);
    expect(notified[0]?.body).toBe("Nightly sweep stopped to ask.");
  });

  it("re-announces a Session it was told to forget", () => {
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("waiting"));
    h.watch.forget(SESSION_ID);
    h.watch.observe(state("waiting"));
    expect(h.notified).toHaveLength(2);
  });

  it("swallows a failing port rather than failing the write that triggered it", () => {
    // This is an observer bolted onto the durable write path. A notification
    // that threw would take down the command that caused it.
    const errors: unknown[] = [];
    const watch = createRunAttentionWatch({
      attendanceOf: () => "unattended",
      preferences: () => DEFAULT_NOTIFICATION_PREFERENCES,
      notify: () => {
        throw new Error("no notification centre");
      },
      onError: (error) => errors.push(error),
    });
    expect(() => watch.observe(state("waiting"))).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("reports a failure through console.warn when given no diagnostics seam", () => {
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const watch = createRunAttentionWatch({
        attendanceOf: () => {
          throw new Error("database closed");
        },
        preferences: () => DEFAULT_NOTIFICATION_PREFERENCES,
        notify: () => undefined,
      });
      watch.observe(state("waiting"));
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
  });
});

describe("runAttentionNotification", () => {
  it("says which of the two errands it is in the title", () => {
    // They need different things — one is answerable, the other is broken — so
    // a reader must not have to open the app to find out which.
    expect(runAttentionNotification("waiting", { id: "s", title: "Review" }).title).not.toBe(
      runAttentionNotification("error", { id: "s", title: "Review" }).title,
    );
  });

  it("names the work through the Session's own title", () => {
    // A Run titles its Session after its Automation, so in the ordinary case
    // this IS the Automation's name.
    expect(runAttentionNotification("waiting", { id: "s", title: "Nightly sweep" }).body).toContain(
      "Nightly sweep",
    );
  });

  it("falls back to the short Session id rather than guessing a name", () => {
    const notification = runAttentionNotification("error", {
      id: "0f9c2b71-1111-2222-3333-444455556666",
      title: null,
    });
    expect(notification.body).toContain("Session 0f9c2b71");
  });
});
