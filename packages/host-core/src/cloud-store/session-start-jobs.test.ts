/**
 * The runner's `session.start` executor, through the real inbox worker, the
 * real job payload codec, the runner's SQLite job journal and a real
 * transcript artifact store, over a fake backend inbox and a fake Session
 * world that keeps its state across a "crash" (a stopped worker whose
 * in-flight work never finishes, then a new boot that re-leases the job).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { cloudMessageSubmit, COMMAND_INTENT_CONFLICT, type SessionProjection } from "@volli/shared";
import {
  SESSION_START_FORMAT,
  type ClaimedJob,
  type JobOutcome,
  type RunnerId,
  type SessionStartContext,
  type SessionStartJobPayload,
} from "@volli/shared/cloud";

import { createInboxWorker, type InboxBackend, type JobContext } from "../cloud-runner/inbox";
import { sqliteJobJournalStore } from "../cloud-runner/sqlite-stores";
import { openTestDb } from "../db/test-helpers";
import { StructuredSessionsError, type SessionStartInput } from "../session-runtime/sessions";
import { createFileTranscriptArtifactStore } from "../session-runtime/transcript-artifacts";
import { SessionOwnerError } from "./owner";
import {
  createSessionStartExecutor,
  registerSessionStartJob,
  SESSION_START_JOB_CAPABILITY,
  sessionStartOperationId,
  type SessionStartJobOptions,
  type SessionStartSessions,
} from "./session-start-jobs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The production store: SHA-256 references, as the backend staged them. */
function artifactStore() {
  const root = mkdtempSync(join(tmpdir(), "volli-session-start-"));
  roots.push(root);
  return createFileTranscriptArtifactStore(join(root, "transcripts"));
}

const RUNNER = "33333333-2222-4333-8444-555555555555" as RunnerId;
const OTHER_RUNNER = "44444444-2222-4333-8444-555555555555" as RunnerId;
const PROJECT = "11111111-2222-4333-8444-555555555555";
const TICKET = "66666666-2222-4333-8444-555555555555";
const USER = "99999999-8888-4777-8666-555555555555";
const SESSION = "55555555-2222-4333-8444-555555555555";
/** The client's request id: the job's id and the first message's command id. */
const JOB = "88888888-2222-4333-8444-555555555555";
const MODEL = { providerId: "anthropic", modelId: "claude", reasoningLevel: "high" } as const;
const OPERATION = sessionStartOperationId(JOB);

const MESSAGE = {
  id: "message-1",
  role: "user" as const,
  parts: [{ type: "text", text: "Fix the flaky upload test\nIt fails on CI." }],
};
const STAGED = cloudMessageSubmit({ sessionId: SESSION, commandId: JOB, message: MESSAGE });

const PAYLOAD: SessionStartJobPayload = {
  format: SESSION_START_FORMAT,
  projectId: PROJECT as SessionStartJobPayload["projectId"],
  ticketId: TICKET as SessionStartJobPayload["ticketId"],
  title: "Fix the flaky upload test",
  firstMessage: {
    commandId: JOB,
    body: {
      id: STAGED.reference.id,
      mediaType: STAGED.reference.mediaType,
      digest: STAGED.reference.digest,
    },
  },
  model: MODEL,
};

function claimed(
  payload: unknown = PAYLOAD,
  overrides: Record<string, unknown> = {},
  attempt = 1,
  bootId = "boot-1",
): ClaimedJob {
  return {
    job: {
      id: JOB,
      runnerId: RUNNER,
      kind: "session.start",
      projectId: PROJECT,
      sessionId: SESSION,
      ticketId: (payload as { ticketId?: string | null }).ticketId ?? null,
      workingCopyId: null,
      commandId: JOB,
      payload,
      priority: "normal",
      createdBy: { kind: "person", userId: USER },
      createdAt: 0,
      availableAt: 0,
      ...overrides,
    },
    lease: { bootId, expiresAt: 60_000, attempt },
  } as unknown as ClaimedJob;
}

