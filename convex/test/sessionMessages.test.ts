import { createHash, randomUUID } from "node:crypto";

import { convexTest } from "convex-test";
import { describe, expect, test } from "vite-plus/test";

import { canonicalJson, TRANSCRIPT_ARTIFACT_MEDIA_TYPE } from "@volli/session-engine";
import { cloudInteractionResolve, cloudMessageSubmit } from "@volli/shared";
import {
  AGENT_TOKEN_ISSUER,
  INLINE_ARTIFACT_MAX_BYTES,
  RUNNER_TOKEN_ISSUER,
  agentSubject,
  type SessionId,
  type UserId,
} from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { seedTestWorld } from "../functions/lib/testWorld";
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

/** Alice's Session, claimed by her first runner; Bob is a teammate; Carol is outside the Workspace. */
async function world() {
  const t = convexTest(schema, modules);
  const users: Record<string, UserId> = {};
  for (const name of ["alice", "bob", "carol"]) {
    users[name] = (await asUser(t, name).mutation(api.accounts.ensureViewer, {})).userId as UserId;
  }
  const seeded = await t.run((ctx) =>
    seedTestWorld(ctx, { ownerUserId: users.alice!, memberUserIds: [users.bob!], runners: 2 }),
  );
  const runner = seeded.runnerIds[0]!;
  const { sessionId, events, engine } = await writeSession({
    projectId: seeded.projectId,
    ticketId: seeded.ticketId,
  });
  let accepted = 0;
  /** Accepts what the runner's ledger holds past what was accepted, one fact at a time. */
  const drain = async () => {
    const all = await engine.listEvents({ sessionId });
    for (const event of all.slice(accepted)) {
      await asRunner(t, runner).mutation(api.sessions.accept, {
        sessionId,
        generation: 1,
        events: [wire(event)],
      });
    }
    accepted = all.length;
  };
  await drain();
  const opened = events.find(({ payload }) => payload.kind === "attachment.opened")!;
  if (opened.payload.kind !== "attachment.opened") throw new Error("no attachment");
  const attachmentId = opened.payload.attachment.id;
  let clock = events.at(-1)!.occurredAt;
  const observe = (fields: Record<string, unknown>) =>
    engine.observe({
      id: randomUUID(),
      sessionId,
      occurredAt: ++clock,
      provenance: {
        source: { kind: "adapter", id: "pi", detail: { channel: "rpc" } },
        venue: { id: "local", kind: "local" },
      },
      attachmentId,
      ...fields,
    } as never);
  const question = (id: string, credential?: Record<string, unknown>) => ({
    id,
    attachmentId,
    kind: "question",
    title: "Which branch?",
    detail: null,
    options: [{ id: "main", label: "main", description: null }],
    multiple: false,
    ...(credential === undefined ? {} : { credential }),
    native: { id: `native-${id}`, detail: null },
  });
  // A turn asking an ordinary question and a credential request, both open.
  await observe({ kind: "turn.started", turnId: randomUUID() });
  await observe({ kind: "interaction.opened", interaction: question("question-1") });
  await observe({
    kind: "interaction.opened",
    interaction: question("credential-1", {
      id: "secret-request-1",
      name: "DEPLOY_TOKEN",
      sessionId,
      sessionLabel: "Intake",
      projectId: seeded.projectId,
      projectLabel: "Project",
      agentSays: null,
    }),
  });
  await drain();
  const send = (
    args: { commandId: string; intent: string; body?: string; artifact?: string },
    as = "alice",
  ) => asUser(t, as).mutation(api.sessions.command, { sessionId, ...args });
  const staged = () => t.run((ctx) => ctx.db.query("transcriptArtifacts").collect());
  /** An answer to one of the Session's questions, built as the renderer builds it. */
  const answer = (
    commandId: string,
    interactionId = "question-1",
    resolution: Parameters<typeof cloudInteractionResolve>[0]["resolution"] = {
      optionIds: ["main"],
      response: null,
    },
    attachment = attachmentId,
  ) =>
    cloudInteractionResolve({
      sessionId,
      commandId,
      attachmentId: attachment,
      interactionId,
      resolution,
    });
  return {
    t,
    alice: users.alice!,
    projectId: seeded.projectId,
    runner,
    sessionId,
    attachmentId,
    send,
    staged,
    answer,
    observe,
    drain,
  };
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
    const { send, staged, sessionId, answer } = await world();
    const commandId = randomUUID();
    const built = cloudMessageSubmit({ sessionId, commandId, message: message("hello") });
    const foreign = cloudMessageSubmit({
      sessionId,
      commandId: randomUUID(),
      message: message("hello"),
    });
    const other = cloudMessageSubmit({ sessionId, commandId, message: message("other") });
    const answered = answer(commandId);
    const forged = JSON.stringify({ ...JSON.parse(answered.intent), reference: built.reference });
    for (const args of [
      { intent: built.intent, body: foreign.body },
      { intent: built.intent, body: other.body },
      { intent: built.intent, body: "x".repeat(INLINE_ARTIFACT_MAX_BYTES + 1) },
      { intent: JSON.stringify({ kind: "session.archive" }), body: built.body },
      { intent: answered.intent, body: built.body },
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
    await expect(send({ commandId, intent: answered.intent })).resolves.toMatchObject({
      status: "queued",
    });
    expect(await staged()).toEqual([]);
  });
});

