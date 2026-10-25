import { randomUUID } from "node:crypto";

import { convexTest } from "convex-test";
import { describe, expect, test } from "vite-plus/test";

import { cloudInteractionResolve, cloudMessageSubmit } from "@volli/shared";
import { INLINE_ARTIFACT_MAX_BYTES, RUNNER_TOKEN_ISSUER, type UserId } from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { seedTestRunner, seedTestWorld } from "../functions/lib/testWorld";
import schema from "../functions/schema";
import { wire, writeSession } from "./sessionFixtures";

const modules = import.meta.glob("../functions/**/*.ts");
const ISSUER = "https://issuer.test";

type T = ReturnType<typeof convexTest>;

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

const asUser = (t: T, name: string) => t.withIdentity({ subject: `user:${name}`, issuer: ISSUER });
const asRunner = (t: T, runnerId: string) =>
  t.withIdentity({ subject: `runner:${runnerId}`, issuer: RUNNER_TOKEN_ISSUER });

const message = (text: string) => ({
  id: `m-${text}`,
  role: "user" as const,
  parts: [{ type: "text", text }],
});

/** Alice's Session, claimed by her first runner; Bob is a teammate; Carol has a runner of her own. */
async function world() {
  const t = convexTest(schema, modules);
  const users: Record<string, UserId> = {};
  for (const name of ["alice", "bob", "carol"]) {
    users[name] = (await asUser(t, name).mutation(api.accounts.ensureViewer, {})).userId as UserId;
  }
  const seeded = await t.run((ctx) =>
    seedTestWorld(ctx, { ownerUserId: users.alice!, memberUserIds: [users.bob!], runners: 2 }),
  );
  const carolRunner = await t.run((ctx) => seedTestRunner(ctx, users.carol!, "carol-runner"));
  const runner = seeded.runnerIds[0]!;
  const { sessionId, events } = await writeSession({
    projectId: seeded.projectId,
    ticketId: seeded.ticketId,
  });
  for (const event of events) {
    await asRunner(t, runner).mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: [wire(event)],
    });
  }
  const send = (args: { commandId: string; intent: string; body?: string }, as = "alice") =>
    asUser(t, as).mutation(api.sessions.command, { sessionId, ...args });
  const staged = () => t.run((ctx) => ctx.db.query("transcriptArtifacts").collect());
  return { t, runner, otherRunner: seeded.runnerIds[1]!, carolRunner, sessionId, send, staged };
}