function ready(overrides: Partial<Extract<SessionStartContext, { kind: "ready" }>> = {}) {
  return {
    kind: "ready",
    projectId: PROJECT,
    ticket: { id: TICKET, live: true },
    runnerName: "hetzner-1",
    body: STAGED.body,
    ...overrides,
  } as SessionStartContext;
}

/** Session state that survives a crash, as the SQLite ledger does. */
function sessionWorld() {
  const sessions = new Map<string, { commands: string[]; model: typeof MODEL | null }>();
  const creates: SessionStartInput[] = [];
  const attaches: string[] = [];
  const messages: { commandId: string; command: Record<string, unknown> }[] = [];
  const failures: unknown[] = [];
  const titles: unknown[] = [];
  const queued = new Set<string>();
  let hangDelivery = false;
  let hangAfterDelivery = false;
  let attachReady = true;
  let receipt: Record<string, unknown> = { status: "accepted" };
  let createError: Error | null = null;
  const ports: SessionStartSessions = {
    sessions: {
      create: vi.fn(async (input: SessionStartInput) => {
        creates.push(input);
        if (createError !== null) throw createError;
        const id = input.requestedSessionId!;
        if (!sessions.has(id))
          sessions.set(id, { commands: [`${input.operationId}:create`], model: null });
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
        const queue = (request.command as { delivery?: string }).delivery === "queue";
        // The follow-up ledger owns a queued command id: a direct send of it is a conflict.
        if (queued.has(request.commandId) && !queue)
          throw Object.assign(new Error("already belongs to the follow-up ledger"), {
            [COMMAND_INTENT_CONFLICT]: true,
          });
        if (queue) {
          queued.add(request.commandId);
          messages.push({ commandId: request.commandId, command: request.command });
          if (hangAfterDelivery) return new Promise<never>(() => {});
          return { receipt: null } as never;
        }
        if (!record.commands.includes(request.commandId)) {
          record.commands.push(request.commandId);
          messages.push({ commandId: request.commandId, command: request.command });
        }
        if (hangAfterDelivery) return new Promise<never>(() => {});
        return { receipt } as never;
      }),
    } as SessionStartSessions["runtime"],
    refineAutoTitle: (request) => void titles.push(request),
  };
  return {
    ports,
    sessions,
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
  const backend = (bootId: string): InboxBackend => ({
    claim: async () => {
      if (!claimable) return [];
      claimable = false;
      attempt += 1;
      return [claimed(payload, {}, attempt, bootId)];
    },
    renew: async () => ({ ok: true, lease: { bootId, expiresAt: 60_000, attempt } }),
    complete: async (args) => {
      completes.push({ attempt: args.attempt, outcome: args.outcome });
      return { ack: "recorded", status: "done" };
    },
  });
  return {
    backend,
    completes,
    expire: () => {
      claimable = true;
    },
  };
}

function harness(payload: unknown = PAYLOAD) {
  const db = openTestDb();
  const world = sessionWorld();
  const inbox = backendInbox(payload);
  const artifacts = artifactStore();
  const contexts: unknown[] = [];
  let context: () => SessionStartContext = () => ready();
  function boot(bootId: string) {
    const worker = createInboxWorker({
      backend: inbox.backend(bootId),
      journal: sqliteJobJournalStore(db.db, USER),
      bootId,
      setTimer: () => null,
      clearTimer: () => {},
    });
    registerSessionStartJob(worker, {
      runnerId: RUNNER,
      engine: world.engine,
      sessions: async () => world.ports,
      artifacts: () => artifacts,
      startContext: async (request) => {
        contexts.push(request);
        return context();
      },
      signInHint: (providerId) => `run \`volli-runner login ${providerId}\``,
      newOperationId: () => `attach-${world.attaches.length + 1}`,
    });
    return worker;
  }
  return {
    world,
    inbox,
    artifacts,
    contexts,
    boot,
    context: (next: typeof context) => {
      context = next;
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

/** One direct execution, with a live lease. */
function direct(overrides: Partial<SessionStartJobOptions> = {}) {
  const world = sessionWorld();
  const artifacts = artifactStore();
  const execute = createSessionStartExecutor({
    runnerId: RUNNER,
    engine: world.engine,
    sessions: async () => world.ports,
    artifacts: () => artifacts,
    startContext: async () => ready(),
    newOperationId: () => "attach-1",
    ...overrides,
  });
  const context: JobContext = { signal: new AbortController().signal, renew: async () => true };
  return { world, artifacts, run: (job = claimed()) => execute(job, context), context, execute };
}

/** An owner-scoped engine whose every read throws. */
const throwing = (error: Error): SessionStartJobOptions["engine"] => ({
  getSession: async () => {
    throw error;
  },
});

describe("the session.start executor", () => {
  it("starts the person's Session under the minted id and delivers the staged first message", async () => {
    const h = harness();
    const outcome = await h.run();

    expect(outcome).toEqual({
      status: "done",
      result: { kind: "started", sessionId: SESSION, model: MODEL },
    });
    expect(h.contexts).toEqual([{ jobId: JOB, bootId: "boot-1", attempt: 1 }]);
    expect(h.world.creates).toEqual([
      {
        operationId: OPERATION,
        requestedSessionId: SESSION,
        projectId: PROJECT,
        ticketId: TICKET,
        role: "ticket",
        title: "Fix the flaky upload test",
        actor: { kind: "user" },
        origin: { kind: "user" },
        modelOverride: {
          model: { providerId: "anthropic", modelId: "claude" },
          reasoningLevel: "high",
          whenUnavailable: "refuse",
        },
      },
    ]);
    // The first message goes under the command id its body was staged for.
    expect(h.world.messages).toEqual([
      { commandId: JOB, command: { kind: "message.submit", settle: "opened", message: MESSAGE } },
    ]);
    // The body is now this runner's own, under the reference the job names.
    expect((await h.artifacts.read(STAGED.reference)).message).toEqual(MESSAGE);
    expect(h.world.titles).toEqual([
      {
        sessionId: SESSION,
        firstMessage: "Fix the flaky upload test\nIt fails on CI.",
        heuristicTitle: "Fix the flaky upload test",
      },
    ]);
  });

  it("a kill mid-delivery resumes the same Session with one first message", async () => {
    const h = harness();
    h.world.hangDelivery(true);
    const first = h.boot("boot-1");
    await first.start();
    await vi.waitFor(() => expect(h.world.ports.runtime.command).toHaveBeenCalledOnce());
    first.stop();
    expect(h.inbox.completes).toEqual([]);

    h.world.hangDelivery(false);
    h.inbox.expire();
    const outcome = await h.run("boot-2");

    expect(outcome).toMatchObject({
      status: "done",
      result: { kind: "started", sessionId: SESSION },
    });
    expect(h.inbox.completes).toEqual([{ attempt: 2, outcome }]);
    // The birth is replayed under the same operation id: one Session.
    expect(h.world.creates.map((create) => create.operationId)).toEqual([OPERATION, OPERATION]);
    expect(h.world.sessions.size).toBe(1);
    expect(h.world.messages.map((message) => message.commandId)).toEqual([JOB]);
  });

  it("a kill after the first message completes without touching the Session again", async () => {
    const h = harness();
    h.world.hangAfterDelivery(true);
    const first = h.boot("boot-1");
    await first.start();
    await vi.waitFor(() => expect(h.world.messages).toHaveLength(1));
    first.stop();
    h.world.hangAfterDelivery(false);
    h.inbox.expire();
    const outcome = await h.run("boot-2");
    expect(outcome).toEqual({
      status: "done",
      result: { kind: "started", sessionId: SESSION, model: MODEL },
    });
    expect(h.world.creates).toHaveLength(1);
    expect(h.contexts).toHaveLength(1);
  });

  it("a kill after the first message was held in the queue completes once the attach is ready", async () => {
    const h = harness();
    h.world.attachReady(false);
    h.world.hangAfterDelivery(true);
    const first = h.boot("boot-1");
    await first.start();
    await vi.waitFor(() => expect(h.world.messages).toHaveLength(1));
    first.stop();
    // The queue holds it; the re-leased job now finds the attach ready.
    h.world.hangAfterDelivery(false);
    h.world.attachReady(true);
    h.inbox.expire();
    expect(await h.run("boot-2")).toEqual({
      status: "done",
      result: { kind: "started", sessionId: SESSION, model: MODEL },
    });
    expect(h.world.messages).toEqual([
      { commandId: JOB, command: { kind: "message.submit", delivery: "queue", message: MESSAGE } },
    ]);
    expect(h.world.titles).toHaveLength(1);
    // Any other refusal of the send still fails the attempt.
    const other = direct();
    other.world.ports.runtime.command = async () => {
      throw new Error("runtime closed");
    };
    await expect(other.run()).rejects.toThrow("runtime closed");
  });

  it("an existing Session does not re-check its ticket: the start is already committed", async () => {
    const h = direct();
    h.world.sessions.set(SESSION, { commands: [`${OPERATION}:create`], model: null });
    const execute = createSessionStartExecutor({
      runnerId: RUNNER,
      engine: h.world.engine,
      sessions: async () => h.world.ports,
      artifacts: () => h.artifacts,
      startContext: async () => ready({ ticket: { id: TICKET as never, live: false } }),
    });
    await expect(execute(claimed(), h.context)).resolves.toMatchObject({ status: "done" });
    expect(h.world.messages).toHaveLength(1);
  });

  it("refuses a model this runner cannot serve, before anything exists, saying where to sign in", async () => {
    const h = harness();
    h.world.createError(
      new StructuredSessionsError(
        "MODEL_UNAVAILABLE",
        "Sign in to anthropic before starting a session on anthropic/claude.",
      ),
    );
    expect(await h.run()).toEqual({
      status: "failed",
      code: "model_unavailable",
      detail: "anthropic isn't signed in on hetzner-1 — run `volli-runner login anthropic`.",
      retryable: false,
    });
    expect(h.world.messages).toEqual([]);
    expect(h.world.sessions.size).toBe(0);
  });

  it("words an unknown model as unavailable, and says nothing more without a hint", async () => {
    const h = direct();
    h.world.createError(
      new StructuredSessionsError("MODEL_UNAVAILABLE", "Model anthropic/claude is not available."),
    );
    expect(await h.run()).toMatchObject({
      code: "model_unavailable",
      detail: "anthropic/claude isn't available on hetzner-1.",
    });
    h.world.createError(new StructuredSessionsError("DEFAULT_MODEL_REQUIRED", "Choose a model."));
    expect(await h.run()).toMatchObject({
      code: "default_model_required",
      detail: "hetzner-1: Choose a model.",
      retryable: false,
    });
    h.world.createError(new Error("disk full"));
    await expect(h.run()).rejects.toThrow("disk full");
  });

  it("starts a Board Session on the runner's default, offering the message to an automatic choice", async () => {
    const h = direct();
    const board = { ...PAYLOAD, ticketId: null, title: null, model: null };
    expect(await h.run(claimed(board))).toMatchObject({ status: "done" });
    expect(h.world.creates[0]).toMatchObject({
      ticketId: null,
      role: "project",
      title: "Fix the flaky upload test",
      autoSelect: { request: "Fix the flaky upload test\nIt fails on CI." },
    });
    expect(h.world.creates[0]!.modelOverride).toBeUndefined();
  });

  it("a message with no text asks for no automatic choice and refines no title", async () => {
    const message = { id: "m-2", role: "user" as const, parts: [{ type: "file", url: "x" }] };
    const staged = cloudMessageSubmit({ sessionId: SESSION, commandId: JOB, message });
    const payload = {
      ...PAYLOAD,
      title: null,
      model: { ...MODEL, reasoningLevel: null },
      firstMessage: {
        commandId: JOB,
        body: { ...staged.reference },
      },
    };
    const h = direct({ startContext: async () => ready({ body: staged.body }) });
    expect(await h.run(claimed(payload))).toMatchObject({ status: "done" });
    expect(h.world.creates[0]).toMatchObject({
      title: null,
      modelOverride: { model: { providerId: "anthropic", modelId: "claude" } },
    });
    expect(h.world.creates[0]!.modelOverride).not.toHaveProperty("reasoningLevel");
    expect(h.world.titles).toEqual([]);
    const unpinned = direct({ startContext: async () => ready({ body: staged.body }) });
    expect(await unpinned.run(claimed({ ...payload, model: null }))).toMatchObject({
      status: "done",
    });
    expect(unpinned.world.creates[0]).not.toHaveProperty("autoSelect");
    expect(unpinned.world.creates[0]).not.toHaveProperty("modelOverride");
  });

  it("holds the first message in the Session's queue when the attach is not ready", async () => {
    const h = direct();
    h.world.attachReady(false);
    expect(await h.run()).toMatchObject({ status: "done" });
    expect(h.world.messages).toEqual([
      { commandId: JOB, command: { kind: "message.submit", delivery: "queue", message: MESSAGE } },
    ]);
  });

  it("delivers into a live binding without attaching again", async () => {
    const h = direct();
    h.world.ports.runtime.openNativeBindings = () => [{ sessionId: SESSION } as never];
    expect(await h.run()).toMatchObject({ status: "done" });
    expect(h.world.attaches).toEqual([]);
  });

  it("reports a first message the Session refused as the Session's own failure", async () => {
    const h = direct();
    h.world.receipt({ status: "rejected", code: "busy", detail: null });
    expect(await h.run()).toMatchObject({ status: "done" });
    expect(h.world.failures).toEqual([
      { sessionId: SESSION, commandId: JOB, detail: "The first message was not delivered: busy" },
    ]);
    h.world.sessions.clear();
    h.world.receipt({ status: "unreconciled", code: null, detail: null });
    await h.run();
    expect(h.world.failures.at(-1)).toMatchObject({
      detail: "The first message was not delivered.",
    });
  });

  it("a title refinement that throws costs the refinement, not the start", async () => {
    const h = direct();
    h.world.ports.refineAutoTitle = () => {
      throw new Error("no decision model");
    };
    expect(await h.run()).toMatchObject({ status: "done" });
  });

  it("starts nothing for an archived ticket, a lost lease or a project no longer the owner's", async () => {
    for (const [context, outcome] of [
      [
        ready({ ticket: { id: TICKET as never, live: false } }),
        { code: "ticket_unavailable", retryable: false },
      ],
      [ready({ ticket: null }), { code: "ticket_unavailable" }],
      [{ kind: "unavailable", reason: "lease_lost" }, { code: "lease_lost" }],
      [{ kind: "unavailable", reason: "project_unavailable" }, { code: "project_unavailable" }],
      [ready({ projectId: TICKET as never }), { code: "context_mismatch" }],
      [ready({ body: null }), { code: "message_unavailable" }],
      [ready({ body: "{" }), { code: "invalid_artifact" }],
      [ready({ body: STAGED.body.replace("flaky", "fixed") }), { code: "artifact_mismatch" }],
    ] as const) {
      const h = direct({ startContext: async () => context as SessionStartContext });
      expect(await h.run()).toMatchObject({ status: "failed", ...outcome });
      expect(h.world.creates).toEqual([]);
    }
  });

  it("a store that cannot take the body throws, so the inbox retries the attempt", async () => {
    const broken = {
      read: async () => {
        throw new Error("not here");
      },
      write: async () => {
        throw new Error("disk full");
      },
    };
    await expect(direct({ artifacts: () => broken as never }).run()).rejects.toThrow("disk full");
  });

  it("refuses a staged body that is not a person's message", async () => {
    const assistant = { id: "m-3", role: "assistant" as const, parts: [] };
    const staged = cloudMessageSubmit({ sessionId: SESSION, commandId: JOB, message: assistant });
    const payload = { ...PAYLOAD, firstMessage: { commandId: JOB, body: { ...staged.reference } } };
    const h = direct({ startContext: async () => ready({ body: staged.body }) });
    expect(await h.run(claimed(payload))).toMatchObject({ code: "invalid_artifact" });
  });

  it("refuses another runner's job, a malformed payload and ids that disagree", async () => {
    const h = direct();
    expect(await h.run(claimed(PAYLOAD, { runnerId: OTHER_RUNNER }))).toMatchObject({
      code: "not_your_runner",
    });
    expect(await h.run(claimed({ ...PAYLOAD, format: "v0" }))).toMatchObject({
      code: "invalid_job_payload",
    });
    for (const overrides of [
      { sessionId: null },
      { commandId: SESSION },
      { id: SESSION, commandId: SESSION },
      { projectId: TICKET },
      { ticketId: null },
    ]) {
      expect(await h.run(claimed(PAYLOAD, overrides))).toMatchObject({
        code: "invalid_job_payload",
      });
    }
    expect(h.world.creates).toEqual([]);
  });

  it("waits for the Session runtime and its store, and refuses a Session id already taken", async () => {
    expect(await direct({ sessions: async () => null }).run()).toMatchObject({
      code: "runtime_unavailable",
      retryable: true,
    });
    expect(await direct({ artifacts: () => null }).run()).toMatchObject({
      code: "transcript_unavailable",
      retryable: true,
    });
    const h = direct();
    h.world.sessions.set(SESSION, { commands: ["someone-else:create"], model: MODEL });
    expect(await h.run()).toMatchObject({ code: "session_conflict" });
    h.world.sessions.set(SESSION, { commands: [`${OPERATION}:create`, JOB], model: null });
    expect(await h.run()).toMatchObject({ code: "model_unrecorded" });
    const born = direct();
    born.world.ports.sessions.create = async () => ({ sessionId: TICKET, model: MODEL }) as never;
    expect(await born.run()).toMatchObject({ code: "session_conflict" });
  });

  it("stops at a lost lease without minting anything", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const h = direct();
    expect(
      await h.execute(claimed(), { signal: aborted.signal, renew: async () => true }),
    ).toMatchObject({ code: "lease_lost" });
    expect(
      await h.execute(claimed(), {
        signal: new AbortController().signal,
        renew: async () => false,
      }),
    ).toMatchObject({ code: "lease_lost" });
    // Aborted while waiting for the Session services.
    const waiting = new AbortController();
    const late = direct({
      sessions: async () => {
        waiting.abort();
        return null;
      },
    });
    expect(
      await late.execute(claimed(), { signal: waiting.signal, renew: async () => true }),
    ).toMatchObject({ code: "lease_lost" });
    // Aborted right after the renewal.
    const renewing = new AbortController();
    expect(
      await direct().execute(claimed(), {
        signal: renewing.signal,
        renew: async () => {
          renewing.abort();
          return true;
        },
      }),
    ).toMatchObject({ code: "lease_lost" });
    expect(h.world.creates).toEqual([]);
  });

  it("registers behind no owner gate, and turns a throw into a logged outcome", async () => {
    const registered = new Map<
      string,
      (job: ClaimedJob, context: JobContext) => Promise<JobOutcome>
    >();
    const worker = { register: (kind: string, run: never) => void registered.set(kind, run) };
    const register = (engine: SessionStartJobOptions["engine"]) => {
      registerSessionStartJob(worker as never, {
        runnerId: RUNNER,
        engine,
        sessions: async () => sessionWorld().ports,
        artifacts: () => artifactStore(),
        startContext: async () => ready(),
      });
      return registered.get("session.start")!;
    };
    const context = { signal: new AbortController().signal, renew: async () => true };
    expect(await register(throwing(new SessionOwnerError()))(claimed(), context)).toMatchObject({
      code: "not_your_runner",
      retryable: false,
    });
    expect(await register(throwing(new Error("io")))(claimed(), context)).toMatchObject({
      code: "session_start_failed",
      retryable: true,
    });
    expect(SESSION_START_JOB_CAPABILITY).toBe("session.start");
  });
});
