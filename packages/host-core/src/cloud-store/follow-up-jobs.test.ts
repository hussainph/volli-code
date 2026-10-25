import { describe, expect, test, vi } from "vite-plus/test";
import type { HostedSessionRuntime, TranscriptArtifactStore } from "@volli/session-engine";
import { SESSION_FOLLOW_UP_FORMAT, type ClaimedJob } from "@volli/shared/cloud";
import { executeFollowUpJob, type FollowUpJobInput } from "./follow-up-jobs";
import { createSessionRuntime, createSessionExecutorSlot } from "@volli/session-engine";
import { createInMemoryTranscriptArtifactStore } from "@volli/session-engine/testing";
import { createTestSessionEngine } from "../testing/session-engine";
import { createSqliteSessionFollowUpLedger } from "../db/session-follow-up-repo";
import { openTestDb, testProject } from "../db/test-helpers";
import { insertProject } from "../db/projects-repo";
const reference = { id: "sha256:body", mediaType: null, digest: "sha256:body" };
const message = {
  id: "m",
  role: "user" as const,
  parts: [{ type: "text" as const, text: "body" }],
};
const artifact = {
  version: 1 as const,
  threadId: "t",
  branchId: "b",
  attemptId: "a",
  turnId: null,
  message,
};
const intent = { kind: "message.submit", delivery: "queue", messageId: "m", reference };
const context = { signal: new AbortController().signal, renew: async () => true };
function job(value: unknown = intent): ClaimedJob {
  return {
    job: {
      id: "command",
      commandId: "command",
      sessionId: "s",
      kind: "session.followUp",
      payload: { format: SESSION_FOLLOW_UP_FORMAT, intent: JSON.stringify(value) },
      createdBy: { kind: "person", userId: "u" },
    },
  } as ClaimedJob;
}
function fakeRuntimeFixture() {
  const calls: string[] = [];
  const command = vi.fn(async () => {
    calls.push("command");
    return { receipt: { status: "accepted" } };
  });
  const read = vi.fn(async () => artifact);
  const input: FollowUpJobInput = {
    runtime: () =>
      ({
        command,
        projection: async () => ({
          throughSequence: 0,
          projection: { queue: [{ id: "m", message, commandId: "original", state: "queued" }] },
        }),
      }) as unknown as HostedSessionRuntime,
    artifacts: () => ({ read, write: async () => reference }) as TranscriptArtifactStore,
    publish: async () => {
      calls.push("mirror");
    },
  };
  return { calls, command, read, input };
}
describe("follow-up inbox executor", () => {
  test("replays an accepted send-now after restart and a failed mirror without steering twice", async () => {
    const db = openTestDb();
    insertProject(db.db, testProject({ id: "p" }));
    const engine = createTestSessionEngine(db.db);
    await engine.createSession({
      commandId: "create",
      requestedSessionId: "s",
      projectId: "p",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      provenance: {
        source: { kind: "system", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    const artifacts = createInMemoryTranscriptArtifactStore();
    const sent: string[] = [];
    const executors = createSessionExecutorSlot({
      id: "fake",
      durableIdNamespace: "fake",
      adapterVersion: "1",
      runtime: { path: "fake", version: "1", fingerprint: "fake" },
      attach: async (_spec, sink) => ({
        native: { id: "native", detail: null },
        dispatch: async (command) => {
          if (command.kind === "message.submit") {
            sent.push(command.commandId);
            if (command.delivery !== "steer")
              await sink.emit({
                kind: "turn",
                state: "started",
                turnId: `turn:${command.commandId}`,
                occurredAt: Date.now(),
              });
          }
          return {
            commandId: command.commandId,
            status: "accepted",
            acceptedAt: Date.now(),
            native: null,
          };
        },
        reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
        release: async () => {},
      }),
    });
    const makeRuntime = () =>
      createSessionRuntime({
        engine,
        followUps: createSqliteSessionFollowUpLedger(db.db),
        artifacts,
        executors,
        clock: { now: Date.now },
        ids: { next: () => crypto.randomUUID() },
        locations: {
          resolve: async () => ({ directory: "/fake", venue: { id: "local", kind: "local" } }),
          prepare: async () => ({ directory: "/fake", venue: { id: "local", kind: "local" } }),
          reaffirm: async () => {},
        },
      });
    let runtime = makeRuntime();
    try {
      await runtime.command({
        sessionId: "s",
        commandId: "attach",
        command: { kind: "adapter.attach", continuity: "fresh" },
      });
      await runtime.command({
        sessionId: "s",
        commandId: "live",
        command: { kind: "message.submit", message: { ...message, id: "live" }, settle: "opened" },
      });
      await vi.waitFor(async () =>
        expect((await runtime.projection({ sessionId: "s" })).projection.turnActive).toBe(true),
      );
      await runtime.command({
        sessionId: "s",
        commandId: "queue",
        command: { kind: "message.submit", message, delivery: "queue" },
      });
      const claimed = job({ kind: "message.submit", delivery: "steer", messageId: "m" });
      claimed.job.kind = "session.command";
      const publish = vi.fn(async () => {}).mockRejectedValueOnce(new Error("mirror disconnected"));
      const input: FollowUpJobInput = {
        runtime: () => runtime,
        artifacts: () => artifacts,
        publish,
      };
      await expect(executeFollowUpJob(claimed, context, input)).rejects.toThrow(
        "mirror disconnected",
      );
      await vi.waitFor(async () =>
        expect((await runtime.projection({ sessionId: "s" })).projection.queue).toEqual([]),
      );
      expect(sent).toContain(claimed.job.commandId);
      await runtime.close();
      runtime = makeRuntime();
      expect(await executeFollowUpJob(claimed, context, input)).toEqual({
        status: "done",
        result: { receipt: { status: "accepted", code: null, detail: null } },
      });
      expect(sent.filter((id) => id === claimed.job.commandId)).toHaveLength(1);
      expect(publish).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.close();
      db.cleanup();
    }
  });
  test("a re-lease replays the real SQLite queue without a second item", async () => {
    const fixture = openTestDb();
    insertProject(fixture.db, testProject({ id: "p" }));
    const engine = createTestSessionEngine(fixture.db);
    await engine.createSession({
      commandId: "create",
      requestedSessionId: "s",
      projectId: "p",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      provenance: {
        source: { kind: "system", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    const artifacts = createInMemoryTranscriptArtifactStore();
    const ref = await artifacts.write(artifact);
    const runtime = createSessionRuntime({
      engine,
      followUps: createSqliteSessionFollowUpLedger(fixture.db),
      artifacts,
      executors: createSessionExecutorSlot({
        id: "fake",
        durableIdNamespace: "fake",
        adapterVersion: "1",
        runtime: { path: "/fake", version: "1", fingerprint: "fake" },
        attach: async () => {
          throw new Error("should stay held");
        },
      }),
      clock: { now: Date.now },
      ids: { next: () => crypto.randomUUID() },
      locations: {
        resolve: async () => ({ directory: "/fake", venue: { id: "local", kind: "local" } }),
        prepare: async () => ({ directory: "/fake", venue: { id: "local", kind: "local" } }),
        reaffirm: async () => {},
      },
    });
    runtime.holdTurnStarts();
    const observe = vi.fn();
    const off = runtime.onFollowUpQueue!(observe);
    const offThrowing = runtime.onFollowUpQueue!(() => {
      throw new Error("observer-only failure");
    });
    try {
      const input: FollowUpJobInput = {
        runtime: () => runtime,
        artifacts: () => artifacts,
        publish: async () => {
          expect((await runtime.projection({ sessionId: "s" })).projection.queue).toHaveLength(1);
        },
      };
      const claimed = job({ ...intent, reference: ref });
      const first = await executeFollowUpJob(claimed, context, input);
      const second = await executeFollowUpJob(claimed, context, input);
      expect(second).toEqual(first);
      expect((await runtime.projection({ sessionId: "s" })).projection.queue).toHaveLength(1);
      await vi.waitFor(() =>
        expect(observe).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "queue", sessionId: "s" }),
        ),
      );
      off();
      offThrowing();
    } finally {
      await runtime.close();
      fixture.cleanup();
    }
  });
  test("queues with original identity and awaits the mirror before returning a done receipt", async () => {
    const f = fakeRuntimeFixture();
    expect(await executeFollowUpJob(job(), context, f.input)).toEqual({
      status: "done",
      result: { receipt: { status: "accepted", code: null, detail: null } },
    });
    expect(f.calls).toEqual(["command", "mirror"]);
    expect(f.command).toHaveBeenCalledWith({
      sessionId: "s",
      commandId: "command",
      command: { kind: "message.submit", delivery: "queue", settle: "opened", message },
      origin: { kind: "user" },
    });
    f.command.mockImplementationOnce(async () => ({
      receipt: { status: "rejected", code: "session_archived", detail: null },
    }));
    expect(await executeFollowUpJob(job(), context, f.input)).toMatchObject({
      status: "done",
      result: { receipt: { status: "rejected", code: "session_archived" } },
    });
  });
  test("edit/cancel/steer retain runtime race and revision semantics", async () => {
    const f = fakeRuntimeFixture();
    const edit = job({ kind: "message.edit", messageId: "m", expectedRevision: 7, reference });
    edit.job.kind = "session.command";
    await executeFollowUpJob(edit, context, f.input);
    expect(f.command).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: { kind: "message.edit", messageId: "m", message, expectedRevision: 7 },
      }),
    );
    const cancel = job({ kind: "message.cancel", messageId: "m" });
    cancel.job.kind = "session.command";
    await executeFollowUpJob(cancel, context, f.input);
    expect(f.command).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: { kind: "message.cancel", messageId: "m" } }),
    );
    const steer = job({ kind: "message.submit", delivery: "steer", messageId: "m" });
    steer.job.kind = "session.command";
    await executeFollowUpJob(steer, context, f.input);
    expect(f.command).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: expect.objectContaining({ delivery: "steer" }) }),
    );
  });
  test("malformed work fails permanently and regular commands fall through", async () => {
    const f = fakeRuntimeFixture();
    expect(await executeFollowUpJob(job({ kind: "wat" }), context, f.input)).toMatchObject({
      status: "failed",
      retryable: false,
    });
    const regular = job({ kind: "session.retitle", title: "x" });
    regular.job.kind = "session.command";
    expect(await executeFollowUpJob(regular, context, f.input)).toBeNull();
    expect(
      await executeFollowUpJob(job({ ...intent, delivery: "steer" }), context, f.input),
    ).toMatchObject({ status: "failed", code: "invalid_job_payload" });
    expect(
      await executeFollowUpJob(job(), context, { ...f.input, runtime: () => null }),
    ).toMatchObject({ status: "failed", retryable: true });
  });
  test("hydrates a staged artifact, verifies identity and retries a failed mirror", async () => {
    const f = fakeRuntimeFixture();
    f.read.mockRejectedValueOnce(new Error("missing"));
    f.input.commandArtifact = vi.fn(async () => JSON.stringify(artifact));
    await executeFollowUpJob(job(), context, f.input);
    expect(f.input.commandArtifact).toHaveBeenCalledWith({ sessionId: "s", digest: "sha256:body" });
    f.input.publish = async () => {
      throw new Error("offline");
    };
    await expect(executeFollowUpJob(job(), context, f.input)).rejects.toThrow("offline");
    const abort = new AbortController();
    abort.abort();
    await expect(
      executeFollowUpJob(job(), { ...context, signal: abort.signal }, f.input),
    ).rejects.toBeDefined();
  });
});
