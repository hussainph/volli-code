/**
 * The runner's `automation.run` executor, through the real inbox worker, the
 * real job payload codec and the runner's SQLite job journal, over a fake
 * backend inbox and a fake Session world that keeps its state across a
 * "crash" (a stopped worker whose in-flight work never finishes, then a new
 * boot that re-leases the job).
 */
import { describe, expect, it, vi } from "vite-plus/test";

import { UNBOUND_RUN_LABEL, type SessionProjection } from "@volli/shared";
import type {
  AutomationRunContext,
  AutomationRunContextRequest,
  AutomationRunJobPayload,
  ClaimedJob,
  CloudAutomationDefinition,
  JobOutcome,
  RunnerId,
} from "@volli/shared/cloud";

import { createInboxWorker, type InboxBackend } from "../cloud-runner/inbox";
import { sqliteJobJournalStore } from "../cloud-runner/sqlite-stores";
import { automationRunIds } from "../cloud-runner/derived-id";
import { openTestDb } from "../db/test-helpers";
import { StructuredSessionsError, type SessionStartInput } from "../session-runtime/sessions";
import { SessionOwnerError } from "./owner";
import {
  AUTOMATION_RUN_CAPABILITY,
  createAutomationRunExecutor,
  registerAutomationRunJob,
  type AutomationRunSessions,
} from "./automation-jobs";

const RUNNER = "33333333-2222-4333-8444-555555555555" as RunnerId;
const OTHER_RUNNER = "44444444-2222-4333-8444-555555555555" as RunnerId;
const PROJECT = "11111111-2222-4333-8444-555555555555";
const TICKET = "66666666-2222-4333-8444-555555555555";
const AUTOMATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const USER = "99999999-8888-4777-8666-555555555555";
const SESSION = "55555555-2222-4333-8444-555555555555";
const RUN = "12121212-2222-4333-8444-555555555555";
const JOB = "88888888-2222-4333-8444-555555555555";
const MODEL = { providerId: "anthropic", modelId: "claude", reasoningLevel: "high" } as const;
const IDS = automationRunIds(RUN);

const definition: CloudAutomationDefinition = {
  id: AUTOMATION as CloudAutomationDefinition["id"],
  projectId: PROJECT as CloudAutomationDefinition["projectId"],
  name: "Review",
  instructions: "Review the work",
  trigger: { kind: "columns", columns: ["doing"] },
  runtime: null,
  deletedAt: null,
};
const common = {
  runId: RUN,
  sessionId: SESSION,
  dueAt: 1_000,
  missedCount: 0,
  attendance: "unattended",
  modelOverride: null,
  requestedBySessionId: null,
};
const arrival = {
  ...common,
  trigger: "arrival",
  automationId: AUTOMATION,
  ticketId: TICKET,
  from: "todo",
  status: "doing",
  origin: "armed",
  armedByUserId: USER,
} as unknown as AutomationRunJobPayload;

function claimed(payload: unknown, attempt = 1, bootId = "boot-1"): ClaimedJob {
  const ticketId = (payload as { ticketId?: string | null }).ticketId ?? null;
  return {
    job: {
      id: JOB,
      runnerId: RUNNER,
      kind: "automation.run",
      projectId: PROJECT,
      sessionId: null,
      ticketId,
      workingCopyId: null,
      commandId: null,
      payload,
      priority: "normal",
      createdBy: { kind: "volli", reason: "policy" },
      createdAt: 0,
      availableAt: 0,
    },
    lease: { bootId, expiresAt: 60_000, attempt },
  } as unknown as ClaimedJob;
}

function readyContext(
  payload: AutomationRunJobPayload,
  overrides: Partial<Extract<AutomationRunContext, { kind: "ready" }>> = {},
): AutomationRunContext {
  return {
    kind: "ready",
    payload,
    projectId: PROJECT,
    automation:
      payload.trigger === "schedule"
        ? {
            ...definition,
            trigger: {
              kind: "schedule",
              schedule: { preset: "daily", hour: 9, minute: 0, timeZone: "UTC" },
            },
          }
        : definition,
    ticket:
      payload.ticketId === null
        ? null
        : { id: TICKET, projectId: PROJECT, status: "doing", archived: false },
    columnArming: { automationId: AUTOMATION, runnerId: RUNNER, pausedAt: null },
    scheduleArming: { automationId: AUTOMATION, runnerId: RUNNER, pausedAt: null },
    previousRunActive: false,
    ...overrides,
  } as AutomationRunContext;
}

