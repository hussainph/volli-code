import { describe, expect, it } from "vite-plus/test";
import { QueueRevisionConflictError } from "@volli/shared";
import {
  createInMemorySessionFollowUpLedger,
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
} from "./index";

const message = (text: string) => ({
  id: "queued",
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

async function fixture() {
  let sequence = 0;
  const clock = { now: () => ++sequence };
  const ids = { next: (kind: string) => `${kind}-${++sequence}` };
  const engine = createSessionEngine({ ledger: createInMemorySessionLedger(), clock, ids });
  const runtime = createSessionRuntime({
    engine,
    clock,
    ids,
    artifacts: createInMemoryTranscriptArtifactStore(),
    followUps: createInMemorySessionFollowUpLedger(),
    executor: {
      id: "test",
      durableIdNamespace: "test",
      adapterVersion: "1",
      runtime: { path: "/test", version: "1", fingerprint: "test" },
      attach: async () => {
        throw new Error("Attention must hold this queue");
      },
    },
    locations: {
      resolve: async () => ({ directory: "/test", venue: { id: "local", kind: "local" } }),
      prepare: async () => ({ directory: "/test", venue: { id: "local", kind: "local" } }),
      reaffirm: async () => undefined,
    },
  });
  const { sessionId } = await runtime.command({
    commandId: "create",
    command: {
      kind: "session.create",
      projectId: "project",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
    },
  });
  await engine.observe({
    id: "hold",
    sessionId,
    occurredAt: clock.now(),
    provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
    kind: "attention.raised",
    attention: {
      id: "hold",
      kind: "permission_required",
      attachmentId: null,
      detail: "Hold queue",
      diagnostic: null,
    },
  });
  await runtime.command({
    commandId: "queue",
    sessionId,
    command: { kind: "message.submit", delivery: "queue", message: message("original") },
  });
  return { runtime, sessionId };
}

describe("revision-aware queue mutations", () => {
  it("refuses stale edits and cancels without changing payload or revision, and replays accepted commands", async () => {
    const { runtime, sessionId } = await fixture();
    const read = async () => (await runtime.projection({ sessionId })).projection;
    const revision = (await read()).queueRevision!;
    const edit = {
      commandId: "edit",
      sessionId,
      command: {
        kind: "message.edit" as const,
        messageId: "queued",
        message: message("new"),
        expectedRevision: revision,
      },
    };
    const accepted = await runtime.command(edit);
    expect(accepted.receipt?.status).toBe("accepted");
    for (const command of [
      { kind: "message.cancel" as const, messageId: "queued", expectedRevision: revision },
      {
        kind: "message.edit" as const,
        messageId: "queued",
        message: message("stale"),
        expectedRevision: revision,
      },
    ]) {
      await expect(
        runtime.command({ commandId: `stale-${command.kind}`, sessionId, command }),
      ).rejects.toBeInstanceOf(QueueRevisionConflictError);
    }
    const projection = await read();
    expect(projection.queueRevision).toBe(revision + 1);
    expect(projection.queue?.[0].message).toEqual(message("new"));
    expect(await runtime.command(edit)).toEqual(accepted);
    expect((await read()).queueRevision).toBe(revision + 1);
    expect(
      (
        await runtime.command({
          commandId: "cancel",
          sessionId,
          command: { kind: "message.cancel", messageId: "queued", expectedRevision: revision + 1 },
        })
      ).receipt?.status,
    ).toBe("accepted");
    expect((await read()).queue).toEqual([]);
    await runtime.close();
  });

  it("lets only one of two Clients mutate the same revision", async () => {
    const { runtime, sessionId } = await fixture();
    const expectedRevision = (await runtime.projection({ sessionId })).projection.queueRevision!;
    const results = await Promise.allSettled([
      runtime.command({
        commandId: "client-a",
        sessionId,
        command: {
          kind: "message.edit",
          messageId: "queued",
          message: message("client-a"),
          expectedRevision,
        },
      }),
      runtime.command({
        commandId: "client-b",
        sessionId,
        command: { kind: "message.cancel", messageId: "queued", expectedRevision },
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      status: "rejected",
      reason: expect.any(QueueRevisionConflictError),
    });
    expect((await runtime.projection({ sessionId })).projection.queueRevision).toBe(
      expectedRevision + 1,
    );
    await runtime.close();
  });
});
