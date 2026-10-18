/**
 * A start's kickoff survives its first attach failing (VC-799).
 *
 * `session_start` and `session_delegate` sent their first message only after
 * a READY attach and persisted it nowhere else, so a Session whose first
 * attach failed — a worktree preparation that outlasted the 30 s admission
 * bound under load, an executor that refused to start — existed with no task,
 * and the app's Retry attached an EMPTY Session: no turn ran, no notice came.
 *
 * Everything below is the production path except the executor: the real
 * Sessions facade (`start` and the Retry's `attach`), the real Session runtime
 * with its SQLite event ledger and SQLite follow-up queue, the real start and
 * delegate operations, the facade's own kickoff port, the real delegation
 * store and the real wake bus. The executor is scripted so a test can make
 * one attach refuse and say when a turn ends.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  type BindingHandle,
  type NativeAttachmentSpec,
  type NativeHarnessAdapter,
  type ObservationSink,
} from "@volli/session-engine";
import { autoTitleFromKickoff, DEFAULT_KICKOFF_MESSAGE } from "@volli/shared";
import type { ModelSelection } from "@volli/shared";

import { insertProject } from "../db/projects-repo";
import { createSqliteSessionFollowUpLedger } from "../db/session-follow-up-repo";
import { insertTicket } from "../db/tickets-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { createSessionWakeBus } from "../session-control/session-wake";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { createDelegations, DELEGATION_ID_SUFFIXES } from "./delegate-session";
import { createTicketSessionDelegationStore } from "./delegation-store";
import { createSessions } from "./sessions";
import { kickoffSubmitter, startSessionOperation } from "./start-session";

const MODEL: ModelSelection = {
  providerId: "scripted",
  modelId: "scripted",
  reasoningLevel: "off",
};
/** The admission bound, shortened; the production default is 30 s. */
const BOUND_MS = 20;

interface Submitted {
  sessionId: string;
  commandId: string;
  messageId: string;
  text: string;
}

/** Scripted executor: attaches unless told to refuse, and opens a turn per message. */
class Executor implements NativeHarnessAdapter {
  readonly id = "scripted";
  readonly durableIdNamespace = "scripted";
  readonly adapterVersion = "1";
  readonly runtime = { path: "/scripted", version: "1", fingerprint: "scripted" };
  /** How many of the next attaches refuse. */
  refuseAttaches = 0;
  readonly submitted: Submitted[] = [];
  readonly #sinks = new Map<string, ObservationSink>();
  #now = 100;

  async attach(spec: NativeAttachmentSpec, sink: ObservationSink): Promise<BindingHandle> {
    if (this.refuseAttaches > 0) {
      this.refuseAttaches -= 1;
      throw new Error("The executor refused to start");
    }
    this.#sinks.set(spec.sessionId, sink);
    return {
      native: { id: `native:${spec.attachmentId}`, detail: null },
      dispatch: async (command) => {
        if (command.kind === "message.submit") {
          const part = command.message.parts[0];
          this.submitted.push({
            sessionId: command.sessionId,
            commandId: command.commandId,
            messageId: command.message.id,
            text: part?.type === "text" ? part.text : "",
          });
          if (command.delivery !== "steer") {
            await sink.emit({
              kind: "turn",
              state: "started",
              turnId: `turn:${command.commandId}`,
              occurredAt: this.#now++,
            });
          }
        }
        return {
          commandId: command.commandId,
          status: "accepted",
          acceptedAt: this.#now++,
          native: null,
        };
      },
      reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
      release: async () => undefined,
    };
  }

  /** End the turn a message opened. */
  async complete(sessionId: string, commandId: string): Promise<void> {
    await this.#sinks.get(sessionId)!.emit({
      kind: "turn",
      state: "completed",
      turnId: `turn:${commandId}`,
      occurredAt: this.#now++,
    });
  }

  to(sessionId: string): Submitted[] {
    return this.submitted.filter((submitted) => submitted.sessionId === sessionId);
  }
}

let database: TestDb | undefined;
let closeRuntime: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeRuntime?.();
  closeRuntime = undefined;
  database?.cleanup();
  database = undefined;
});