/** Session state that survives a crash, as the SQLite ledger does. */
function sessionWorld() {
  const sessions = new Map<string, { commands: string[]; model: typeof MODEL | null }>();
  const creates: SessionStartInput[] = [];
  const attaches: string[] = [];
  const messages: { commandId: string; command: Record<string, unknown> }[] = [];
  const failures: unknown[] = [];
  const titles: unknown[] = [];
  let hangDelivery = false;
  let hangBirth = false;
  let hangAfterDelivery = false;
  let attachReady = true;
  let receipt: Record<string, unknown> = { status: "accepted" };
  let createError: Error | null = null;
  const ports: AutomationRunSessions = {
    sessions: {
      create: vi.fn(async (input: SessionStartInput) => {
        creates.push(input);
        if (createError !== null) throw createError;
        const id = input.requestedSessionId!;
        // The facade's birth: the create command first, then the model.
        if (!sessions.has(id))
          sessions.set(id, { commands: [`${input.operationId}:create`], model: null });
        if (hangBirth) return new Promise<never>(() => {});
        sessions.get(id)!.model = MODEL;
        return { sessionId: id, model: MODEL };
      }),
      attach: vi.fn(async (input) => {
        attaches.push(input.operationId);
        return {
          sessionId: input.sessionId,
          state: attachReady ? ("ready" as const) : ("needs-recovery" as const),
          receipt: null,
          throughSequence: 0,
        };
      }),
    },
    runtime: {
      openNativeBindings: () => [],
      reportMessageDeliveryFailure: vi.fn(async (failure) => {
        failures.push(failure);
      }),
      command: vi.fn(async (request) => {
        const sessionId = (request as { sessionId: string }).sessionId;
        if (hangDelivery) return new Promise<never>(() => {});
        const record = sessions.get(sessionId)!;
        if (!record.commands.includes(request.commandId)) {
          record.commands.push(request.commandId);
          messages.push({ commandId: request.commandId, command: request.command });
        }
        if (hangAfterDelivery) return new Promise<never>(() => {});
        return { receipt } as never;
      }),
    } as AutomationRunSessions["runtime"],
    promptSupply: async () => ({ templates: [], skills: [] }),
    refineAutoTitle: (request) => void titles.push(request),
  };
  return {
    ports,
    creates,
    attaches,
    messages,
    failures,
    titles,
    engine: {
      getSession: async ({ sessionId }: { sessionId: string }) => {
        const record = sessions.get(sessionId);
        return record === undefined
          ? null
          : ({
              commands: record.commands.map((id) => ({ id })),
              modelSelection: record.model,
            } as unknown as SessionProjection);
      },
    },
    hangDelivery: (value: boolean) => {
      hangDelivery = value;
    },
    hangBirth: (value: boolean) => {
      hangBirth = value;
    },
    hangAfterDelivery: (value: boolean) => {
      hangAfterDelivery = value;
    },
    attachReady: (value: boolean) => {
      attachReady = value;
    },
    receipt: (value: Record<string, unknown>) => {
      receipt = value;
    },
    createError: (error: Error | null) => {
      createError = error;
    },
  };
}

/** One job, leased per boot as the backend does: a new boot's claim takes it again. */
function backendInbox(payload: unknown) {
  const completes: { attempt: number; outcome: JobOutcome }[] = [];
  let attempt = 0;
  let claimable = true;
  let renewOk = true;
  const backend = (bootId: string): InboxBackend => ({
    claim: async () => {
      if (!claimable) return [];
      claimable = false;
      attempt += 1;
      return [claimed(payload, attempt, bootId)];
    },
    renew: async () =>
      renewOk
        ? { ok: true, lease: { bootId, expiresAt: 60_000, attempt } }
        : { ok: false, reason: "fenced" },
    complete: async (args) => {
      completes.push({ attempt: args.attempt, outcome: args.outcome });
      return { ack: "recorded", status: "done" };
    },
  });
  return {
    backend,
    completes,
    /** The lease ran out with the process: the next boot may claim it. */
    expire: () => {
      claimable = true;
    },
    renewOk: (value: boolean) => {
      renewOk = value;
    },
  };
}