describe("sessions.command with a message body", () => {
  test("stages the body with its job, idempotently by command id and digest", async () => {
    const { send, staged, sessionId } = await world();
    const commandId = randomUUID();
    const built = cloudMessageSubmit({ sessionId, commandId, message: message("hello") });
    const first = await send({ commandId, intent: built.intent, body: built.body });
    expect(first).toMatchObject({ commandId, status: "queued", receipt: null });
    await expect(send({ commandId, intent: built.intent, body: built.body })).resolves.toEqual(
      first,
    );
    // The body is staged already, so a retry may leave it out.
    await expect(send({ commandId, intent: built.intent })).resolves.toEqual(first);
    const other = cloudMessageSubmit({ sessionId, commandId, message: message("other") });
    await expect(send({ commandId, intent: other.intent, body: other.body })).rejects.toThrow(
      code("id_taken"),
    );
    expect(await staged()).toEqual([
      expect.objectContaining({
        sessionId,
        digest: built.reference.digest,
        mediaType: built.reference.mediaType,
        bytes: new TextEncoder().encode(built.body).length,
        body: built.body,
        spillKey: null,
        firstSequence: null,
        uploadedBy: "client",
        packedSegmentId: null,
        expiresAt: null,
      }),
    ]);
  });

  test("queues a message without a body as before, naming a body its runner holds", async () => {
    const { send, staged, sessionId } = await world();
    const commandId = randomUUID();
    const built = cloudMessageSubmit({ sessionId, commandId, message: message("local") });
    const legacy = JSON.stringify({
      kind: "message.submit",
      reference: { id: "runner-local", mediaType: "application/json", digest: null },
    });
    await expect(send({ commandId, intent: legacy })).resolves.toMatchObject({
      commandId,
      status: "queued",
    });
    await expect(send({ commandId: randomUUID(), intent: built.intent })).resolves.toMatchObject({
      status: "queued",
    });
    expect(await staged()).toEqual([]);
  });

  test("repairs a corrupt inline row under the body's digest, and keeps an honest one", async () => {
    const { t, send, staged, sessionId } = await world();
    const commandId = randomUUID();
    const built = cloudMessageSubmit({ sessionId, commandId, message: message("hello") });
    await t.run((ctx) =>
      ctx.db.insert("transcriptArtifacts", {
        sessionId,
        digest: built.reference.digest!,
        mediaType: "application/json",
        bytes: 7,
        body: "corrupt",
        spillKey: null,
        firstSequence: 3,
        uploadedBy: "runner",
        packedSegmentId: null,
        expiresAt: null,
        createdAt: 1,
      }),
    );
    await send({ commandId, intent: built.intent, body: built.body });
    const rows = await staged();
    expect(rows).toEqual([
      expect.objectContaining({
        body: built.body,
        bytes: new TextEncoder().encode(built.body).length,
        mediaType: built.reference.mediaType,
        // The row's own facts stay: it is the same artifact, now with its bytes.
        firstSequence: 3,
        uploadedBy: "runner",
      }),
    ]);
    await send({ commandId, intent: built.intent, body: built.body });
    expect(await staged()).toEqual(rows);
  });

  test("refuses a body that is not the command's, and a body or reference out of place", async () => {
    const { send, staged, sessionId } = await world();
    const commandId = randomUUID();
    const built = cloudMessageSubmit({ sessionId, commandId, message: message("hello") });
    const foreign = cloudMessageSubmit({
      sessionId,
      commandId: randomUUID(),
      message: message("hello"),
    });
    const other = cloudMessageSubmit({ sessionId, commandId, message: message("other") });
    const answer = cloudInteractionResolve({
      sessionId,
      commandId,
      attachmentId: "a-1",
      interactionId: "i-1",
      resolution: { optionIds: [], response: "yes" },
    });
    const forged = JSON.stringify({ ...JSON.parse(answer.intent), reference: built.reference });
    for (const args of [
      { intent: built.intent, body: foreign.body },
      { intent: built.intent, body: other.body },
      { intent: built.intent, body: "x".repeat(INLINE_ARTIFACT_MAX_BYTES + 1) },
      { intent: JSON.stringify({ kind: "session.archive" }), body: built.body },
      { intent: answer.intent, body: built.body },
      { intent: forged },
    ]) {
      await expect(send({ commandId, ...args })).rejects.toThrow(code("invalid_request"));
    }
    await expect(
      send({ commandId, intent: built.intent, body: built.body }, "bob"),
    ).rejects.toThrow(code("forbidden"));
    await expect(
      send({ commandId, intent: built.intent, body: built.body }, "carol"),
    ).rejects.toThrow(code("not_found"));
    expect(await staged()).toEqual([]);
    // An answer whose reference its intent derives is queued, and stages nothing.
    await expect(send({ commandId, intent: answer.intent })).resolves.toMatchObject({
      status: "queued",
    });
    expect(await staged()).toEqual([]);
  });
});

