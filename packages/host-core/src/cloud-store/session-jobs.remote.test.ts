/**
 * Session command jobs sent from another runner: the body hydrated from the
 * backend into this runner's real artifact spool before delivery, an agent's
 * send delivered as a steer under its frozen message id, and an agent's stop
 * recorded as the calling Session's with the full stop acts.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canonicalJson,
  SuperviseSessionError,
  TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  type HostedSessionRuntime,
  type SessionEngine,
} from "@volli/session-engine";
import { encodeSessionJson, LOCAL_RUNNER } from "@volli/shared";
import { SESSION_COMMAND_FORMAT, type ClaimedJob, type JobOutcome } from "@volli/shared/cloud";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import type { JobContext, JobExecutor } from "../cloud-runner/inbox";
import { createTestSessionEngine } from "../testing/session-engine";
import { SpoolTranscriptArtifactStore } from "../transcript-spool/artifact-spool";
import { registerSessionCommandJob, type CommandArtifactSource } from "./session-jobs";

const opened: TestDb[] = [];
const spools: string[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) db.cleanup();
  for (const dir of spools.splice(0)) await rm(dir, { recursive: true, force: true });
});

const CALLER = "board-session";
const TARGET = "target-session";
const OPERATION = `${CALLER}:toolu_01`;
const jobContext: JobContext = { signal: new AbortController().signal, renew: async () => true };

/** The body a `session_send` carries, exactly as the caller's door builds it. */
function sent(text = "[Steering from supervising Session] rebase first") {
  const artifact = {
    version: 1 as const,
    threadId: OPERATION,
    branchId: OPERATION,
    attemptId: OPERATION,
    turnId: null,
    message: {
      id: `${OPERATION}:message`,
      role: "user" as const,
      parts: [{ type: "text" as const, text }],
    },
  };
  const body = canonicalJson(artifact);
  const id = `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
  return {
    artifact,
    body,
    reference: { id, digest: id, mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE },
  };
}

function job(
  intent: unknown,
  createdBy: ClaimedJob["job"]["createdBy"] = {
    kind: "agent",
    userId: "a",
    sessionId: CALLER,
    ticketId: null,
  } as unknown as ClaimedJob["job"]["createdBy"],
): ClaimedJob {
  return {
    job: {
      id: OPERATION,
      kind: "session.command",
      runnerId: "runner-b",
      projectId: "p",
      ticketId: null,
      sessionId: TARGET,
      workingCopyId: null,
      commandId: OPERATION,
      payload: { format: SESSION_COMMAND_FORMAT, intent: encodeSessionJson(intent) },
      priority: "normal",
      createdBy,
      createdAt: 0,
      availableAt: 0,
    },
    lease: { bootId: "boot", attempt: 1, expiresAt: 60_000 },
  } as ClaimedJob;
}

async function fixture(
  options: { commandArtifact?: CommandArtifactSource; engine?: SessionEngine } = {},
) {
  const testDb = openTestDb();
  opened.push(testDb);
  insertProject(testDb.db, testProject({ id: "p" }));
  const engine = options.engine ?? createTestSessionEngine(testDb.db);
  if (options.engine === undefined) {
    await engine.createSession({
      commandId: `birth-${TARGET}`,
      requestedSessionId: TARGET,
      projectId: "p",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: LOCAL_RUNNER },
    });
  }
  const spool = await mkdtemp(join(tmpdir(), "volli-session-jobs-"));
  spools.push(spool);
  const artifacts = new SpoolTranscriptArtifactStore(spool);
  const command = vi.fn(async (_input: unknown) => ({
    receipt: { status: "accepted" } as { status: string; code?: string; detail?: string | null },
  }));
  const runtime = { command } as unknown as HostedSessionRuntime;
  let execute: JobExecutor | undefined;
  registerSessionCommandJob(
    {
      register: (_kind, executor) => {
        execute = executor;
      },
    },
    {
      engine,
      runtime: () => runtime,
      artifacts: () => artifacts,
      ...(options.commandArtifact === undefined
        ? {}
        : { commandArtifact: options.commandArtifact }),
    },
  );
  return {
    engine,
    artifacts,
    command,
    execute: (claimed: ClaimedJob): Promise<JobOutcome> => execute!(claimed, jobContext),
  };
}

describe("a message sent from another runner", () => {
  it("hydrates the staged body into this runner's spool, then delivers it as a steer", async () => {
    const { artifact, body, reference } = sent();
    const commandArtifact = vi.fn(async () => body);
    const f = await fixture({ commandArtifact });
    expect(await f.execute(job({ kind: "message.submit", reference }))).toEqual({
      status: "done",
      result: null,
    });
    expect(commandArtifact).toHaveBeenCalledWith({ sessionId: TARGET, digest: reference.id });
    // Written where every later read (the transcript, the pack) finds it.
    await expect(f.artifacts.read(reference)).resolves.toEqual(artifact);
    expect(f.command).toHaveBeenCalledWith({
      sessionId: TARGET,
      commandId: OPERATION,
      origin: { kind: "session", sessionId: CALLER },
      command: {
        kind: "message.submit",
        message: artifact.message,
        settle: "opened",
        delivery: "steer",
      },
    });
    // A replay reads the body this runner now holds, without asking again.
    await f.execute(job({ kind: "message.submit", reference }));
    expect(commandArtifact).toHaveBeenCalledTimes(1);
  });

  it("keeps a person's message on the runtime's default delivery", async () => {
    const { artifact, body, reference } = sent("Plain message");
    const f = await fixture({ commandArtifact: async () => body });
    await f.execute(
      job({ kind: "message.submit", reference }, {
        kind: "person",
        userId: "a",
      } as ClaimedJob["job"]["createdBy"]),
    );
    expect(f.command).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { kind: "user" },
        command: { kind: "message.submit", message: artifact.message, settle: "opened" },
      }),
    );
  });

  it("refuses a staged body that is not the reference's, before delivery", async () => {
    const { reference } = sent();
    const f = await fixture({ commandArtifact: async () => sent("Something else").body });
    expect(await f.execute(job({ kind: "message.submit", reference }))).toMatchObject({
      status: "failed",
      code: "artifact_mismatch",
      retryable: false,
    });
    const unreadable = await fixture({ commandArtifact: async () => "{" });
    expect(await unreadable.execute(job({ kind: "message.submit", reference }))).toMatchObject({
      code: "invalid_artifact",
      retryable: false,
    });
    expect(f.command).not.toHaveBeenCalled();
    expect(unreadable.command).not.toHaveBeenCalled();
  });

  it("retries when nothing is staged, without journaling local detail", async () => {
    const { reference } = sent();
    const f = await fixture({ commandArtifact: async () => null });
    // The executor's own failure; the owner gate turns it into a retryable `executor_error`.
    await expect(f.execute(job({ kind: "message.submit", reference }))).rejects.toThrow();
    expect(f.command).not.toHaveBeenCalled();
  });
});

describe("an agent's stop", () => {
  it("is recorded as the calling Session's, under the job's command id, idempotently", async () => {
    const f = await fixture();
    const stop = {
      kind: "session.stop",
      reason: "Superseded",
      by: { kind: "session", sessionId: CALLER },
    };
    expect(await f.execute(job(stop))).toEqual({ status: "done", result: null });
    expect(await f.execute(job(stop))).toEqual({ status: "done", result: null });
    const events = await f.engine.listEvents({ sessionId: TARGET });
    const stopped = events.filter((event) => event.payload.kind === "session.stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({
      commandId: OPERATION,
      payload: { reason: "Superseded", by: { kind: "session", sessionId: CALLER } },
      provenance: {
        source: {
          kind: "system",
          id: "session-supervision",
          detail: { sessionOrigin: { kind: "session", sessionId: CALLER } },
        },
      },
    });
    // Nothing was live: no runtime acts to take.
    expect(f.command).not.toHaveBeenCalled();
  });

  it("refuses a stop attributed to anyone but the calling Session", async () => {
    const f = await fixture();
    for (const by of [{ kind: "user" }, { kind: "session", sessionId: "someone-else" }]) {
      expect(await f.execute(job({ kind: "session.stop", reason: null, by }))).toMatchObject({
        code: "invalid_job_payload",
        retryable: false,
      });
    }
    expect(
      (await f.engine.listEvents({ sessionId: TARGET })).some(
        (event) => event.payload.kind === "session.stopped",
      ),
    ).toBe(false);
  });

  it("interrupts and releases a live executor, and retries when it does not let go", async () => {
    const projection = {
      session: { id: TARGET, title: null },
      stopped: null,
      turnActive: true,
      attachments: [{ id: "binding", adapterId: "pi", status: "open" }],
    };
    const submit = vi.fn(async () => ({ receipt: { status: "completed" } }));
    const engine = {
      getSession: async () => projection,
      submit,
    } as unknown as SessionEngine;
    const f = await fixture({ engine });
    f.command.mockImplementation(async (input: unknown) => {
      const { command } = input as { command: { kind: string } };
      return command.kind === "adapter.release"
        ? {
            receipt: {
              status: "rejected",
              code: "release_failed",
              detail: "Could not close /runner/private/pi.sock",
            },
          }
        : { receipt: { status: "accepted" } };
    });
    const outcome = await f.execute(
      job({ kind: "session.stop", reason: null, by: { kind: "session", sessionId: CALLER } }),
    );
    expect(outcome).toMatchObject({ status: "failed", code: "stop_incomplete", retryable: true });
    expect(JSON.stringify(outcome)).not.toContain("/runner/private");
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: OPERATION,
        intent: { kind: "session.stop", reason: null, by: { kind: "session", sessionId: CALLER } },
      }),
    );
    expect(f.command.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        commandId: `${OPERATION}:interrupt`,
        origin: { kind: "session", sessionId: CALLER },
        command: { kind: "executor.interrupt", attachmentId: "binding" },
      }),
      expect.objectContaining({
        commandId: `${OPERATION}:release`,
        origin: { kind: "session", sessionId: CALLER },
        command: { kind: "adapter.release", attachmentId: "binding" },
      }),
    ]);
  });
});

describe("a person's stop", () => {
  it("stays the runtime's own stop, and a named refusal is final", async () => {
    const f = await fixture();
    f.command.mockRejectedValueOnce(
      new SuperviseSessionError("Session target is not live; there is nothing running to stop."),
    );
    const outcome = await f.execute(
      job({ kind: "session.stop", reason: null, by: { kind: "user" } }, {
        kind: "person",
        userId: "a",
      } as ClaimedJob["job"]["createdBy"]),
    );
    expect(outcome).toEqual({
      status: "failed",
      code: "command_refused",
      detail: "Session target is not live; there is nothing running to stop.",
      retryable: false,
    });
    expect(f.command).toHaveBeenCalledWith(
      expect.objectContaining({ command: { kind: "session.stop" }, origin: { kind: "user" } }),
    );
  });
});