function fixture() {
  const db = (database = openTestDb());
  const project = testProject({ id: "project-1", path: "/repo/project" });
  insertProject(db.db, project);
  const ticket = testTicket(project.id, { id: "ticket-1", ticketNumber: 7 });
  insertTicket(db.db, ticket);
  let clock = 1_000;
  const ids = { next: (kind: string) => `${kind}-${clock++}` };
  const wake = createSessionWakeBus(
    createSessionEngine({
      ledger: createSqliteSessionLedger(db.db),
      clock: { now: () => clock++ },
      ids,
    }),
    { db: db.db },
  );
  const engine = wake.engine;
  const executor = new Executor();
  const venue = { id: "local", kind: "local" as const };
  const control: { preparation: Promise<void> | null; prepareFailures: number } = {
    preparation: null,
    prepareFailures: 0,
  };
  const runtime = createSessionRuntime({
    engine,
    executor,
    artifacts: createInMemoryTranscriptArtifactStore(),
    followUps: createSqliteSessionFollowUpLedger(db.db),
    followUpRetryDelaysMs: [],
    followUpAdmissionTimeoutMs: BOUND_MS,
    locations: {
      resolve: async () => ({ directory: project.path, venue }),
      // A worktree preparation that keeps running however long it is waited on.
      prepare: async () => {
        await control.preparation;
        if (control.prepareFailures > 0) {
          control.prepareFailures -= 1;
          throw new Error("git worktree add was killed (SIGKILL)");
        }
        return { directory: project.path, venue };
      },
      reaffirm: async () => undefined,
    },
    clock: { now: () => clock++ },
    ids,
  });
  closeRuntime = () => runtime.close();
  const sessions = createSessions({
    runtime,
    readDefaultModel: async () => MODEL,
    readModelAnchor: async () => ({ selection: MODEL, tier: null }),
    // A subagent runs on its parent's anchor, which Model Access validates.
    inspectModelAccess: async () => ({
      observedAt: 0,
      providers: [],
      models: [
        {
          ...MODEL,
          label: "Scripted",
          state: "available",
          reasoningLevels: ["off"],
          acceptsImageInput: false,
        },
      ],
    }),
    ticketBelongsToProject: () => true,
    skills: { resolve: async () => [], index: async () => null, record: async () => undefined },
    toolSurface: {
      resolve: () => ["read", "edit", "write", "execute"],
      recorded: async () => null,
      record: async () => undefined,
    },
    grants: {
      resolveBirth: () => ({ grants: [], delegation: null, parentSessionId: null }),
      recordBirth: () => undefined,
    },
  });
  // The facade's own kickoff port, exactly as `facade.ts` composes it.
  const submitSessionMessage = kickoffSubmitter(runtime);
  const reports: string[] = [];
  const delegations = createDelegations({
    sessions,
    submitSessionMessage,
    runtime,
    sessionEngine: engine,
    now: () => clock++,
    report: (message) => reports.push(message),
  });
  // Simulated wiring of `agents.ts`'s wake listener: a subagent whose turn
  // starts with nobody watching it is re-armed from the delegation store.
  const store = createTicketSessionDelegationStore(db.db);
  wake.subscribe((woke) => {
    const payload = woke.event.payload;
    if (payload.kind !== "turn.started" || delegations.watching(woke.event.sessionId)) return;
    const entry = store.subagentDelegation(woke.event.sessionId);
    if (entry === null) return;
    void delegations.rearm(entry, { turnId: payload.turnId, afterSequence: woke.event.sequence });
  });

  const startTicketSession = (operationId: string, message?: string) =>
    startSessionOperation(
      {
        db: db.db,
        projects: [project],
        sessions,
        submitSessionMessage,
        now: () => clock++,
      },
      {
        operationId,
        project,
        ticket,
        ...(message === undefined ? {} : { message }),
        actor: { kind: "session", sessionId: "orchestrator", ticketId: null },
      },
      { defaultKickoff: DEFAULT_KICKOFF_MESSAGE, autoTitle: autoTitleFromKickoff },
    );
  const queueOf = async (sessionId: string) =>
    ((await runtime.projection({ sessionId })).projection.queue ?? []).map(
      ({ id, state }) => `${id}:${state}`,
    );
  return {
    project,
    runtime,
    sessions,
    executor,
    control,
    delegations,
    reports,
    startTicketSession,
    queueOf,
  };
}

