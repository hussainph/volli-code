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
 *
 * Note how nearly every loud case begins with `observeBirth`. That is not test
 * ceremony: it is the shape of the real thing. The rule speaks on ENTERING a
 * need, so it needs a baseline it actually watched, and the app's baseline
 * comes from the create — a Session that did not exist a moment ago needs
 * nobody. A case without it is a Session this process is meeting for the first
 * time, which is a relaunch, and a relaunch has watched no transition at all.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  type NativeHarnessAdapter,
} from "@volli/session-engine";
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
async function attachedRuntime() {
  let engineId = 0;
  let runtimeId = 0;
  let now = 1;
  const venue = { id: "machine-1", kind: "local" as const };
  const adapter: NativeHarnessAdapter = {
    id: "fake",
    durableIdNamespace: "fake",
    adapterVersion: "1.0.0",
    runtime: { path: "/fake/runtime", version: "1.0.0", fingerprint: "sha256:fake" },
    attach: async () => ({
      native: { id: "native-1", detail: null },
      dispatch: async (command) => ({
        commandId: command.commandId,
        status: "accepted" as const,
        acceptedAt: now++,
        native: null,
      }),
      reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
      release: async () => undefined,
    }),
  };
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock: { now: () => now++ },
    ids: { next: (kind) => `${kind}-${++engineId}` },
  });
  const runtime = createSessionRuntime({
    engine,
    executor: adapter,
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: {
      resolve: async () => ({ directory: "/fake/project", venue }),
      prepare: async () => ({ directory: "/fake/project", venue }),
      reaffirm: async () => undefined,
    },
    clock: { now: () => now++ },
    ids: { next: (kind) => `${kind}-${++runtimeId}` },
  });
  const created = await runtime.command({
    commandId: "create-notified-run",
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: null,
      title: "Nightly sweep",
    },
  });
  await runtime.command({
    commandId: "attach-notified-run",
    sessionId: created.sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  return { runtime, sessionId: created.sessionId };
}

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
    h.watch.observeBirth(SESSION_ID);
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
    h.watch.observeBirth(SESSION_ID);
    h.watch.observe(state("idle"));
    h.watch.observe(state("error"));
    expect(h.notified).toEqual([
      { title: "An Automation stopped", body: "Nightly sweep could not keep running." },
    ]);
  });

  it("notifies from the runtime's durable post-attach message failure Attention", async () => {
    const h = harness({ attendance: "unattended" });
    const { runtime, sessionId } = await attachedRuntime();
    h.watch.observeBirth(sessionId);

    await runtime.reportMessageDeliveryFailure({
      sessionId,
      commandId: "automation-kickoff",
      detail: "The Automation Run's first message was rejected: Pi refused the kickoff turn",
    });
    h.watch.observe((await runtime.projection({ sessionId })).projection);

    expect(h.notified).toEqual([
      { title: "An Automation stopped", body: "Nightly sweep could not keep running." },
    ]);
  });

  it("notifies on the very first fold of a Session it watched being minted", () => {
    // The Run whose pinned model went away, exactly as it happens: the door
    // mints the Session, the attach fails, and the activity watch coalesces
    // both durable writes into ONE fold. The birth is what makes that single
    // fold an edge — without it the Session would be met already in `error`
    // and seeded in silence, which is the whole point of announcing the create
    // rather than waiting to be told by a projection.
    const h = harness({ attendance: "unattended" });
    h.watch.observeBirth(SESSION_ID);
    h.watch.observe(state("error"));
    expect(h.notified.map((n) => n.title)).toEqual(["An Automation stopped"]);
  });

  it("never notifies on start", () => {
    // A Run opens its Session and starts working. Neither is a moment a person
    // is needed, and neither is representable as a need — so there is no edge.
    const h = harness({ attendance: "unattended" });
    h.watch.observeBirth(SESSION_ID);
    h.watch.observe(state("idle"));
    h.watch.observe(state("idle"));
    expect(h.notified).toEqual([]);
  });

  it("never notifies on finish", () => {
    const h = harness({ attendance: "unattended" });
    h.watch.observeBirth(SESSION_ID);
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
    h.watch.observeBirth(SESSION_ID);
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
    h.watch.observeBirth(SESSION_ID);
    h.watch.observe(state("waiting"));
    expect(h.notified).toEqual([]);
  });

  it("says the same thing only once while the need stands", () => {
    // Every durable fact written near a waiting Session re-folds this observer.
    // A rule written on the state rather than the edge would post again on each
    // one, which is how a rescue becomes the reason someone mutes the app.
    const h = harness({ attendance: "unattended" });
    h.watch.observeBirth(SESSION_ID);
    h.watch.observe(state("waiting"));
    h.watch.observe(state("waiting"));
    h.watch.observe(state("waiting"));
    expect(h.notified).toHaveLength(1);
  });

  it("speaks again when the errand changes from waiting to error", () => {
    // The person was going to answer a question and now there is nothing to
    // answer. That is a different trip, so it is a different notification.
    const h = harness({ attendance: "unattended" });
    h.watch.observeBirth(SESSION_ID);
    h.watch.observe(state("waiting"));
    h.watch.observe(state("error"));
    expect(h.notified.map((n) => n.title)).toEqual([
      "An Automation is waiting on you",
      "An Automation stopped",
    ]);
  });

  it("speaks again when a need is cleared and then returns", () => {
    const h = harness({ attendance: "unattended" });
    h.watch.observeBirth(SESSION_ID);
    h.watch.observe(state("waiting"));
    h.watch.observe(state("idle"));
    h.watch.observe(state("waiting"));
    expect(h.notified).toHaveLength(2);
  });

  it("stays silent for a Session that was stopped on purpose", () => {
    const h = harness({ attendance: "unattended" });
    h.watch.observeBirth(SESSION_ID);
    h.watch.observe(state("stopped"));
    expect(h.notified).toEqual([]);
  });

  /* ---------------------------------------- the edge, across a relaunch --- */

  it("seeds and stays silent when it meets a Session already in a need", () => {
    // The relaunch case, and the one this rule is easiest to get wrong on. The
    // app closed with an unattended Run waiting on a person; nothing about the
    // next launch is a transition, so the first fold — whatever caused it —
    // teaches the baseline and says nothing. "Enters `waiting`" is a verb.
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("waiting"));
    expect(h.notified).toEqual([]);
  });

  it("keeps quiet through every later fold of that same standing need", () => {
    // The seeded state has to be the REAL one, not a placeholder: a rename, a
    // move, any durable write near that Session re-folds it, and each one must
    // find the need it already knows about rather than a fresh edge.
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("waiting"));
    h.watch.observe(state("waiting", "Renamed once"));
    h.watch.observe(state("waiting", "Renamed twice"));
    expect(h.notified).toEqual([]);
  });

  it("speaks on the first real transition after a silent first sighting", () => {
    // Seeding is not muting. Once the baseline exists, the Session answering
    // its question and stopping again is an edge this process actually
    // watched — so a relaunch loses one announcement, never the channel.
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("waiting"));
    h.watch.observe(state("idle"));
    h.watch.observe(state("waiting"));
    expect(h.notified).toHaveLength(1);
  });

  it("treats a need that CHANGED since launch as the edge it is", () => {
    // Seeded `waiting`, then the transport dies under it. The person's errand
    // changed after launch, which this process did watch.
    const h = harness({ attendance: "unattended" });
    h.watch.observe(state("waiting"));
    h.watch.observe(state("error"));
    expect(h.notified.map((n) => n.title)).toEqual(["An Automation stopped"]);
  });

  it("never lets a birth overwrite what it already knows about a Session", () => {
    // `recover()` replays an accepted plan's create in a LATER process, so this
    // announcement can arrive for a Session already being watched. Rewriting
    // the baseline to `null` there would re-announce a need that never moved.
    const h = harness({ attendance: "unattended" });
    h.watch.observeBirth(SESSION_ID);
    h.watch.observe(state("waiting"));
    expect(h.notified).toHaveLength(1);
    h.watch.observeBirth(SESSION_ID);
    h.watch.observe(state("waiting"));
    expect(h.notified).toHaveLength(1);
  });

  it("honours VC-75's needs-you switch rather than a setting of its own", () => {
    const off = parseNotificationPreferences({ enabled: true, events: { "needs-you": false } });
    const h = harness({ attendance: "unattended", preferences: off });
    h.watch.observeBirth(SESSION_ID);
    h.watch.observe(state("waiting"));
    expect(h.notified).toEqual([]);
  });

  it("honours the master switch", () => {
    const off = parseNotificationPreferences({ enabled: false, events: { "needs-you": true } });
    const h = harness({ attendance: "unattended", preferences: off });
    h.watch.observeBirth(SESSION_ID);
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
    h.watch.observeBirth(SESSION_ID);
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
    watch.observeBirth("human-session");
    watch.observeBirth("run-session");
    watch.observe(state("waiting", "Person's chat", "human-session"));
    watch.observe(state("waiting", "Nightly sweep", "run-session"));
    expect(notified).toHaveLength(1);
    expect(notified[0]?.body).toBe("Nightly sweep stopped to ask.");
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
    watch.observeBirth(SESSION_ID);
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
      watch.observeBirth(SESSION_ID);
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
