import { createHash, randomUUID } from "node:crypto";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vite-plus/test";
import { canonicalJson, RUNNER_TOKEN_ISSUER } from "@volli/shared/cloud";
import { api, internal } from "../functions/_generated/api";
import schema from "../functions/schema";
import { seedTestWorld } from "../functions/lib/testWorld";
import { wire, writeSession } from "./sessionFixtures";
const modules = import.meta.glob("../functions/**/*.ts");
const code = (value: string) =>
  expect.objectContaining({ data: expect.objectContaining({ code: value }) });
async function world() {
  const t = convexTest(schema, modules);
  const person = t.withIdentity({ subject: "user:alice", issuer: "https://issuer.test" });
  const { userId } = await person.mutation(api.accounts.ensureViewer, {});
  const seeded = await t.run((ctx) => seedTestWorld(ctx, { ownerUserId: userId, runners: 2 }));
  const { sessionId, events } = await writeSession({
    projectId: seeded.projectId,
    ticketId: seeded.ticketId,
  });
  const runner = t.withIdentity({
    subject: `runner:${seeded.runnerIds[0]}`,
    issuer: RUNNER_TOKEN_ISSUER,
  });
  await runner.mutation(api.sessions.accept, {
    sessionId,
    generation: 1,
    events: events.map(wire),
  });
  const reference = { id: "artifact", mediaType: null, digest: null };
  const submit = (messageId = "m") => ({
    kind: "message.submit",
    delivery: "queue",
    messageId,
    reference,
  });
  const command = (intent: unknown, commandId: string = randomUUID()) => {
    const control = intent as {
      kind: string;
      delivery?: string;
      messageId?: string;
      reference?: { id: string };
    };
    if (
      control.kind === "message.edit" ||
      (control.kind === "message.submit" && control.delivery === "queue")
    ) {
      const artifact = canonicalJson({
        version: 1,
        threadId: "thread",
        branchId: "branch",
        attemptId: "attempt",
        turnId: null,
        message: {
          id: control.messageId,
          role: "user",
          parts: [{ type: "text", text: control.reference?.id ?? "body" }],
        },
      });
      const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
      return person.mutation(api.sessions.command, {
        sessionId,
        commandId,
        intent: JSON.stringify({
          ...control,
          reference: { id: digest, digest, mediaType: "application/vnd.volli.ui-message+json" },
        }),
        artifact,
      });
    }
    return person.mutation(api.sessions.command, {
      sessionId,
      commandId,
      intent: JSON.stringify(intent),
    });
  };
  return { t, person, runner, sessionId, submit, command, reference, ...seeded };
}