function harness(payload: unknown = arrival) {
  const db = openTestDb();
  const world = sessionWorld();
  const inbox = backendInbox(payload);
  const contexts: AutomationRunContextRequest[] = [];
  let context: (request: AutomationRunContextRequest) => AutomationRunContext = () =>
    readyContext(payload as AutomationRunJobPayload);
  let bound: AutomationRunSessions | null = world.ports;
  const born: unknown[] = [];
  function boot(bootId: string) {
    const worker = createInboxWorker({
      backend: inbox.backend(bootId),
      journal: sqliteJobJournalStore(db.db, USER),
      bootId,
      setTimer: () => null,
      clearTimer: () => {},
    });
    registerAutomationRunJob(worker, {
      runnerId: RUNNER,
      engine: world.engine,
      sessions: async () => bound,
      runContext: async (request) => {
        contexts.push(request);
        return context(request);
      },
      onSessionBorn: (input) => void born.push(input),
      newOperationId: () => `attach-${world.attaches.length + 1}`,
    });
    return worker;
  }
  return {
    db,
    world,
    inbox,
    contexts,
    born,
    boot,
    context: (next: typeof context) => {
      context = next;
    },
    unbind: () => {
      bound = null;
    },
    async run(bootId = "boot-1") {
      const worker = boot(bootId);
      await worker.start();
      await vi.waitFor(() => expect(inbox.completes.length).toBeGreaterThan(0));
      worker.stop();
      return inbox.completes.at(-1)!.outcome;
    },
  };
}