describe("sessionMessages.forRunner", () => {
  test("hands the staged body to the runner holding the claim and the job, no one else", async () => {
    const { t, runner, otherRunner, carolRunner, sessionId, send } = await world();
    const commandId = randomUUID();
    const built = cloudMessageSubmit({ sessionId, commandId, message: message("hello") });
    await send({ commandId, intent: built.intent, body: built.body });
    const read = (as: string, id = commandId) =>
      asRunner(t, as).query(api.sessionMessages.forRunner, { sessionId, commandId: id });
    await expect(read(runner)).resolves.toEqual({ status: "staged", body: built.body });
    await expect(read(otherRunner)).rejects.toThrow(code("fenced"));
    const intake = await t.run((ctx) =>
      ctx.db
        .query("sessionIntake")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique(),
    );
    await t.run((ctx) => ctx.db.patch(intake!._id, { state: "releasing" }));
    await expect(read(runner)).rejects.toThrow(code("fenced"));
    await t.run((ctx) => ctx.db.patch(intake!._id, { state: "active" }));
    await expect(read(carolRunner)).rejects.toThrow(code("not_your_runner"));
    await expect(read(runner, randomUUID())).rejects.toThrow(code("not_found"));
    await expect(
      asUser(t, "alice").query(api.sessionMessages.forRunner, { sessionId, commandId }),
    ).rejects.toThrow(code("not_a_runner"));
    const retitle = randomUUID();
    await send({
      commandId: retitle,
      intent: JSON.stringify({ kind: "session.retitle", title: "x" }),
    });
    await expect(read(runner, retitle)).rejects.toThrow(code("invalid_request"));
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("transcriptArtifacts").collect())
        await ctx.db.delete(row._id);
    });
    await expect(read(runner)).resolves.toEqual({ status: "missing" });
  });
});

describe("sessionMessages.pending", () => {
  test("lists the owner's unanswered commands, waiting or ended with their reason, newest first", async () => {
    const { t, sessionId, send } = await world();
    const sent = randomUUID();
    const built = cloudMessageSubmit({ sessionId, commandId: sent, message: message("hello") });
    await send({ commandId: sent, intent: built.intent, body: built.body });
    const answered = randomUUID();
    const answer = cloudInteractionResolve({
      sessionId,
      commandId: answered,
      attachmentId: "a-1",
      interactionId: "i-1",
      resolution: { optionIds: ["ok"], response: null },
    });
    await send({ commandId: answered, intent: answer.intent });
    const settled = randomUUID();
    await send({ commandId: settled, intent: JSON.stringify({ kind: "session.archive" }) });
    const failed = randomUUID();
    await send({ commandId: failed, intent: JSON.stringify({ kind: "session.archive" }) });
    await t.run(async (ctx) => {
      for (const job of await ctx.db.query("runnerJobs").collect()) {
        if (job.id === settled)
          await ctx.db.patch(job._id, {
            status: "done",
            receipt: { status: "completed", code: null, detail: null, at: Date.now() },
          });
        if (job.id === failed)
          await ctx.db.patch(job._id, {
            status: "failed",
            failure: {
              attempt: 1,
              code: "message_unavailable",
              detail: "This message's body was never staged for this runner.",
              retryable: false,
              by: "runner",
              at: Date.now(),
            },
          });
        if (job.id === answered) await ctx.db.patch(job._id, { status: "done" });
      }
    });
    const { commands } = await asUser(t, "alice").query(api.sessionMessages.pending, { sessionId });
    expect(commands).toEqual([
      expect.objectContaining({
        commandId: failed,
        status: "failed",
        kind: "session.archive",
        reference: null,
        failure: {
          attempt: 1,
          code: "message_unavailable",
          detail: "This message's body was never staged for this runner.",
          retryable: false,
        },
      }),
      expect.objectContaining({
        commandId: answered,
        status: "done",
        kind: "interaction.resolve",
        reference: answer.reference,
        messageId: null,
        body: null,
      }),
      expect.objectContaining({
        commandId: sent,
        status: "queued",
        kind: "message.submit",
        reference: built.reference,
        messageId: "m-hello",
        body: built.body,
        failure: null,
      }),
    ]);
    await expect(
      asUser(t, "bob").query(api.sessionMessages.pending, { sessionId }),
    ).rejects.toThrow(code("forbidden"));
    await expect(
      asUser(t, "carol").query(api.sessionMessages.pending, { sessionId }),
    ).rejects.toThrow(code("not_found"));
  });
});
