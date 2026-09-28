/**
 * The scheduled-resume host against a real Session Engine and Session Runtime:
 * the schedule is a durable command, the resume an ordinary retry, the outcome
 * a settle — so what these tests read back is the ledger itself, which is what
 * a relaunch reads too.
 */
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  type BindingHandle,
  type HarnessCommand,
  type NativeHarnessAdapter,
  type ObservationSink,
  type SessionEngine,
  type SessionRuntime,
} from "@volli/session-engine";
import { pendingScheduledResume, type SessionCommand } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import type { NotificationRequest } from "../notifications/dispatch";
import { createScheduledResumeHost, SCHEDULED_RESUME_TICK_MS } from "./scheduled-resume";

const venue = { id: "machine-1", kind: "local" as const };
const RESET = 1_000_000;

class Executor implements NativeHarnessAdapter {
  readonly id = "pi";
  readonly durableIdNamespace = "pi";
  readonly adapterVersion = "1.0.0";
  readonly runtime = { path: "/pi", version: "1.0.0", fingerprint: "sha256:pi" };
  sink: ObservationSink | null = null;
  readonly commands: HarnessCommand[] = [];
  /** What a retry answers — accepted unless a test says otherwise. */
  retryAnswer: "accepted" | "rejected" = "accepted";
  /** Holds a retry open, as Pi's does for the whole resumed run. */
  retryGate: Promise<void> | null = null;

  async attach(
    _spec: Parameters<NativeHarnessAdapter["attach"]>[0],
    sink: ObservationSink,
  ): Promise<BindingHandle> {
    this.sink = sink;
    return {
      native: { id: "native-1", detail: null },
      authority: null,
      dispatch: async (command) => {
        this.commands.push(command);
        if (command.kind === "executor.retry") await this.retryGate;
        return command.kind === "executor.retry" && this.retryAnswer === "rejected"
          ? {
              commandId: command.commandId,
              status: "rejected" as const,
              code: "retry-unavailable",
              detail: "There is no failed Pi turn to retry.",
              native: null,
            }
          : {
              commandId: command.commandId,
              status: "accepted" as const,
              acceptedAt: 1,
              native: { id: command.commandId, detail: null },
            };
      },
      reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
      acknowledgeReconciliation: async () => undefined,
      release: async () => undefined,
    };
  }

  retries(): HarnessCommand[] {
    return this.commands.filter(({ kind }) => kind === "executor.retry");
  }
}

interface World {
  engine: SessionEngine;
  runtime: SessionRuntime;
  executor: Executor;
  clock: { now: number };
}

function world(): World {
  const clock = { now: 100 };
  const now = () => clock.now++;
  let sequence = 0;
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock: { now },
    ids: { next: (kind) => `${kind}-${++sequence}` },
  });
  const executor = new Executor();
  const at = async () => ({ directory: "/projects/p", venue });
  const runtime = createSessionRuntime({
    engine,
    executor,
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: { resolve: at, prepare: at, reaffirm: async () => undefined },
    clock: { now },
    ids: { next: (kind: string) => `runtime-${kind}-${++sequence}` },
  });
  return { engine, runtime, executor, clock };
}