describe("follow-up intent routing", () => {
  test("queue replay survives in-place edit and sleeping-runner cancellation is final", async () => {
    const w = await world();
    const id = randomUUID();
    await w.command(w.submit(), id);
    expect(
      (await w.person.query(api.followUps.queue, { sessionId: w.sessionId })).items,
    ).toHaveLength(1);
    await w.command({
      kind: "message.edit",
      messageId: "m",
      reference: { ...w.reference, id: "changed" },
    });
    await w.command(w.submit(), id);
    await expect(w.command(w.submit("other"), id)).rejects.toMatchObject(code("id_taken"));
    const cancelled = await w.command({ kind: "message.cancel", messageId: "m" });
    expect(cancelled.receipt).toMatchObject({ status: "accepted" });
    expect((await w.person.query(api.followUps.queue, { sessionId: w.sessionId })).items).toEqual(
      [],
    );
    const original = await w.t.run((ctx) =>
      ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", id))
        .unique(),
    );
    expect(original).toMatchObject({
      status: "cancelled",
      lease: null,
      failure: { code: "withdrawn" },
    });
  });
  test("stages exact rich queued bodies and refuses missing or mismatched bodies", async () => {
    const w = await world();
    await expect(
      w.person.mutation(api.sessions.command, {
        sessionId: w.sessionId,
        commandId: randomUUID(),
        intent: JSON.stringify(w.submit()),
      }),
    ).rejects.toMatchObject(code("invalid_request"));
    const artifact = canonicalJson({
      version: 1,
      threadId: "t",
      branchId: "b",
      attemptId: "a",
      turnId: null,
      message: {
        id: "rich",
        role: "user",
        parts: [{ type: "file", mediaType: "text/plain", url: "attachment:fixture" }],
        metadata: {
          attachments: [{ id: "attachment", name: "fixture.txt" }],
          autoTitleBaseline: "title",
        },
      },
    });
    const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
    const intent = {
      ...w.submit("rich"),
      reference: { id: digest, digest, mediaType: "application/vnd.volli.ui-message+json" },
    };
    await w.person.mutation(api.sessions.command, {
      sessionId: w.sessionId,
      commandId: randomUUID(),
      intent: JSON.stringify(intent),
      artifact,
    });
    const staged = await w.runner.query(api.transcripts.commandArtifact, {
      sessionId: w.sessionId,
      generation: 1,
      digest,
    });
    expect(staged?.body).toBe(artifact);
    await expect(
      w.person.mutation(api.sessions.command, {
        sessionId: w.sessionId,
        commandId: randomUUID(),
        intent: JSON.stringify({ ...intent, messageId: "other" }),
        artifact,
      }),
    ).rejects.toMatchObject(code("invalid_request"));
    const sendNow = await w.command({
      kind: "message.submit",
      delivery: "steer",
      messageId: "rich",
    });
    expect(sendNow.status).toBe("queued");
  });

  test("backend-held edits advance the combined revision and stale clients conflict", async () => {
    const w = await world();
    await w.command(w.submit());
    const before = await w.person.query(api.followUps.queue, { sessionId: w.sessionId });
    const edit = {
      kind: "message.edit",
      messageId: "m",
      reference: { ...w.reference, id: "changed" },
      expectedRevision: before.revision,
    };
    const editId = randomUUID();
    await w.command(edit, editId);
    const after = await w.person.query(api.followUps.queue, { sessionId: w.sessionId });
    expect(after.revision).toBeGreaterThan(before.revision);
    await expect(w.command({ ...edit, reference: w.reference })).rejects.toMatchObject(
      code("queue_revision_conflict"),
    );
    await expect(
      w.command({ kind: "message.cancel", messageId: "m", expectedRevision: before.revision }),
    ).rejects.toMatchObject(code("queue_revision_conflict"));
    expect((await w.command(edit, editId)).receipt?.status).toBe("accepted");
    expect((await w.person.query(api.followUps.queue, { sessionId: w.sessionId })).revision).toBe(
      after.revision,
    );
  });

  test("runner-held controls translate view revisions to runner revisions", async () => {
    const w = await world();
    const queued = await w.command(w.submit());
    await w.runner.mutation(api.runnerJobs.claim, { bootId: randomUUID() });
    await w.runner.mutation(api.followUps.mirror, {
      sessionId: w.sessionId,
      generation: 1,
      revision: 27,
      items: [
        {
          messageId: "m",
          commandId: queued.commandId,
          state: "queued",
          message: null,
          messageDigest: "digest",
        },
      ],
    });
    const view = await w.person.query(api.followUps.queue, { sessionId: w.sessionId });
    const result = await w.command({
      kind: "message.cancel",
      messageId: "m",
      expectedRevision: view.revision,
    });
    const row = await w.t.run((ctx) =>
      ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", result.commandId))
        .unique(),
    );
    expect(JSON.parse(row!.payload.intent)).toMatchObject({
      kind: "message.cancel",
      expectedRevision: 27,
    });
    expect(JSON.parse(row!.commandIntent!)).toMatchObject({ expectedRevision: view.revision });
  });

  test("leased (including requeued) work edits/cancels go to the runner", async () => {
    const w = await world();
    const id = randomUUID();
    await w.command(w.submit(), id);
    await w.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", id))
        .unique())!;
      await ctx.db.patch(row._id, {
        lease: { bootId: randomUUID(), attempt: 1, expiresAt: Date.now() + 60000 },
      });
    });
    const result = await w.command({ kind: "message.cancel", messageId: "m" });
    expect(result.status).toBe("queued");
    const jobs = await w.t.run((ctx) => ctx.db.query("runnerJobs").collect());
    expect(jobs.find((j) => j.id === result.commandId)!.kind).toBe("session.command");
  });
  test("a runner rejection is a done intake with the queue receipt, not a retry", async () => {
    const w = await world();
    const queued = await w.command(w.submit());
    const bootId = randomUUID();
    const claimed = await w.runner.mutation(api.runnerJobs.claim, { bootId });
    const job = claimed.find((j) => j.job.id === queued.commandId)!;
    await w.runner.mutation(api.runnerJobs.complete, {
      jobId: job.job.id,
      bootId,
      attempt: job.lease.attempt,
      outcome: {
        status: "done",
        result: { receipt: { status: "rejected", code: "session_stopped", detail: null } },
      },
    });
    const replay = await w.person.query(api.sessions.receipt, {
      sessionId: w.sessionId,
      commandId: queued.commandId,
    });
    expect(replay).toMatchObject({
      status: "done",
      receipt: { status: "rejected", code: "session_stopped" },
    });
  });
  test("completion summaries cannot downgrade an accepted ledger receipt", async () => {
    const w = await world();
    const queued = await w.command(w.submit());
    const bootId = randomUUID();
    const [claimed] = await w.runner.mutation(api.runnerJobs.claim, { bootId });
    await w.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", queued.commandId))
        .unique())!;
      await ctx.db.patch(row._id, {
        receipt: { status: "accepted", code: null, detail: null, at: 1 },
      });
    });
    await w.runner.mutation(api.runnerJobs.complete, {
      jobId: queued.commandId,
      bootId,
      attempt: claimed!.lease.attempt,
      outcome: {
        status: "done",
        result: { receipt: { status: "rejected", code: "message_not_queued", detail: null } },
      },
    });
    expect(
      await w.person.query(api.sessions.receipt, {
        sessionId: w.sessionId,
        commandId: queued.commandId,
      }),
    ).toMatchObject({ status: "done", receipt: { status: "accepted", at: 1 } });
  });

  test("receipt reads are visibility checked and scoped to the named Session", async () => {
    const w = await world();
    const queued = await w.command(w.submit());
    expect(
      await w.person.query(api.sessions.receipt, {
        sessionId: w.sessionId,
        commandId: randomUUID(),
      }),
    ).toBeNull();
    const outsider = w.t.withIdentity({
      subject: "user:receipt-outsider",
      issuer: "https://issuer.test",
    });
    await outsider.mutation(api.accounts.ensureViewer, {});
    await expect(
      outsider.query(api.sessions.receipt, { sessionId: w.sessionId, commandId: queued.commandId }),
    ).rejects.toMatchObject(code("not_found"));
    await w.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", queued.commandId))
        .unique())!;
      await ctx.db.patch(row._id, { sessionId: null });
    });
    expect(
      await w.person.query(api.sessions.receipt, {
        sessionId: w.sessionId,
        commandId: queued.commandId,
      }),
    ).toBeNull();
  });

  test("cap, duplicate message and owner/archived rules", async () => {
    const w = await world();
    for (let i = 0; i < 32; i++) await w.command(w.submit(`m${i}`));
    await expect(w.command(w.submit("overflow"))).rejects.toMatchObject(code("queue_full"));
    expect((await w.command(w.submit("m0"))).receipt).toMatchObject({
      status: "rejected",
      code: "message_exists",
    });
    const other = w.t.withIdentity({ subject: "user:bob", issuer: "https://issuer.test" });
    await other.mutation(api.accounts.ensureViewer, {});
    await expect(
      other.mutation(api.sessions.command, {
        sessionId: w.sessionId,
        commandId: randomUUID(),
        intent: JSON.stringify(w.submit()),
      }),
    ).rejects.toBeDefined();
    await w.t.run(async (ctx) => {
      const s = (await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.sessionId))
        .unique())!;
      await ctx.db.patch(s._id, { status: "archived" });
    });
    expect((await w.command(w.submit("archived"))).receipt).toMatchObject({
      status: "rejected",
      code: "session_archived",
    });
  });
});