describe("session_start keeps its kickoff through a failed first attach (VC-799)", () => {
  it("runs the kickoff once when the worktree preparation outlasts the admission bound", async () => {
    const f = fixture();
    const preparation = Promise.withResolvers<void>();
    f.control.preparation = preparation.promise;

    const starting = f.startTicketSession("orchestrator:call-1", "Fix the flaky login test");
    // Well past the bound, the preparation the attach started is still going.
    await new Promise((resolve) => setTimeout(resolve, BOUND_MS * 4));
    preparation.resolve();
    const started = await starting;

    expect(started).toMatchObject({ state: "ready", kickoff: "submitted" });
    await expect
      .poll(() => f.executor.to(started.sessionId))
      .toEqual([
        {
          sessionId: started.sessionId,
          commandId: "orchestrator:call-1:kickoff",
          messageId: "orchestrator:call-1:kickoff-message",
          text: "Fix the flaky login test",
        },
      ]);
    const { projection } = await f.runtime.projection({ sessionId: started.sessionId });
    expect(projection.attention.active).toEqual([]);
  });

  it("holds the kickoff of a start whose attach failed, and the Retry delivers it exactly once", async () => {
    const f = fixture();
    f.executor.refuseAttaches = 1;

    const started = await f.startTicketSession("orchestrator:call-1", "Fix the flaky login test");

    expect(started).toMatchObject({ state: "needs-recovery", kickoff: "held" });
    expect(f.executor.to(started.sessionId)).toEqual([]);
    // Held where a person sees it, under the id a ready start would have used.
    expect(await f.queueOf(started.sessionId)).toEqual([
      "orchestrator:call-1:kickoff-message:queued",
    ]);

    // A replayed start is one Session and one held kickoff.
    const replayed = await f.startTicketSession("orchestrator:call-1", "Fix the flaky login test");
    expect(replayed).toMatchObject({ sessionId: started.sessionId, kickoff: "held" });
    expect(await f.queueOf(started.sessionId)).toEqual([
      "orchestrator:call-1:kickoff-message:queued",
    ]);

    // The app's Retry.
    const retried = await f.sessions.attach({
      operationId: "retry-1",
      sessionId: started.sessionId,
    });
    expect(retried.state).toBe("ready");
    await expect.poll(() => f.executor.to(started.sessionId)).toHaveLength(1);
    expect(f.executor.to(started.sessionId)[0]).toMatchObject({
      messageId: "orchestrator:call-1:kickoff-message",
      text: "Fix the flaky login test",
    });
    await expect.poll(() => f.queueOf(started.sessionId)).toEqual([]);

    // Neither a later replay of the start nor a recovery sweep sends it again.
    await f.startTicketSession("orchestrator:call-1", "Fix the flaky login test");
    await f.runtime.recoverFollowUps();
    expect(f.executor.to(started.sessionId)).toHaveLength(1);
    const { projection } = await f.runtime.projection({ sessionId: started.sessionId });
    expect(projection.attention.active).toEqual([]);
  });

  it("holds the kickoff of a start whose worktree could not be made, and the Retry delivers it", async () => {
    // The b3a8d42a shape: the preparation itself fails, so no executor was
    // ever asked to attach and the Session has no attachment at all.
    const f = fixture();
    f.control.prepareFailures = 1;

    const started = await f.startTicketSession("orchestrator:call-2", "Rebase the stacked branch");

    expect(started).toMatchObject({
      state: "needs-recovery",
      kickoff: "held",
      attachFailure: expect.stringContaining("git worktree add was killed"),
    });
    expect(f.executor.to(started.sessionId)).toEqual([]);
    expect(await f.queueOf(started.sessionId)).toEqual([
      "orchestrator:call-2:kickoff-message:queued",
    ]);

    const retried = await f.sessions.attach({
      operationId: "retry-2",
      sessionId: started.sessionId,
    });
    expect(retried.state).toBe("ready");
    await expect
      .poll(() => f.executor.to(started.sessionId).map(({ messageId, text }) => [messageId, text]))
      .toEqual([["orchestrator:call-2:kickoff-message", "Rebase the stacked branch"]]);
    await expect.poll(() => f.queueOf(started.sessionId)).toEqual([]);
  });
});

describe("session_delegate keeps its task through a failed first attach (VC-799)", () => {
  it("runs the held task on the child's Retry and tells the parent once, under <op>:answer", async () => {
    const f = fixture();
    const parent = await f.sessions.start({
      operationId: "parent",
      projectId: f.project.id,
      ticketId: null,
      role: "project",
      title: "Orchestrator",
      actor: { kind: "user" },
    });
    expect(parent.state).toBe("ready");
    const operationId = `${parent.sessionId}:call-1`;
    const delegate = () =>
      f.delegations.delegate({
        operationId,
        parent: {
          role: "project",
          sessionId: parent.sessionId,
          rootThreadId: "thread",
          attachmentId: "attachment",
          projectId: f.project.id,
          ticketId: null,
        },
        task: "Find where the auth token is refreshed",
        actor: { kind: "session", sessionId: parent.sessionId, ticketId: null },
      });
    f.executor.refuseAttaches = 1;

    const outcome = await delegate();

    expect(outcome).toMatchObject({ state: "needs-recovery", taskHeld: true });
    const child = outcome.childSessionId;
    expect(await f.queueOf(child)).toEqual([`${operationId}:kickoff-message:queued`]);
    // A replayed delegation is one child and one held task.
    expect(await delegate()).toMatchObject({ childSessionId: child, taskHeld: true });
    expect(await f.queueOf(child)).toEqual([`${operationId}:kickoff-message:queued`]);

    // A person retries the child: its queue releases the task.
    expect((await f.sessions.attach({ operationId: "retry-child", sessionId: child })).state).toBe(
      "ready",
    );
    await expect.poll(() => f.executor.to(child)).toHaveLength(1);
    const task = f.executor.to(child)[0]!;
    expect(task).toMatchObject({ messageId: `${operationId}:kickoff-message` });
    expect(task.text).toContain("Find where the auth token is refreshed");
    await expect.poll(() => f.delegations.watching(child)).toBe(true);

    await f.executor.complete(child, task.commandId);

    const notices = () =>
      f.executor
        .to(parent.sessionId)
        .filter(({ commandId }) => commandId.endsWith(DELEGATION_ID_SUFFIXES.notice));
    await expect.poll(notices).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ commandId: `${operationId}:answer` });
    expect(notices()[0]?.text).toContain("completed its task");
    await f.runtime.recoverFollowUps();
    expect(notices()).toHaveLength(1);
    expect(f.reports).toEqual([]);
  });
});
