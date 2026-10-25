import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostedSessionRuntime, TranscriptArtifactStore } from "@volli/session-engine";
import { encodeSessionJson, LOCAL_RUNNER } from "@volli/shared";
import {
  SESSION_COMMAND_FORMAT,
  SESSION_INTERRUPT_FORMAT,
  type ClaimedJob,
  type JobOutcome,
} from "@volli/shared/cloud";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { createTestSessionEngine } from "../testing/session-engine";
import type { JobContext, JobExecutor } from "../cloud-runner/inbox";
import { sqliteDrainCursorStore } from "../cloud-runner/sqlite-stores";
import { ownerGuardedInbox, registerSessionCommandJob } from "./session-jobs";

let opened: TestDb | undefined;
afterEach(() => {
  opened?.cleanup();
  opened = undefined;
});
const provenance = {
  source: { kind: "system", id: "test", detail: null },
  venue: LOCAL_RUNNER,
} as const;
const jobContext: JobContext = { signal: new AbortController().signal, renew: async () => true };
const reference = { id: "message-artifact", mediaType: "application/json", digest: null };
const message = {
  id: "message",
  role: "user" as const,
  parts: [{ type: "text" as const, text: "Message from the artifact, not from the job" }],
};

function job(intent: unknown = { kind: "session.retitle", title: "Retitled" }): ClaimedJob {
  return {
    job: {
      id: "job",
      kind: "session.command",
      runnerId: "runner-a",
      projectId: "p",
      ticketId: "t",
      sessionId: "a-session",
      workingCopyId: null,
      commandId: "delivery-command",
      payload: { format: SESSION_COMMAND_FORMAT, intent: encodeSessionJson(intent) },
      priority: "normal",
      createdBy: { kind: "person", userId: "a" },
      createdAt: 0,
      availableAt: 0,
    },
    lease: { bootId: "boot", attempt: 1, expiresAt: 60_000 },
  } as ClaimedJob;
}

async function fixture() {
  opened = openTestDb();
  const { db } = opened;
  insertProject(db, testProject({ id: "p" }));
  insertTicket(db, testTicket("p", { id: "t" }));
  const engine = createTestSessionEngine(db);
  for (const [id, ownerUserId] of [
    ["a-session", "a"],
    ["b-session", "b"],
    ["local-session", undefined],
  ] as const) {
    await engine.createSession({
      commandId: `birth-${id}`,
      requestedSessionId: id,
      projectId: "p",
      ticketId: "t",
      role: "ticket",
      parentSessionId: null,
      title: null,
      provenance,
      ...(ownerUserId === undefined ? {} : { ownerUserId }),
    });
  }
  const owns = new Set(["a-session"]);
  const executors = new Map<string, JobExecutor>();
  const worker = {
    register: (kind: string, executor: JobExecutor) => {
      executors.set(kind, executor);
    },
  };
  const guarded = ownerGuardedInbox(worker, {
    engine,
    ownerUserId: "a",
    owns: (id) => owns.has(id),
  });
  // Only command() is used by this executor; the engine is the real SQLite one.
  const command = vi.fn(
    async (_input: unknown): Promise<{ receipt: { status: string } | null }> => ({ receipt: null }),
  );
  let runtime: HostedSessionRuntime | null = { command } as unknown as HostedSessionRuntime;
  const read = vi.fn(async () => ({
    version: 1 as const,
    threadId: "thread",
    branchId: "branch",
    attemptId: "attempt",
    turnId: null,
    message,
  }));
  let artifacts: TranscriptArtifactStore | null = { read, write: async () => reference };
  registerSessionCommandJob(guarded, {
    engine,
    runtime: () => runtime,
    artifacts: () => artifacts,
  });
  const execute = (claimed = job(), context = jobContext) =>
    executors.get("session.command")!(claimed, context);
  return {
    db,
    engine,
    guarded,
    executors,
    owns,
    command,
    read,
    execute,
    noRuntime: () => {
      runtime = null;
    },
    noArtifacts: () => {
      artifacts = null;
    },
  };
}