describe("sessionMessages.pending", () => {
  test("lists the owner's unanswered commands, waiting or ended with their reason, newest first", async () => {
    const { t, sessionId, send, answer: answerTo } = await world();
    const sent = randomUUID();
    const built = cloudMessageSubmit({ sessionId, commandId: sent, message: message("hello") });
    await send({ commandId: sent, intent: built.intent, body: built.body });
    const answered = randomUUID();
    const answer = answerTo(answered);
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

const CANARY = "canary-7f3a-not-for-storage";
const secretAnswer = {
  optionIds: [CANARY],
  response: CANARY,
  answers: [{ promptId: CANARY, optionIds: [CANARY], response: CANARY }],
};

/** Every row a refused answer could have reached, as text. */
async function stored(t: T): Promise<string> {
  return t.run(async (ctx) => {
    const rows: unknown[] = [
      ...(await ctx.db.query("runnerJobs").collect()),
      ...(await ctx.db.query("transcriptArtifacts").collect()),
      ...(await ctx.db.query("sessionEvents").collect()),
      ...(await ctx.db.query("sessionStates").collect()),
    ];
    return JSON.stringify(rows);
  });
}

describe("sessions.command with an interaction answer", () => {
  test("refuses a credential request, an unknown, settled or misattributed question before writing anything", async () => {
    const { t, send, answer } = await world();
    const jobs = () => t.run((ctx) => ctx.db.query("runnerJobs").collect());
    // Each answer is built for the id it is sent under, so its reference passes
    // the preflight and only the Session's fold can refuse it (each code below
    // comes from that check alone).
    for (const [interactionId, refusal, attachment] of [
      ["credential-1", "credential_required", undefined],
      ["no-such-question", "interaction_closed", undefined],
      // Settled in the written history: no longer open.
      ["interaction-0", "interaction_closed", undefined],
      // Open, but on another attachment than the one the answer names.
      ["question-1", "interaction_closed", randomUUID()],
    ] as const) {
      const commandId = randomUUID();
      const built = answer(commandId, interactionId, secretAnswer, attachment);
      const failure = send({ commandId, intent: built.intent });
      await expect(failure).rejects.toThrow(code(refusal));
      await failure.catch((error: unknown) => {
        expect(JSON.stringify(error)).not.toContain(CANARY);
        expect(String(error)).not.toContain(CANARY);
      });
    }
    expect(await jobs()).toEqual([]);
    expect(await stored(t)).not.toContain(CANARY);
  });

  test("fails closed while the fold is catching up or missing", async () => {
    const { t, send, answer } = await world();
    const state = await t.run((ctx) => ctx.db.query("sessionStates").first());
    await t.run((ctx) => ctx.db.patch(state!._id, { catchUpAt: Date.now() }));
    const commandId = randomUUID();
    await expect(send({ commandId, intent: answer(commandId).intent })).rejects.toThrow(
      code("not_ready"),
    );
    await t.run((ctx) => ctx.db.patch(state!._id, { catchUpAt: null }));
    const intake = await t.run((ctx) => ctx.db.query("sessionIntake").first());
    await t.run((ctx) =>
      ctx.db.patch(intake!._id, { acceptedThrough: intake!.acceptedThrough + 1 }),
    );
    await expect(send({ commandId, intent: answer(commandId).intent })).rejects.toThrow(
      code("not_ready"),
    );
    await t.run((ctx) => ctx.db.patch(intake!._id, { acceptedThrough: intake!.acceptedThrough }));
    await t.run((ctx) => ctx.db.delete(state!._id));
    await expect(send({ commandId, intent: answer(commandId).intent })).rejects.toThrow(
      code("not_ready"),
    );
    expect(await t.run((ctx) => ctx.db.query("runnerJobs").collect())).toEqual([]);
  });

  test("queues an open ordinary answer and replays it exactly after the card settles", async () => {
    const { t, send, answer, observe, drain } = await world();
    const commandId = randomUUID();
    const built = answer(commandId);
    const first = await send({ commandId, intent: built.intent });
    expect(first).toMatchObject({ commandId, status: "queued" });
    await observe({
      kind: "interaction.resolved",
      interactionId: "question-1",
      resolution: { optionIds: ["main"], response: null },
    });
    await drain();
    const before = await t.run((ctx) => ctx.db.query("runnerJobs").collect());
    // The exact replay is answered from its job; nothing new is written.
    await expect(send({ commandId, intent: built.intent })).resolves.toEqual(first);
    expect(await t.run((ctx) => ctx.db.query("runnerJobs").collect())).toEqual(before);
    // Another answer under the same id is the caller's conflict, and carries nothing in.
    await expect(
      send({ commandId, intent: answer(commandId, "question-1", secretAnswer).intent }),
    ).rejects.toThrow(code("id_taken"));
    // A new answer to the settled card is refused.
    const late = randomUUID();
    await expect(send({ commandId: late, intent: answer(late).intent })).rejects.toThrow(
      code("interaction_closed"),
    );
    expect(await stored(t)).not.toContain(CANARY);
  });
});

/** An agent's steer as its verb builds it: `artifact`, the message `<commandId>:message`. */
function agentSteer(commandId: string, text = "Owner direction: rebase first.") {
  const artifact = canonicalJson({
    version: 1,
    threadId: commandId,
    branchId: commandId,
    attemptId: commandId,
    turnId: null,
    message: { id: `${commandId}:message`, role: "user", parts: [{ type: "text", text }] },
  });
  const digest = `sha256:${createHash("sha256").update(artifact, "utf8").digest("hex")}`;
  return {
    artifact,
    digest,
    intent: JSON.stringify({
      kind: "message.submit",
      reference: { id: digest, digest, mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE },
    }),
  };
}

/** A Board Session of Alice's project on the same runner, and its Agent token's identity. */
async function boardAgent(w: Awaited<ReturnType<typeof world>>) {
  const { sessionId, events } = await writeSession({ projectId: w.projectId });
  for (const event of events) {
    await asRunner(w.t, w.runner).mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: [wire(event)],
    });
  }
  const as = w.t.withIdentity({
    issuer: AGENT_TOKEN_ISSUER,
    subject: agentSubject(sessionId as SessionId),
    own: w.alice,
    rnr: w.runner,
    gen: 1,
    tkt: null,
  });
  return {
    boardId: sessionId,
    send: (args: { commandId: string; intent: string; body?: string; artifact?: string }) =>
      as.mutation(api.sessions.command, { sessionId: w.sessionId, ...args }),
  };
}

const runnerRead = (w: Awaited<ReturnType<typeof world>>, digest: string) =>
  asRunner(w.t, w.runner).query(api.transcripts.commandArtifact, {
    sessionId: w.sessionId,
    generation: 1,
    digest,
  });

describe("a message body's two spellings", () => {
  test("refuses `body` and `artifact` together, whether they agree or not, writing nothing", async () => {
    const w = await world();
    const agent = await boardAgent(w);
    const commandId = randomUUID();
    const person = cloudMessageSubmit({
      sessionId: w.sessionId,
      commandId,
      message: message("hello"),
    });
    const steer = agentSteer(commandId);
    for (const extra of [
      { body: person.body, artifact: person.body },
      { body: person.body, artifact: steer.artifact },
    ]) {
      await expect(w.send({ commandId, intent: person.intent, ...extra })).rejects.toThrow(
        code("invalid_request"),
      );
    }
    for (const extra of [
      { body: steer.artifact, artifact: steer.artifact },
      { body: person.body, artifact: steer.artifact },
    ]) {
      await expect(agent.send({ commandId, intent: steer.intent, ...extra })).rejects.toThrow(
        code("invalid_request"),
      );
    }
    expect(await w.t.run((ctx) => ctx.db.query("runnerJobs").collect())).toEqual([]);
    expect(await w.staged()).toEqual([]);
  });

  test("an agent's message carries `artifact`, never `body`, under its composite operation id", async () => {
    const w = await world();
    const agent = await boardAgent(w);
    const operation = `${agent.boardId}:tool-call-1`;
    const steer = agentSteer(operation);
    const asPerson = cloudMessageSubmit({
      sessionId: w.sessionId,
      commandId: operation,
      message: message("hello"),
    });
    await expect(agent.send({ commandId: operation, intent: steer.intent })).rejects.toThrow(
      code("invalid_request"),
    );
    await expect(
      agent.send({ commandId: operation, intent: asPerson.intent, body: asPerson.body }),
    ).rejects.toThrow(code("invalid_request"));
    expect(await w.staged()).toEqual([]);
    const first = await agent.send({
      commandId: operation,
      intent: steer.intent,
      artifact: steer.artifact,
    });
    expect(first).toMatchObject({ commandId: operation, status: "queued" });
    await expect(
      agent.send({ commandId: operation, intent: steer.intent, artifact: steer.artifact }),
    ).resolves.toEqual(first);
    // The one runner read hydrates it by digest; the operation id never reaches it.
    await expect(runnerRead(w, steer.digest)).resolves.toEqual({
      digest: steer.digest,
      mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
      body: steer.artifact,
    });
  });

  test("both spellings stage through one rule: the runner's read, repair and idempotency", async () => {
    const w = await world();
    const agent = await boardAgent(w);
    const personId = randomUUID();
    const person = cloudMessageSubmit({
      sessionId: w.sessionId,
      commandId: personId,
      message: message("hello"),
    });
    const agentId = randomUUID();
    const steer = agentSteer(agentId);
    // A corrupt inline row already sits under each body's digest.
    await w.t.run(async (ctx) => {
      for (const digest of [person.reference.digest!, steer.digest]) {
        await ctx.db.insert("transcriptArtifacts", {
          sessionId: w.sessionId,
          digest,
          mediaType: "application/json",
          bytes: 7,
          body: "corrupt",
          spillKey: null,
          firstSequence: null,
          uploadedBy: "runner",
          packedSegmentId: null,
          expiresAt: null,
          createdAt: 1,
        });
      }
    });
    await w.send({ commandId: personId, intent: person.intent, body: person.body });
    await agent.send({ commandId: agentId, intent: steer.intent, artifact: steer.artifact });
    const rows = await w.staged();
    expect(rows.map(({ digest, body, mediaType }) => ({ digest, body, mediaType }))).toEqual(
      expect.arrayContaining([
        {
          digest: person.reference.digest,
          body: person.body,
          mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
        },
        { digest: steer.digest, body: steer.artifact, mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE },
      ]),
    );
    expect(rows).toHaveLength(2);
    await expect(runnerRead(w, person.reference.digest!)).resolves.toMatchObject({
      body: person.body,
    });
    await expect(runnerRead(w, steer.digest)).resolves.toMatchObject({ body: steer.artifact });
    // Replays stage nothing new.
    await w.send({ commandId: personId, intent: person.intent, body: person.body });
    await agent.send({ commandId: agentId, intent: steer.intent, artifact: steer.artifact });
    expect(await w.staged()).toEqual(rows);
  });
});