/** A Ticket Session whose run just stopped on a spent allowance resetting at {@link RESET}. */
async function stoppedSession(w: World, commandId = "create-1") {
  const created = await w.runtime.command({
    commandId,
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      parentSessionId: null,
      title: "Implementer",
    },
  });
  const sessionId = created.sessionId;
  await w.runtime.command({
    commandId: `${commandId}:attach`,
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  await w.executor.sink!.emit({
    kind: "attention",
    state: "raised",
    reason: "runtime-failure",
    message: "429: Usage limit reached for 5 hour.",
    resetsAt: RESET,
  });
  const projection = (await w.runtime.projection({ sessionId })).projection;
  return {
    sessionId,
    attentionId: projection.attention.primary!.id,
    attachmentId: projection.liveExecutor!.id,
  };
}

async function schedule(
  w: World,
  session: { sessionId: string; attentionId: string; attachmentId: string },
  scheduleId = "schedule-1",
) {
  const result = await w.runtime.command({
    commandId: scheduleId,
    sessionId: session.sessionId,
    command: {
      kind: "resume.schedule",
      attentionId: session.attentionId,
      attachmentId: session.attachmentId,
      resumeAt: RESET,
    },
  });
  expect(result.receipt?.status).toBe("completed");
}

function host(
  w: World,
  candidates: () => Promise<readonly string[]>,
  command: SessionRuntime["command"] = (request) => w.runtime.command(request),
) {
  const notifications: NotificationRequest[] = [];
  const delays: number[] = [];
  const errors: unknown[] = [];
  const resumeHost = createScheduledResumeHost({
    candidates,
    projection: async (sessionId) => (await w.runtime.projection({ sessionId })).projection,
    ticketSessions: ({ projectId, ticketId }) =>
      w.engine.listSessions({ projectId, scope: "ticket", ticketId }),
    command,
    notify: (request) => notifications.push(request),
    now: () => w.clock.now,
    setTimer: (delay) => {
      delays.push(delay);
      return setTimeout(() => undefined, 0);
    },
    clearTimer: (handle) => clearTimeout(handle),
    onError: (error) => errors.push(error),
  });
  return { resumeHost, notifications, delays, errors };
}

async function settleOf(w: World, sessionId: string): Promise<SessionCommand | undefined> {
  const projection = (await w.runtime.projection({ sessionId })).projection;
  return projection.commands.find(({ intent }) => intent.kind === "resume.settle");
}

describe("the scheduled-resume host", () => {
  it("waits for the reset, then resumes through the retry door and settles it", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    const { resumeHost, notifications, delays } = host(w, async () => [session.sessionId]);

    await resumeHost.start();
    expect(w.executor.retries()).toEqual([]);
    // Sleeps no longer than a tick, however far away the reset is.
    expect(delays.at(-1)).toBe(SCHEDULED_RESUME_TICK_MS);

    w.clock.now = RESET;
    await resumeHost.pass();
    await resumeHost.settled();

    expect(w.executor.retries()).toEqual([
      expect.objectContaining({
        commandId: "schedule-1:resume",
        attachmentId: session.attachmentId,
      }),
    ]);
    expect((await settleOf(w, session.sessionId))?.intent).toEqual({
      kind: "resume.settle",
      scheduleId: "schedule-1",
      outcome: { kind: "resumed", retryCommandId: "schedule-1:resume" },
    });
    // Nothing to tell: the resumed run speaks for itself.
    expect(notifications).toEqual([]);
    resumeHost.stop();
  });

  it("arms the exact remainder when the reset is inside a tick", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    const { resumeHost, delays } = host(w, async () => [session.sessionId]);
    w.clock.now = RESET - 5_000;

    await resumeHost.start();

    expect(delays.at(-1)).toBe(5_000);
    resumeHost.stop();
  });

  it("never runs a second turn for one schedule, however many passes reach it", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    const { resumeHost } = host(w, async () => [session.sessionId]);
    w.clock.now = RESET;

    await Promise.all([resumeHost.start(), resumeHost.pass(), resumeHost.pass()]);
    await resumeHost.settled();
    await resumeHost.pass();
    await resumeHost.settled();

    expect(w.executor.retries()).toHaveLength(1);
    resumeHost.stop();
  });

  it("holds a resume in flight for as long as its run, and settles it after", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    const run = Promise.withResolvers<void>();
    w.executor.retryGate = run.promise;
    const { resumeHost } = host(w, async () => [session.sessionId]);
    w.clock.now = RESET;

    await resumeHost.start();
    // The run is going: another pass neither fires again nor settles early.
    await resumeHost.pass();
    expect(w.executor.retries()).toHaveLength(1);
    expect(await settleOf(w, session.sessionId)).toBeUndefined();

    run.resolve();
    await resumeHost.settled();
    expect((await settleOf(w, session.sessionId))?.intent).toMatchObject({
      outcome: { kind: "resumed" },
    });
    resumeHost.stop();
  });

  it("leaves a run cut short by shutdown for the next launch to settle", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    const run = Promise.withResolvers<void>();
    const { resumeHost } = host(
      w,
      async () => [session.sessionId],
      (request) =>
        request.command.kind === "executor.retry"
          ? run.promise.then(() => Promise.reject(new Error("runtime closed")))
          : w.runtime.command(request),
    );
    w.clock.now = RESET;

    await resumeHost.start();
    resumeHost.stop();
    run.resolve();
    await resumeHost.settled();

    expect(await settleOf(w, session.sessionId)).toBeUndefined();
  });

  it("records a retry that threw as refused", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    const { resumeHost, notifications } = host(
      w,
      async () => [session.sessionId],
      (request) =>
        request.command.kind === "executor.retry"
          ? Promise.reject(new Error("binding lost"))
          : w.runtime.command(request),
    );
    w.clock.now = RESET;

    await resumeHost.start();
    await resumeHost.settled();

    expect((await settleOf(w, session.sessionId))?.intent).toMatchObject({
      outcome: { kind: "skipped", reason: "refused", detail: "binding lost" },
    });
    expect(notifications).toHaveLength(1);
  });

  it("survives a relaunch: a new host finds the schedule and fires it", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    const first = host(w, async () => [session.sessionId]);
    await first.resumeHost.start();
    first.resumeHost.stop();

    // The app was closed through the reset; the next launch's first pass fires it.
    w.clock.now = RESET + 3_600_000;
    const second = host(w, async () => [session.sessionId]);
    await second.resumeHost.start();
    await second.resumeHost.settled();

    expect(w.executor.retries()).toHaveLength(1);
    expect(pendingScheduledResume((await w.runtime.projection(session)).projection)).toBeNull();
    second.resumeHost.stop();
  });

  it("settles, without a second turn, a retry a crash left unsettled", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    // The previous process issued the retry and died before its settle.
    await w.runtime.command({
      commandId: "schedule-1:resume",
      sessionId: session.sessionId,
      command: { kind: "executor.retry", attachmentId: session.attachmentId },
    });
    const { resumeHost, notifications } = host(w, async () => [session.sessionId]);

    await resumeHost.start();

    expect(w.executor.retries()).toHaveLength(1);
    expect((await settleOf(w, session.sessionId))?.intent).toMatchObject({
      outcome: { kind: "resumed" },
    });
    expect(notifications).toEqual([]);
  });

  it("does nothing for a cancelled schedule, and forgets the Session", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    await w.runtime.command({
      commandId: "cancel-1",
      sessionId: session.sessionId,
      command: { kind: "resume.cancel", scheduleId: "schedule-1" },
    });
    const { resumeHost, notifications, delays } = host(w, async () => [session.sessionId]);
    w.clock.now = RESET;

    await resumeHost.start();
    await resumeHost.settled();

    expect(w.executor.retries()).toEqual([]);
    expect(await settleOf(w, session.sessionId)).toBeUndefined();
    expect(notifications).toEqual([]);
    // Nothing left to wait for: the timer only ticks.
    expect(delays.at(-1)).toBe(SCHEDULED_RESUME_TICK_MS);
  });

  it("skips, durably and aloud, a Session the person continued", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    await w.runtime.command({
      commandId: "retry-by-hand",
      sessionId: session.sessionId,
      command: { kind: "executor.retry", attachmentId: session.attachmentId },
    });
    const { resumeHost, notifications } = host(w, async () => [session.sessionId]);
    w.clock.now = RESET;

    await resumeHost.start();

    // Only the person's own retry ran.
    expect(w.executor.retries().map(({ commandId }) => commandId)).toEqual(["retry-by-hand"]);
    expect((await settleOf(w, session.sessionId))?.intent).toMatchObject({
      outcome: { kind: "skipped", reason: "continued" },
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        producer: "scheduled-resume-skipped",
        title: "Resume skipped",
        body: "Implementer was continued before its resume.",
        target: expect.objectContaining({ kind: "session", sessionId: session.sessionId }),
      }),
    ]);
  });

  it("skips a Session another on its Ticket moved past after the schedule", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    const newer = await stoppedSession(w, "create-2");
    await w.runtime.command({
      commandId: "newer-retry",
      sessionId: newer.sessionId,
      command: { kind: "executor.retry", attachmentId: newer.attachmentId },
    });
    const { resumeHost, notifications } = host(w, async () => [session.sessionId]);
    w.clock.now = RESET;

    await resumeHost.start();

    expect(w.executor.retries().map(({ commandId }) => commandId)).toEqual(["newer-retry"]);
    expect((await settleOf(w, session.sessionId))?.intent).toMatchObject({
      outcome: { kind: "skipped", reason: "superseded" },
    });
    expect(notifications.map(({ body }) => body)).toEqual([
      "Implementer was passed over for a newer Session on its ticket.",
    ]);
  });

  it("skips an archived Session as ended", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    await w.engine.submit({
      commandId: "archive",
      sessionId: session.sessionId,
      intent: { kind: "session.archive" },
      provenance: { source: { kind: "user", id: "person", detail: null }, venue },
    });
    const { resumeHost, notifications } = host(w, async () => [session.sessionId]);
    w.clock.now = RESET;

    await resumeHost.start();

    expect(w.executor.retries()).toEqual([]);
    expect((await settleOf(w, session.sessionId))?.intent).toMatchObject({
      outcome: { kind: "skipped", reason: "ended" },
    });
    expect(notifications.map(({ body }) => body)).toEqual([
      "Implementer was stopped before its resume.",
    ]);
  });

  it("records a refused retry as a skip, and says so", async () => {
    const w = world();
    const session = await stoppedSession(w);
    await schedule(w, session);
    w.executor.retryAnswer = "rejected";
    const { resumeHost, notifications } = host(w, async () => [session.sessionId]);
    w.clock.now = RESET;

    await resumeHost.start();
    await resumeHost.settled();

    expect((await settleOf(w, session.sessionId))?.intent).toMatchObject({
      outcome: {
        kind: "skipped",
        reason: "refused",
        detail: "There is no failed Pi turn to retry.",
      },
    });
    expect(notifications.map(({ body }) => body)).toEqual(["Implementer could not be resumed."]);
  });

  it("picks up a schedule the activity watch reports, and drops one that ended", async () => {
    const w = world();
    const session = await stoppedSession(w);
    const { resumeHost, delays } = host(w, async () => []);
    await resumeHost.start();
    const before = delays.length;

    await schedule(w, session);
    w.clock.now = RESET - 30_000;
    resumeHost.observe((await w.runtime.projection(session)).projection);
    await resumeHost.settled();
    // Seen at once, and the timer re-armed at the reset.
    expect(delays.length).toBe(before + 1);
    expect(delays.at(-1)).toBe(30_000);
    // The same schedule observed again is not news.
    resumeHost.observe((await w.runtime.projection(session)).projection);
    await resumeHost.settled();
    expect(delays.length).toBe(before + 1);

    await w.runtime.command({
      commandId: "cancel-1",
      sessionId: session.sessionId,
      command: { kind: "resume.cancel", scheduleId: "schedule-1" },
    });
    resumeHost.observe((await w.runtime.projection(session)).projection);
    w.clock.now = RESET;
    await resumeHost.pass();
    expect(w.executor.retries()).toEqual([]);
    resumeHost.stop();
  });

  it("reports a failed read and keeps looking", async () => {
    const w = world();
    const { resumeHost, errors, delays } = host(w, async () => {
      throw new Error("database closed");
    });

    await resumeHost.start();

    expect(errors).toEqual([new Error("database closed")]);
    expect(delays).toEqual([SCHEDULED_RESUME_TICK_MS]);
    resumeHost.stop();
    await resumeHost.pass();
    expect(delays).toEqual([SCHEDULED_RESUME_TICK_MS]);
  });
});
