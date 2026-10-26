import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  sessionMainBranchId,
  sessionRootThreadId,
  TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  type HostedSessionRuntime,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import {
  CLOUD_MESSAGE_MEDIA_TYPE,
  cloudMessageSubmit,
  encodeSessionJson,
  LOCAL_RUNNER,
} from "@volli/shared";
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
import { SpoolTranscriptArtifactStore } from "../transcript-spool/artifact-spool";
import {
  ownerGuardedInbox,
  registerSessionCommandJob,
  type CommandArtifactSource,
} from "./session-jobs";

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

describe("a message staged with its command", () => {
  const spools: string[] = [];
  afterEach(() => {
    for (const directory of spools.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  async function staged(commandArtifact?: CommandArtifactSource) {
    const f = await fixture();
    const directory = mkdtempSync(join(tmpdir(), "volli-staged-message-"));
    spools.push(directory);
    const store = new SpoolTranscriptArtifactStore(directory);
    const executors = new Map<string, JobExecutor>();
    const command = vi.fn(async (_input: unknown) => ({ receipt: null }));
    registerSessionCommandJob(
      { register: (kind, executor) => void executors.set(kind, executor) },
      {
        engine: f.engine,
        runtime: () => ({ command }) as unknown as HostedSessionRuntime,
        artifacts: () => store,
        ...(commandArtifact === undefined ? {} : { commandArtifact }),
      },
    );
    const send = (built: { intent: string }, edit?: (claimed: ClaimedJob) => void) => {
      const claimed = job(JSON.parse(built.intent));
      edit?.(claimed);
      return executors.get("session.command")!(claimed, jobContext);
    };
    return { store, command, send };
  }

  const sent = (commandId = "delivery-command") =>
    cloudMessageSubmit({ sessionId: "a-session", commandId, message });

  it("names the reference the runtime's own transcript store writes for the command", async () => {
    const { store } = await staged();
    const built = sent();
    expect(CLOUD_MESSAGE_MEDIA_TYPE).toBe(TRANSCRIPT_ARTIFACT_MEDIA_TYPE);
    const written = await store.write({
      version: 1,
      threadId: sessionRootThreadId("a-session"),
      branchId: sessionMainBranchId("a-session"),
      attemptId: "attempt:delivery-command",
      turnId: "turn:delivery-command",
      message,
    });
    expect(written).toEqual(built.reference);
    expect((await store.readCanonicalBytes(written)).toString("utf8")).toBe(built.body);
  });

  it("hydrates a person's body by its digest through the spool, then delivers it", async () => {
    const built = sent();
    const commandArtifact = vi.fn(async () => built.body);
    const { store, command, send } = await staged(commandArtifact);
    expect(await send(built)).toEqual({ status: "done", result: null });
    expect(commandArtifact).toHaveBeenCalledWith({
      sessionId: "a-session",
      digest: built.reference.digest,
    });
    expect((await store.read(built.reference)).message).toEqual(message);
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "delivery-command",
        origin: { kind: "user" },
        command: { kind: "message.submit", message, settle: "opened" },
      }),
    );
    // Held now: a redelivery reads it locally.
    expect(await send(built)).toEqual({ status: "done", result: null });
    expect(commandArtifact).toHaveBeenCalledTimes(1);
  });

  it("hydrates an agent's body under its composite operation id and delivers it as a steer", async () => {
    const operation = "parent-session:tool-call-1";
    const built = sent(operation);
    const commandArtifact = vi.fn(async () => built.body);
    const { store, command, send } = await staged(commandArtifact);
    const asAgent = (claimed: ClaimedJob) => {
      claimed.job.commandId = operation as typeof claimed.job.commandId;
      claimed.job.createdBy = {
        kind: "agent",
        userId: "a",
        sessionId: "parent-session",
      } as typeof claimed.job.createdBy;
    };
    expect(await send(built, asAgent)).toEqual({ status: "done", result: null });
    // The read is by digest: the operation id never reaches it.
    expect(commandArtifact).toHaveBeenCalledWith({
      sessionId: "a-session",
      digest: built.reference.digest,
    });
    await expect(store.read(built.reference)).resolves.toMatchObject({ message });
    expect(command).toHaveBeenCalledWith({
      sessionId: "a-session",
      commandId: operation,
      origin: { kind: "session", sessionId: "parent-session" },
      command: { kind: "message.submit", message, settle: "opened", delivery: "steer" },
    });
  });

  it("refuses a staged body that is not the reference's, without delivering", async () => {
    const built = sent();
    let body: string | null = null;
    const { command, send } = await staged(async () => body);
    for (const [next, code] of [
      [sent("another-command").body, "artifact_mismatch"],
      [built.body.replace("Message", "Massage"), "artifact_mismatch"],
      ["{", "invalid_artifact"],
    ] as const) {
      body = next;
      expect(await send(built)).toMatchObject({ status: "failed", code, retryable: false });
    }
    expect(command).not.toHaveBeenCalled();
  });

  it("retries when nothing is staged or the backend cannot answer", async () => {
    const read = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("offline"));
    const { command, send } = await staged(read);
    await expect(send(sent())).rejects.toThrow();
    await expect(send(sent())).rejects.toThrow("offline");
    expect(command).not.toHaveBeenCalled();
  });

  it("ends on the backend's typed refusals with its own path-free sentence", async () => {
    let refusal: unknown = null;
    const { command, send } = await staged(async () => {
      throw refusal;
    });
    for (const [code, retryable] of [
      ["not_claimed", false],
      ["invalid_argument", false],
      ["revoked", false],
      ["not_a_runner", false],
      // The claim may be this runner's under a generation its drain has not learnt yet.
      ["stale_claim", true],
    ] as const) {
      refusal = Object.assign(new Error("/Users/someone/secret"), {
        data: { code, message: "/Users/someone/secret" },
      });
      const outcome = await send(sent());
      expect(outcome).toMatchObject({ status: "failed", code, retryable });
      expect(JSON.stringify(outcome)).not.toContain("/Users");
    }
    // A refreshing token, a transport failure, or an untyped one may recover.
    for (const retried of [{ data: { code: "unauthenticated" } }, { data: null }, null]) {
      refusal = retried;
      await expect(send(sent())).rejects.toBe(retried);
    }
    expect(command).not.toHaveBeenCalled();
  });

  it("keeps the local miss when no backend read is wired", async () => {
    const unwired = await staged();
    await expect(unwired.send(sent())).rejects.toThrow();
    expect(unwired.command).not.toHaveBeenCalled();
  });
});