describe("owner-guarded Session inbox executors", () => {
  it.each(["session.followUp", "session.notice", "session.delegate", "session.release"] as const)(
    "guards every registered %s before its implementation runs",
    async (kind) => {
      const f = await fixture();
      const execute = vi.fn(async (): Promise<JobOutcome> => ({ status: "done", result: null }));
      f.guarded.register(kind, execute);
      const claimed = job();
      claimed.job.kind = kind;
      for (const id of ["b-session", "local-session", "missing", null]) {
        claimed.job.sessionId = id as typeof claimed.job.sessionId;
        // Explicit foreign stamps and absent Sessions fail even if owns is
        // wrong. A pre-owner Session still needs a current-owner cursor.
        if (id !== null && id !== "local-session") f.owns.add(id);
        expect(await f.executors.get(kind)!(claimed, jobContext)).toMatchObject({
          status: "failed",
          code: "not_your_runner",
          retryable: false,
        });
      }
      claimed.job.sessionId = "a-session" as typeof claimed.job.sessionId;
      f.owns.delete("a-session");
      expect(await f.executors.get(kind)!(claimed, jobContext)).toMatchObject({
        code: "not_your_runner",
        retryable: false,
      });
      expect(execute).not.toHaveBeenCalled();
      f.owns.add("a-session");
      expect(await f.executors.get(kind)!(claimed, jobContext)).toEqual({
        status: "done",
        result: null,
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts a migrated pre-owner Session only through its current-owner cursor", async () => {
    const f = await fixture();
    expect(
      (await f.engine.getBaseSession({ sessionId: "local-session" }))?.ownerUserId,
    ).toBeUndefined();
    const cursors = sqliteDrainCursorStore(f.db);
    const executors = new Map<string, JobExecutor>();
    const guarded = ownerGuardedInbox(
      {
        register: (kind, executor) => {
          executors.set(kind, executor);
        },
      },
      {
        engine: f.engine,
        ownerUserId: "a",
        owns: (id) => cursors.get(id)?.ownerUserId === "a",
      },
    );
    const execute = vi.fn(async (): Promise<JobOutcome> => ({ status: "done", result: null }));
    guarded.register("session.notice", execute);
    const claimed = job();
    claimed.job.kind = "session.notice";
    claimed.job.sessionId = "local-session" as typeof claimed.job.sessionId;
    expect(await executors.get("session.notice")!(claimed, jobContext)).toMatchObject({
      code: "not_your_runner",
      retryable: false,
    });
    cursors.save({
      sessionId: "local-session",
      ownerUserId: "a",
      generation: 1,
      acceptedThrough: 0,
      blocked: null,
    });
    expect(await executors.get("session.notice")!(claimed, jobContext)).toEqual({
      status: "done",
      result: null,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    cursors.save({
      sessionId: "local-session",
      ownerUserId: "b",
      generation: 1,
      acceptedThrough: 0,
      blocked: null,
    });
    expect(await executors.get("session.notice")!(claimed, jobContext)).toMatchObject({
      code: "not_your_runner",
      retryable: false,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not apply a Session owner gate to machine job kinds", async () => {
    const f = await fixture();
    const execute = vi.fn(async (): Promise<JobOutcome> => ({ status: "done", result: null }));
    f.guarded.register("workingCopy.refresh", execute);
    const claimed = job();
    claimed.job.kind = "workingCopy.refresh";
    claimed.job.sessionId = null;
    expect(await f.executors.get("workingCopy.refresh")!(claimed, jobContext)).toEqual({
      status: "done",
      result: null,
    });
    expect(execute).toHaveBeenCalledWith(claimed, jobContext);
  });

  it("fails foreign session.command permanently before parsing or touching the runtime", async () => {
    const f = await fixture();
    const claimed = job();
    claimed.job.sessionId = "b-session" as typeof claimed.job.sessionId;
    claimed.job.payload = { broken: true };
    expect(await f.execute(claimed)).toMatchObject({ code: "not_your_runner", retryable: false });
    expect(f.command).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
});

describe("Session command jobs", () => {
  it("decodes the wire intent, reads a referenced message and preserves agent origin and command id", async () => {
    const f = await fixture();
    const claimed = job({ kind: "message.submit", reference });
    claimed.job.createdBy = {
      kind: "agent",
      userId: "a",
      sessionId: "parent",
    } as typeof claimed.job.createdBy;
    expect(await f.execute(claimed)).toEqual({ status: "done", result: null });
    expect(f.read).toHaveBeenCalledWith(reference);
    expect(f.command).toHaveBeenCalledWith({
      sessionId: "a-session",
      commandId: "delivery-command",
      // An agent's send is a steer, as `session_send` is locally.
      command: { kind: "message.submit", message, settle: "opened", delivery: "steer" },
      origin: { kind: "session", sessionId: "parent" },
    });
    expect(JSON.stringify(claimed.job.payload)).not.toContain(message.parts[0]!.text);
  });

  it("translates executor attachment commands without letting callers select a runtime", async () => {
    const f = await fixture();
    await f.execute(
      job({ kind: "executor.start", adapterId: "old-client-adapter", continuity: "fresh" }),
    );
    expect(f.command).toHaveBeenLastCalledWith({
      sessionId: "a-session",
      commandId: "delivery-command",
      command: { kind: "adapter.attach", continuity: "fresh" },
      origin: { kind: "user" },
    });
    await f.execute(job({ kind: "executor.stop", attachmentId: "binding" }));
    expect(f.command).toHaveBeenLastCalledWith({
      sessionId: "a-session",
      commandId: "delivery-command",
      command: { kind: "adapter.release", attachmentId: "binding" },
      origin: { kind: "user" },
    });
    await f.execute(job({ kind: "session.stop", reason: "Requested", by: { kind: "user" } }));
    expect(f.command).toHaveBeenLastCalledWith({
      sessionId: "a-session",
      commandId: "delivery-command",
      command: { kind: "session.stop", reason: "Requested" },
      origin: { kind: "user" },
    });
  });

  it("delivers the board interrupt without guessing an attachment id", async () => {
    const f = await fixture();
    const claimed = job();
    claimed.job.payload = {
      format: SESSION_INTERRUPT_FORMAT,
      reason: "ticket_left_active_columns",
      from: "doing",
      to: "done",
    };
    expect(await f.execute(claimed)).toEqual({ status: "done", result: null });
    expect(f.command).toHaveBeenCalledWith({
      sessionId: "a-session",
      commandId: "delivery-command",
      command: { kind: "executor.interrupt" },
    });
  });

  it("writes metadata through the engine idempotently, not through the runtime", async () => {
    const f = await fixture();
    const submit = vi.spyOn(f.engine, "submit");
    const claimed = job();
    expect(await f.execute(claimed)).toEqual({ status: "done", result: null });
    expect(await f.execute(claimed)).toEqual({ status: "done", result: null });
    expect((await f.engine.getSession({ sessionId: "a-session" }))?.session.title).toBe("Retitled");
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "delivery-command",
        provenance: {
          source: {
            kind: "system",
            id: "runner-inbox",
            detail: { sessionOrigin: { kind: "user" } },
          },
          venue: LOCAL_RUNNER,
        },
      }),
    );
    const events = await f.engine.listEvents({ sessionId: "a-session" });
    expect(events.filter((event) => event.payload.kind === "session.retitled")).toHaveLength(1);
    expect(f.command).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads and missing command ids without executing them", async () => {
    const f = await fixture();
    for (const payload of [
      {},
      { format: SESSION_COMMAND_FORMAT, intent: "{" },
      {
        format: SESSION_COMMAND_FORMAT,
        intent: encodeSessionJson({ kind: "session.retitle", title: 42 }),
      },
      { format: SESSION_COMMAND_FORMAT, intent: encodeSessionJson({ kind: "future.command" }) },
      { format: SESSION_COMMAND_FORMAT, intent: encodeSessionJson({ kind: "session.create" }) },
    ]) {
      const claimed = job();
      claimed.job.payload = payload;
      expect(await f.execute(claimed)).toMatchObject({
        code: "invalid_job_payload",
        retryable: false,
      });
    }
    const missingCommand = job();
    missingCommand.job.commandId = null;
    expect(await f.execute(missingCommand)).toMatchObject({
      code: "invalid_job_payload",
      retryable: false,
    });
    expect(f.command).not.toHaveBeenCalled();
  });

  it("distinguishes a missing runtime, unavailable body, and an explicit runtime refusal", async () => {
    const f = await fixture();
    f.noArtifacts();
    expect(await f.execute(job({ kind: "message.submit", reference }))).toMatchObject({
      code: "transcript_unavailable",
      retryable: false,
    });
    f.command.mockResolvedValueOnce({ receipt: { status: "rejected" } });
    expect(
      await f.execute(job({ kind: "executor.start", adapterId: "pi", continuity: "fresh" })),
    ).toMatchObject({ code: "command_refused", retryable: false });
    f.noRuntime();
    expect(await f.execute(job())).toMatchObject({ code: "runtime_unavailable", retryable: true });
  });

  it("honours a lost lease before any side effect", async () => {
    const f = await fixture();
    const abort = new AbortController();
    abort.abort(new Error("lease taken away"));
    expect(await f.execute(job(), { ...jobContext, signal: abort.signal })).toMatchObject({
      code: "lease_lost",
      retryable: false,
    });
    expect(f.command).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
});

it("keeps local exception paths out of journaled Session outcomes", async () => {
  const f = await fixture();
  f.read.mockRejectedValueOnce(new Error("Could not open /runner/private/session-artifact.json"));
  const outcome = await f.execute(job({ kind: "message.submit", reference }));
  expect(outcome).toMatchObject({ status: "failed", code: "executor_error" });
  expect(JSON.stringify(outcome)).not.toContain("/runner/private");
});