describe("follow-up mirror", () => {
  test("fenced, monotonic, bounded and cleared at claim transfer", async () => {
    const w = await world();
    const args = {
      sessionId: w.sessionId,
      generation: 1,
      revision: 1,
      items: [
        {
          messageId: "m",
          commandId: randomUUID(),
          state: "queued" as const,
          message: "{}",
          messageDigest: "sha",
        },
      ],
    };
    const before = await w.person.query(api.followUps.queue, { sessionId: w.sessionId });
    expect(await w.runner.mutation(api.followUps.mirror, args)).toEqual({ written: true });
    const mirrored = await w.person.query(api.followUps.queue, { sessionId: w.sessionId });
    expect(mirrored.revision).toBeGreaterThan(before.revision);
    expect(await w.runner.mutation(api.followUps.mirror, args)).toEqual({ written: false });
    expect((await w.person.query(api.followUps.queue, { sessionId: w.sessionId })).revision).toBe(
      mirrored.revision,
    );
    await expect(
      w.runner.mutation(api.followUps.mirror, { ...args, generation: 0 }),
    ).rejects.toMatchObject(code("fenced"));
    await expect(
      w.runner.mutation(api.followUps.mirror, {
        ...args,
        revision: 2,
        items: [{ ...args.items[0]!, message: "x".repeat(8193) }],
      }),
    ).rejects.toMatchObject(code("invalid_queue"));
    await expect(
      w.runner.mutation(api.followUps.mirror, {
        ...args,
        items: Array.from({ length: 33 }, (_, i) => ({ ...args.items[0]!, messageId: String(i) })),
      }),
    ).rejects.toMatchObject(code("invalid_queue"));
    await expect(
      w.runner.mutation(api.followUps.mirror, {
        ...args,
        revision: 2,
        items: Array.from({ length: 32 }, (_, i) => ({
          ...args.items[0]!,
          messageId: String(i),
          message: "x".repeat(3000),
        })),
      }),
    ).rejects.toMatchObject(code("invalid_queue"));
    await expect(
      w.runner.mutation(api.followUps.mirror, {
        ...args,
        revision: 2,
        items: [args.items[0]!, args.items[0]!],
      }),
    ).rejects.toMatchObject(code("invalid_queue"));
    expect(
      (await w.person.query(api.followUps.queue, { sessionId: w.sessionId })).items[0],
    ).toMatchObject({ messageId: "m", message: "{}" });
    const intake = await w.t.run((ctx) =>
      ctx.db
        .query("sessionIntake")
        .withIndex("by_session", (q) => q.eq("sessionId", w.sessionId))
        .unique(),
    );
    await w.t.mutation(internal.sessions.transferClaim, {
      sessionId: w.sessionId,
      toRunnerId: w.runnerIds[1]!,
      headSequence: intake!.acceptedThrough,
    });
    const transferred = await w.person.query(api.followUps.queue, { sessionId: w.sessionId });
    expect(transferred.items).toEqual([]);
    expect(transferred.revision).toBeGreaterThan(mirrored.revision);
    await expect(
      w.command({ kind: "message.cancel", messageId: "m", expectedRevision: mirrored.revision }),
    ).rejects.toMatchObject(code("queue_revision_conflict"));
    await expect(
      w.runner.mutation(api.followUps.mirror, { ...args, revision: 2 }),
    ).rejects.toMatchObject(code("fenced"));
  });
});
