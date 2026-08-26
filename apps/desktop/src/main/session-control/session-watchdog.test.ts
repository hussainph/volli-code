import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SESSION_WATCHDOG_SILENCE_MS, EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
import type { SessionProjection } from "@volli/shared";

import { createSessionWatchdog } from "./session-watchdog";
import type { SessionWatchdogPorts } from "./session-watchdog";

const T = DEFAULT_SESSION_WATCHDOG_SILENCE_MS;
const SESSION = "aaaaaaaa-0000-0000-0000-000000000000";

function projection(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    session: {
      id: SESSION,
      projectId: "project-1",
      ticketId: null,
      title: "Implementer",
      createdAt: 0,
    },
    status: "open",
    commands: [],
    receipts: [],
    pendingExecutorStart: null,
    attachments: [],
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    modelSelection: null,
    turnActive: true,
    authorityDenials: 0,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 0,
    bornTicketless: true,
    ...overrides,
  };
}

function harness(input: {
  projections: SessionProjection[];
  now?: () => number;
  stopSession?: SessionWatchdogPorts["stopSession"];
}) {
  const submits: unknown[] = [];
  const notifications: { title: string; body: string }[] = [];
  const errors: unknown[] = [];
  const byId = new Map(input.projections.map((entry) => [entry.session.id, entry]));
  const watchdog = createSessionWatchdog({
    listBindings: () => [...byId.keys()].map((sessionId) => ({ sessionId })),
    projection: async (sessionId) => {
      const found = byId.get(sessionId);
      if (found === undefined) throw new Error(`no projection for ${sessionId}`);
      return found;
    },
    submit: (async (request: unknown) => {
      submits.push(request);
      return {};
    }) as unknown as SessionWatchdogPorts["submit"],
    notify: (notice) => notifications.push(notice),
    ...(input.stopSession === undefined ? {} : { stopSession: input.stopSession }),
    now: input.now ?? (() => T),
    onError: (error) => errors.push(error),
  });
  return { watchdog, submits, notifications, errors, byId };
}

describe("createSessionWatchdog", () => {
  it("records one durable blocked signal and one notification per wedge episode", async () => {
    const h = harness({ projections: [projection()] });

    await h.watchdog.scan();
    // The same silence, scanned again: the episode already spoke.
    await h.watchdog.scan();

    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]).toMatchObject({
      commandId: `watchdog:${SESSION}:0`,
      sessionId: SESSION,
      intent: {
        kind: "session.signal",
        signal: "blocked",
        reason: "Watchdog: no activity for 10m inside an open turn.",
      },
      provenance: { source: { kind: "system", id: "session-watchdog" } },
    });
    expect(h.notifications).toEqual([
      {
        title: "Session may be wedged",
        body: "Implementer has an open turn with no activity for 10m.",
      },
    ]);
  });

  it("reports a recovered Session again when it wedges a second time", async () => {
    const h = harness({ now: () => T * 3, projections: [projection({ lastActivityAt: T * 2 })] });

    await h.watchdog.scan();
    expect(h.submits).toHaveLength(1);

    // Recovery: new durable activity inside the threshold ends the episode…
    h.byId.set(SESSION, projection({ lastActivityAt: T * 2.5 }));
    await h.watchdog.scan();
    expect(h.submits).toHaveLength(1);

    // …and the next silence is a new episode with a new durable command id.
    h.byId.set(SESSION, projection({ lastActivityAt: T * 1.5 }));
    await h.watchdog.scan();
    expect(h.submits).toHaveLength(2);
    expect(h.submits[1]).toMatchObject({ commandId: `watchdog:${SESSION}:${T * 1.5}` });
  });

  it("leaves quiet, waiting, and stopped Sessions alone", async () => {
    const waiting = projection({
      session: { ...projection().session, id: "bbbbbbbb-0000-0000-0000-000000000000" },
      interactions: {
        active: [
          {
            id: "interaction-1",
            attachmentId: "attachment-1",
            kind: "permission" as const,
            title: "Allow?",
            detail: null,
            options: [],
            multiple: false,
            native: { id: null, detail: null },
          },
        ],
        resolved: [],
      },
    });
    const idle = projection({
      session: { ...projection().session, id: "cccccccc-0000-0000-0000-000000000000" },
      turnActive: false,
    });
    const stopped = projection({
      session: { ...projection().session, id: "dddddddd-0000-0000-0000-000000000000" },
      stopped: { at: 1, reason: null, by: { kind: "user" } },
    });
    const h = harness({ now: () => T * 10, projections: [waiting, idle, stopped] });

    await h.watchdog.scan();

    expect(h.submits).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it("stops the Session only when the self-terminate port is wired", async () => {
    const stops: unknown[] = [];
    const armed = harness({
      projections: [projection()],
      stopSession: async (input) => {
        stops.push(input);
      },
    });
    await armed.watchdog.scan();
    expect(stops).toEqual([{ sessionId: SESSION, silentForMs: T }]);
    // The signal still leads: a stop without the durable why would be the
    // wedge with better manners.
    expect(armed.submits).toHaveLength(1);

    const observing = harness({ projections: [projection()] });
    await observing.watchdog.scan();
    expect(observing.submits).toHaveLength(1);
  });

  it("swallows a failing projection with a diagnostic and keeps scanning the rest", async () => {
    const healthy = projection({
      session: { ...projection().session, id: "eeeeeeee-0000-0000-0000-000000000000" },
    });
    const h = harness({ projections: [healthy] });
    // A binding whose projection read throws: the scan carries on.
    h.byId.set("broken", undefined as never);

    await h.watchdog.scan();

    expect(h.errors).toHaveLength(1);
    expect(h.submits).toHaveLength(1);
  });

  describe("the interval", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("scans on its clock once started, and stops cleanly", async () => {
      const h = harness({ projections: [projection()] });

      h.watchdog.start();
      // Idempotent: a second start does not double the clock.
      h.watchdog.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.submits).toHaveLength(1);

      h.watchdog.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(h.submits).toHaveLength(1);
    });
  });
});