describe("the automation.run executor", () => {
  it("starts an armed arrival as a runner-born Session under derived ids, then completes started", async () => {
    const h = harness();
    const outcome = await h.run();

    expect(outcome).toEqual({
      status: "done",
      result: { kind: "started", sessionId: SESSION, model: MODEL, attendance: "unattended" },
    });
    expect(h.contexts).toEqual([{ jobId: JOB, bootId: "boot-1", attempt: 1 }]);
    expect(h.world.creates).toEqual([
      {
        operationId: `automation-run:${RUN}`,
        requestedSessionId: SESSION,
        projectId: PROJECT,
        ticketId: TICKET,
        role: "ticket",
        title: "Review",
        actor: { kind: "automation" },
        origin: { kind: "automation", automationRunId: RUN, automationName: "Review" },
        autoSelect: { request: "Review the work" },
      },
    ]);
    expect(h.world.messages).toEqual([
      {
        commandId: IDS.messageCommandId,
        command: {
          kind: "message.submit",
          settle: "opened",
          message: {
            id: IDS.messageId,
            role: "user",
            parts: [{ type: "text", text: "Review the work" }],
          },
        },
      },
    ]);
    expect(h.born).toEqual([{ sessionId: SESSION, attendance: "unattended", fresh: true }]);
    expect(h.world.titles).toEqual([
      {
        sessionId: SESSION,
        firstMessage: "Review the work",
        heuristicTitle: "Review",
        automation: { name: "Review" },
      },
    ]);
  });

  it("a kill after the Session starts resumes the same Session with one first message", async () => {
    const h = harness();
    // Boot one: the Session is minted, then the process dies mid-delivery.
    h.world.hangDelivery(true);
    const first = h.boot("boot-1");
    await first.start();
    await vi.waitFor(() => expect(h.world.creates).toHaveLength(1));
    await vi.waitFor(() => expect(h.world.ports.runtime.command).toHaveBeenCalledOnce());
    first.stop();
    expect(h.inbox.completes).toEqual([]);

    // Boot two re-leases the job: no second Session, no second message.
    h.world.hangDelivery(false);
    h.inbox.expire();
    const outcome = await h.run("boot-2");

    expect(outcome).toMatchObject({
      status: "done",
      result: { kind: "started", sessionId: SESSION },
    });
    expect(h.inbox.completes).toEqual([{ attempt: 2, outcome }]);
    // The birth is replayed under the same operation id: one Session.
    expect(h.world.creates.map((create) => create.operationId)).toEqual([
      IDS.operationId,
      IDS.operationId,
    ]);
    expect(h.world.messages.map((message) => message.commandId)).toEqual([IDS.messageCommandId]);
    // Still no first message, so still a known "needs nobody" baseline.
    expect(h.born.at(-1)).toEqual({ sessionId: SESSION, attendance: "unattended", fresh: true });
  });

  it("a kill mid-birth (after session.create, before its model) finishes that birth on resume", async () => {
    const h = harness();
    h.world.hangBirth(true);
    const first = h.boot("boot-1");
    await first.start();
    await vi.waitFor(() => expect(h.world.creates).toHaveLength(1));
    first.stop();
    // The Session exists, half-born, with no model and no first message.
    expect(await h.world.engine.getSession({ sessionId: SESSION })).toMatchObject({
      modelSelection: null,
    });
    h.world.hangBirth(false);
    h.inbox.expire();
    const outcome = await h.run("boot-2");
    expect(outcome).toMatchObject({
      result: { kind: "started", sessionId: SESSION, model: MODEL },
    });
    expect(new Set(h.world.creates.map((create) => create.operationId))).toEqual(
      new Set([IDS.operationId]),
    );
    expect(h.world.messages).toHaveLength(1);
  });

  it("a kill after the first message resumes to completion without touching the Session", async () => {
    const h = harness();
    // The first message is durable, then the process dies before the outcome.
    h.world.hangAfterDelivery(true);
    const first = h.boot("boot-1");
    await first.start();
    await vi.waitFor(() => expect(h.world.messages).toHaveLength(1));
    first.stop();
    h.world.hangAfterDelivery(false);
    h.inbox.expire();
    h.context(() => {
      throw new Error("a delivered Run needs no context");
    });
    const outcome = await h.run("boot-2");
    expect(outcome).toMatchObject({ status: "done", result: { kind: "started", model: MODEL } });
    expect(h.world.creates).toHaveLength(1);
    expect(h.world.messages).toHaveLength(1);
    expect(h.world.attaches).toHaveLength(1);
  });

  it("a kill after the outcome is journaled reports it again without running again", async () => {
    const h = harness();
    // The report never answers: the outcome stays owed in the journal.
    const backend = h.inbox.backend("boot-1");
    const worker = createInboxWorker({
      backend: { ...backend, complete: async () => new Promise<never>(() => {}) },
      journal: sqliteJobJournalStore(h.db.db, USER),
      bootId: "boot-1",
      setTimer: () => null,
      clearTimer: () => {},
    });
    registerAutomationRunJob(worker, {
      runnerId: RUNNER,
      engine: h.world.engine,
      sessions: async () => h.world.ports,
      runContext: async () => readyContext(arrival),
    });
    await worker.start();
    await vi.waitFor(() =>
      expect(sqliteJobJournalStore(h.db.db, USER).unreported()).toHaveLength(1),
    );
    worker.stop();
    const restarted = h.boot("boot-2");
    await restarted.start();
    await vi.waitFor(() => expect(h.inbox.completes).toHaveLength(1));
    restarted.stop();
    expect(h.inbox.completes[0]!.outcome).toMatchObject({ result: { kind: "started" } });
    expect(h.world.creates).toHaveLength(1);
  });

  it.each([
    [
      "the ticket left the column",
      { ticket: { id: TICKET, projectId: PROJECT, status: "needs_review", archived: false } },
      "left-column",
    ],
    ["the column was disarmed", { columnArming: null }, "disarmed"],
    [
      "the column was paused",
      { columnArming: { automationId: AUTOMATION, runnerId: RUNNER, pausedAt: 5 } },
      "disarmed",
    ],
    [
      "the column was re-armed on another runner",
      { columnArming: { automationId: AUTOMATION, runnerId: OTHER_RUNNER, pausedAt: null } },
      "disarmed",
    ],
    ["the Automation was deleted", { automation: null }, "gone"],
    ["an earlier Run is still working", { previousRunActive: true }, "previous_run_active"],
  ])("skips before the claim's Session when %s", async (_name, overrides, reason) => {
    const h = harness();
    h.context(() => readyContext(arrival, overrides as never));
    expect(await h.run()).toEqual({ status: "done", result: { kind: "abandoned", reason } });
    expect(h.world.creates).toEqual([]);
    expect(h.world.messages).toEqual([]);
  });

  it("starts nothing once the lease is lost, before or at the start fence", async () => {
    const h = harness();
    h.context(() => ({ kind: "unavailable", reason: "lease_lost" }));
    expect(await h.run()).toMatchObject({ status: "failed", code: "lease_lost", retryable: false });
    const fenced = harness();
    fenced.inbox.renewOk(false);
    expect(await fenced.run()).toMatchObject({ status: "failed", code: "lease_lost" });
    expect(fenced.contexts).toHaveLength(1);
    for (const each of [h, fenced]) expect(each.world.creates).toEqual([]);
  });

  it("refuses, with nothing started, when this runner's model cannot run it", async () => {
    const h = harness({
      ...common,
      trigger: "manual",
      attendance: "attended",
      automationId: AUTOMATION,
      ticketId: TICKET,
      armedByUserId: null,
      modelOverride: { providerId: "gone", modelId: "model", reasoningLevel: "low" },
    });
    h.world.createError(
      new StructuredSessionsError("MODEL_UNAVAILABLE", "Model gone is not available."),
    );
    expect(await h.run()).toEqual({
      status: "done",
      result: {
        kind: "refused",
        code: "MODEL_UNAVAILABLE",
        detail: "Model gone is not available.",
      },
    });
    // The invocation's override, refused before anything durable exists.
    expect(h.world.creates[0]!.modelOverride).toEqual({
      model: { providerId: "gone", modelId: "model" },
      reasoningLevel: "low",
      whenUnavailable: "refuse",
    });
    expect(h.world.messages).toEqual([]);
    // Attendance is noted before the birth, so a crash cannot lose it.
    expect(h.born).toEqual([{ sessionId: SESSION, attendance: "attended", fresh: true }]);
  });

  it("refuses an invalid saved Runtime and resolves a tier on this runner", async () => {
    const h = harness();
    h.context(() =>
      readyContext(arrival, {
        automation: { ...definition, runtime: { kind: "invalid", raw: 1 } },
      }),
    );
    expect(await h.run()).toMatchObject({ result: { kind: "refused", code: "invalid_runtime" } });
    expect(h.world.creates).toEqual([]);
    const tier = harness();
    tier.context(() =>
      readyContext(arrival, {
        automation: { ...definition, runtime: { kind: "tier", tier: "deep" } },
      }),
    );
    await tier.run();
    expect(tier.world.creates[0]!.modelOverride).toEqual({
      tier: "deep",
      whenUnavailable: "refuse",
    });
  });

  it("opens a schedule's Board Session, and words an Unbound Run by its label", async () => {
    const schedule = {
      ...common,
      trigger: "schedule",
      automationId: AUTOMATION,
      ticketId: null,
      armedByUserId: USER,
    };
    const h = harness(schedule);
    await h.run();
    expect(h.world.creates[0]).toMatchObject({ role: "project", ticketId: null, title: "Review" });

    const unbound = {
      ...common,
      trigger: "manual",
      attendance: "attended",
      automationId: null,
      ticketId: TICKET,
      armedByUserId: null,
      instructions: "Tidy the README",
    };
    const u = harness(unbound);
    u.context(() => readyContext(unbound as AutomationRunJobPayload, { automation: null }));
    expect(await u.run()).toMatchObject({ result: { kind: "started", attendance: "attended" } });
    expect(u.world.creates[0]).toMatchObject({
      title: UNBOUND_RUN_LABEL,
      origin: { automationName: null },
      autoSelect: { request: "Tidy the README" },
    });
    expect(u.world.titles[0]).toEqual({
      sessionId: SESSION,
      firstMessage: "Tidy the README",
      heuristicTitle: UNBOUND_RUN_LABEL,
    });
  });

  it("holds the first message for the Session's Retry when its attach is not ready", async () => {
    const h = harness();
    h.world.attachReady(false);
    expect(await h.run()).toMatchObject({ result: { kind: "started" } });
    expect(h.world.messages[0]!.command).toMatchObject({
      kind: "message.submit",
      delivery: "queue",
    });
    expect(h.world.titles).toEqual([]);
  });

  it("records a refused first message as Session Attention and still reports the Run started", async () => {
    const h = harness();
    h.world.receipt({ status: "rejected", code: "busy", detail: null });
    expect(await h.run()).toMatchObject({ result: { kind: "started" } });
    expect(h.world.failures).toEqual([
      {
        sessionId: SESSION,
        commandId: IDS.messageCommandId,
        detail: "The Automation Run's first message was not delivered: busy",
      },
    ]);
  });

  it("refuses a resumed Run whose Automation was deleted before its message was sent", async () => {
    const h = harness();
    h.world.hangDelivery(true);
    const first = h.boot("boot-1");
    await first.start();
    await vi.waitFor(() => expect(h.world.ports.runtime.command).toHaveBeenCalledOnce());
    first.stop();
    h.world.hangDelivery(false);
    h.context(() => readyContext(arrival, { automation: null }));
    h.inbox.expire();
    // The Session exists, so the Run failed (and its armer hears), not skipped.
    expect(await h.run("boot-2")).toEqual({
      status: "done",
      result: { kind: "refused", code: "gone", detail: "The Automation no longer exists." },
    });
  });

  it("refuses what it cannot execute without starting anything", async () => {
    const legacy = harness({
      trigger: "arrival",
      automationId: AUTOMATION,
      ticketId: TICKET,
      from: "todo",
      status: "doing",
      origin: "armed",
      armedByUserId: USER,
    });
    expect(await legacy.run()).toMatchObject({ status: "failed", code: "legacy_automation_run" });
    // A newer producer's field this build does not know is refused, not guessed.
    const newer = harness({ ...arrival, priorityHint: 1 });
    expect(await newer.run()).toMatchObject({ status: "failed", code: "invalid_job_payload" });
    const mismatch = harness();
    mismatch.context(() =>
      readyContext({ ...arrival, runId: "13131313-2222-4333-8444-555555555555" }),
    );
    expect(await mismatch.run()).toMatchObject({ status: "failed", code: "context_mismatch" });
    for (const h of [legacy, newer, mismatch]) expect(h.world.creates).toEqual([]);
  });

  it("waits for the runtime rather than guessing, and retries if it never comes", async () => {
    const h = harness();
    h.unbind();
    expect(await h.run()).toMatchObject({
      status: "failed",
      code: "runtime_unavailable",
      retryable: true,
    });
  });

  it("refuses another runner's job and a Session id another Session holds", async () => {
    const executor = createAutomationRunExecutor({
      runnerId: OTHER_RUNNER,
      engine: { getSession: async () => null },
      sessions: async () => null,
      runContext: async () => readyContext(arrival),
    });
    const context = { signal: new AbortController().signal, renew: async () => true };
    expect(await executor(claimed(arrival), context)).toMatchObject({ code: "not_your_runner" });
    const taken = createAutomationRunExecutor({
      runnerId: RUNNER,
      engine: {
        getSession: async () =>
          ({ commands: [{ id: "someone-else:create" }], modelSelection: MODEL }) as never,
      },
      sessions: async () => sessionWorld().ports,
      runContext: async () => readyContext(arrival),
    });
    expect(await taken(claimed(arrival), context)).toMatchObject({ code: "session_conflict" });
  });

  it("never retries a Session id another account holds", async () => {
    const h = harness();
    h.world.createError(new SessionOwnerError());
    expect(await h.run()).toMatchObject({
      status: "failed",
      code: "not_your_runner",
      retryable: false,
    });
  });

  it("resumes an Unbound Run with its own text after a kill", async () => {
    const unbound = {
      ...common,
      trigger: "manual",
      attendance: "attended",
      automationId: null,
      ticketId: TICKET,
      armedByUserId: null,
      instructions: "Tidy the README",
    };
    const h = harness(unbound);
    h.context(() => readyContext(unbound as AutomationRunJobPayload));
    h.world.hangDelivery(true);
    const first = h.boot("boot-1");
    await first.start();
    await vi.waitFor(() => expect(h.world.ports.runtime.command).toHaveBeenCalledOnce());
    first.stop();
    h.world.hangDelivery(false);
    h.inbox.expire();
    expect(await h.run("boot-2")).toMatchObject({ result: { kind: "started" } });
    expect(h.world.messages).toMatchObject([
      { command: { message: { parts: [{ type: "text", text: "Tidy the README" }] } } },
    ]);
  });

  it("names the capability it executes", () => {
    expect(AUTOMATION_RUN_CAPABILITY).toBe("automation.run");
  });
});
