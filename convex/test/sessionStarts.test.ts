import { randomUUID } from "node:crypto";

import { convexTest } from "convex-test";
import { describe, expect, test } from "vite-plus/test";

import { cloudMessageSubmit, readCloudMessageBody, type CloudUiMessage } from "@volli/shared";
import {
  RUNNER_TOKEN_ISSUER,
  SESSION_START_FORMAT,
  type SessionStartJobPayload,
  type UserId,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { seedTestRunner, seedTestWorld } from "../functions/lib/testWorld";
import schema from "../functions/schema";
import { enrollPreview } from "./preview-fixtures";
import { wire, writeSession } from "./sessionFixtures";

const modules = import.meta.glob("../functions/**/*.ts");
const ISSUER = "https://issuer.test";

type T = ReturnType<typeof convexTest>;

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

async function signIn(t: T, name: string): Promise<UserId> {
  const result = await t
    .withIdentity({ subject: `user:${name}`, issuer: ISSUER })
    .mutation(api.accounts.ensureViewer, {});
  await enrollPreview(t, result.userId);
  return result.userId as UserId;
}

const asUser = (t: T, name: string) => t.withIdentity({ subject: `user:${name}`, issuer: ISSUER });
const asRunner = (t: T, runnerId: string) =>
  t.withIdentity({ subject: `runner:${runnerId}`, issuer: RUNNER_TOKEN_ISSUER });

const MESSAGE: CloudUiMessage = {
  id: "message-1",
  role: "user",
  parts: [{ type: "text", text: "Fix the flaky upload test\nIt fails on CI." }],
};

/** Alice owns the world and two runners (A, her Mac; B, her Linux box); Bob is a teammate with his own. */
async function world() {
  const t = convexTest(schema, modules);
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const seeded = await t.run((ctx) =>
    seedTestWorld(ctx, { ownerUserId: alice, memberUserIds: [bob], runners: 2 }),
  );
  const bobRunner = await t.run((ctx) => seedTestRunner(ctx, bob, "bob-mac"));
  return {
    t,
    alice,
    bob,
    bobRunner,
    ...seeded,
    runnerA: seeded.runnerIds[0]!,
    runnerB: seeded.runnerIds[1]!,
  };
}

type World = Awaited<ReturnType<typeof world>>;

function startOn(
  w: World,
  overrides: Partial<{
    clientRequestId: string;
    runnerId: string;
    projectId: string;
    ticketId: string | null;
    body: string;
    model: SessionStartJobPayload["model"];
  }> = {},
  as = "alice",
) {
  return asUser(w.t, as).mutation(api.sessionStarts.startOn, {
    clientRequestId: randomUUID(),
    runnerId: w.runnerB,
    projectId: w.projectId,
    ticketId: w.ticketId,
    body: JSON.stringify(MESSAGE),
    model: { providerId: "anthropic", modelId: "claude", reasoningLevel: "high" },
    ...overrides,
  });
}

async function patchRunner(w: World, runnerId: string, patch: Record<string, unknown>) {
  await w.t.run(async (ctx) => {
    const row = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", runnerId))
      .unique();
    await ctx.db.patch(row!._id, patch);
  });
}

async function jobOf(w: World, id: string) {
  return w.t.run((ctx) =>
    ctx.db
      .query("runnerJobs")
      .withIndex("by_uuid", (q) => q.eq("id", id))
      .unique(),
  );
}

async function claim(w: World, runnerId: string, bootId = randomUUID()) {
  const claimed = await asRunner(w.t, runnerId).mutation(api.runnerJobs.claim, { bootId });
  return { bootId, claimed };
}

describe("sessionStarts.startOn", () => {
  test("queues a session.start for the caller's runner, with the minted Session and its staged first message", async () => {
    const w = await world();
    const clientRequestId = randomUUID();
    const { sessionId } = await startOn(w, { clientRequestId });

    const job = await jobOf(w, clientRequestId);
    expect(job).toMatchObject({
      kind: "session.start",
      runnerId: w.runnerB,
      projectId: w.projectId,
      ticketId: w.ticketId,
      sessionId,
      commandId: clientRequestId,
      status: "queued",
      createdBy: { kind: "person", userId: w.alice },
    });
    const staged = cloudMessageSubmit({ sessionId, commandId: clientRequestId, message: MESSAGE });
    expect(job!.payload).toEqual({
      format: SESSION_START_FORMAT,
      projectId: w.projectId,
      ticketId: w.ticketId,
      title: "Fix the flaky upload test",
      firstMessage: { commandId: clientRequestId, body: staged.reference },
      model: { providerId: "anthropic", modelId: "claude", reasoningLevel: "high" },
    });
    // The body is the one a runner writes for this Session and command, staged once.
    const rows = await w.t.run((ctx) =>
      ctx.db
        .query("transcriptArtifacts")
        .withIndex("by_session_digest", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ digest: staged.reference.digest, uploadedBy: "client" });
    expect(
      readCloudMessageBody({
        sessionId,
        commandId: clientRequestId,
        reference: staged.reference,
        body: rows[0]!.body!,
      }).message,
    ).toEqual(MESSAGE);
    // Nothing about the Session exists until a runner's first fact claims it.
    expect(
      await w.t.run((ctx) =>
        ctx.db
          .query("sessions")
          .withIndex("by_uuid", (q) => q.eq("id", sessionId))
          .unique(),
      ),
    ).toBeNull();
  });

  test("is idempotent by clientRequestId; another request under the same id is id_taken", async () => {
    const w = await world();
    const clientRequestId = randomUUID();
    const first = await startOn(w, { clientRequestId });
    expect(await startOn(w, { clientRequestId })).toEqual(first);
    const jobs = await w.t.run((ctx) => ctx.db.query("runnerJobs").collect());
    expect(jobs).toHaveLength(1);
    const artifacts = await w.t.run((ctx) => ctx.db.query("transcriptArtifacts").collect());
    expect(artifacts).toHaveLength(1);

    const other = { ...MESSAGE, parts: [{ type: "text", text: "Something else" }] };
    for (const overrides of [
      { body: JSON.stringify(other) },
      { ticketId: null },
      { model: null },
      { model: { providerId: "anthropic", modelId: "claude", reasoningLevel: "low" as const } },
    ]) {
      await expect(startOn(w, { clientRequestId, ...overrides })).rejects.toThrow(code("id_taken"));
    }
    // A replay answers its Session whatever changed since: it is the same start.
    await patchRunner(w, w.runnerB, { status: "revoked", revokedAt: 1 });
    await w.t.run(async (ctx) => {
      const ticket = await ctx.db.query("tickets").first();
      await ctx.db.patch(ticket!._id, { archivedAt: 1 });
    });
    expect(await startOn(w, { clientRequestId })).toEqual(first);
    // The runner is not compared: a replaced Mac's successor holds its queued work.
    expect(await startOn(w, { clientRequestId, runnerId: w.runnerA })).toEqual(first);
    await expect(startOn(w, { clientRequestId, body: "{" })).rejects.toThrow(
      code("invalid_request"),
    );
    // Bob cannot learn of, or replay, Alice's request.
    await expect(startOn(w, { clientRequestId, runnerId: w.bobRunner }, "bob")).rejects.toThrow(
      code("id_taken"),
    );
  });

  test("starts only on the caller's own runners", async () => {
    const w = await world();
    await expect(startOn(w, { runnerId: w.bobRunner })).rejects.toThrow(code("not_found"));
    await expect(startOn(w, { runnerId: w.runnerB }, "bob")).rejects.toThrow(code("not_found"));
    await expect(startOn(w, { runnerId: "not-a-uuid" })).rejects.toThrow(code("not_found"));
    await expect(startOn(w, { runnerId: randomUUID() })).rejects.toThrow(code("not_found"));
    expect(await w.t.run((ctx) => ctx.db.query("runnerJobs").collect())).toEqual([]);
  });

  test("queues for an asleep or offline runner; refuses a cut-off one and one that cannot start Sessions", async () => {
    const w = await world();
    await patchRunner(w, w.runnerB, { status: "asleep", statusChangedAt: 5 });
    const { sessionId } = await startOn(w);
    expect(await asUser(w.t, "alice").query(api.sessionStarts.status, { sessionId })).toEqual({
      sessionId,
      state: "queued",
      runner: {
        id: w.runnerB,
        name: "runner-1",
        kind: "mac",
        status: "asleep",
        statusChangedAt: 5,
      },
      failure: null,
    });
    await patchRunner(w, w.runnerB, { status: "offline" });
    await expect(startOn(w)).resolves.toMatchObject({ sessionId: expect.any(String) });

    await patchRunner(w, w.runnerB, { capabilities: { tools: ["automation.run"] } });
    await expect(startOn(w)).rejects.toThrow(code("runner_needs_update"));
    await patchRunner(w, w.runnerB, {
      capabilities: { tools: ["automation.run", "session.start"] },
    });
    await expect(startOn(w)).resolves.toMatchObject({ sessionId: expect.any(String) });

    await patchRunner(w, w.runnerB, { status: "revoked", revokedAt: 10 });
    await expect(startOn(w)).rejects.toThrow(code("runner_unavailable"));
  });

  test("checks the project, the ticket, the message and the model", async () => {
    const w = await world();
    const carol = await signIn(w.t, "carol");
    const carolRunner = await w.t.run((ctx) => seedTestRunner(ctx, carol, "carol-mac"));
    await expect(startOn(w, { runnerId: carolRunner }, "carol")).rejects.toThrow(
      code("not_a_member"),
    );
    await expect(startOn(w, { projectId: randomUUID() })).rejects.toThrow(code("not_found"));
    await expect(startOn(w, { clientRequestId: "request-1" })).rejects.toThrow(
      code("invalid_request"),
    );
    await expect(startOn(w, { ticketId: randomUUID() })).rejects.toThrow(code("not_found"));
    await expect(startOn(w, { ticketId: "T-1" })).rejects.toThrow(code("not_found"));
    await w.t.run(async (ctx) => {
      const ticket = await ctx.db.query("tickets").first();
      await ctx.db.patch(ticket!._id, { archivedAt: 1 });
    });
    await expect(startOn(w)).rejects.toThrow(code("ticket_archived"));
    await w.t.run(async (ctx) => {
      const ticket = await ctx.db.query("tickets").first();
      await ctx.db.patch(ticket!._id, { deletedAt: 2 });
    });
    await expect(startOn(w)).rejects.toThrow(code("not_found"));

    for (const body of [
      "{",
      "[]",
      "null",
      JSON.stringify({ ...MESSAGE, role: "assistant" }),
      JSON.stringify({ ...MESSAGE, parts: "text" }),
      JSON.stringify({ ...MESSAGE, parts: [{ type: "text", text: "x".repeat(70_000) }] }),
    ]) {
      await expect(startOn(w, { ticketId: null, body })).rejects.toThrow(code("invalid_request"));
    }
    await expect(
      startOn(w, {
        ticketId: null,
        model: { providerId: "anthropic", modelId: "claude", reasoningLevel: "max-plus" as never },
      }),
    ).rejects.toThrow(code("invalid_request"));
    // A Board Session on the runner's default model, titled from its message (or not at all).
    const board = await startOn(w, {
      ticketId: null,
      model: null,
      body: JSON.stringify({ ...MESSAGE, parts: [{ type: "file", url: "x" }] }),
    });
    const job = await w.t.run((ctx) =>
      ctx.db
        .query("runnerJobs")
        .withIndex("by_session", (q) => q.eq("sessionId", board.sessionId))
        .first(),
    );
    expect(job!.payload).toMatchObject({ ticketId: null, title: null, model: null });
  });
});

describe("sessionStarts.startContext", () => {
  test("answers the runner holding the current lease, with the staged body and its own name", async () => {
    const w = await world();
    const clientRequestId = randomUUID();
    const { sessionId } = await startOn(w, { clientRequestId });
    const { bootId, claimed } = await claim(w, w.runnerB);
    expect(claimed.map(({ job }) => job.id)).toEqual([clientRequestId]);
    const lease = { jobId: clientRequestId, bootId, attempt: 1 };
    const staged = cloudMessageSubmit({ sessionId, commandId: clientRequestId, message: MESSAGE });

    expect(await asRunner(w.t, w.runnerB).query(api.sessionStarts.startContext, lease)).toEqual({
      kind: "ready",
      projectId: w.projectId,
      ticket: { id: w.ticketId, live: true },
      runnerName: "runner-1",
      body: staged.body,
    });
    // Another lease, another runner, another kind of job, or no job: lease_lost.
    for (const [runner, args] of [
      [w.runnerB, { ...lease, bootId: randomUUID() }],
      [w.runnerB, { ...lease, attempt: 2 }],
      [w.runnerA, lease],
      [w.runnerB, { ...lease, jobId: randomUUID() }],
      [w.runnerB, { ...lease, jobId: "not-a-job" }],
    ] as const) {
      expect(await asRunner(w.t, runner).query(api.sessionStarts.startContext, args)).toEqual({
        kind: "unavailable",
        reason: "lease_lost",
      });
    }
    await expect(asUser(w.t, "alice").query(api.sessionStarts.startContext, lease)).rejects.toThrow(
      code("not_a_runner"),
    );

    // The ticket as it is now, and nothing staged once the body is gone.
    await w.t.run(async (ctx) => {
      const ticket = await ctx.db.query("tickets").first();
      await ctx.db.patch(ticket!._id, { archivedAt: 1 });
      for (const row of await ctx.db.query("transcriptArtifacts").collect())
        await ctx.db.delete(row._id);
    });
    expect(
      await asRunner(w.t, w.runnerB).query(api.sessionStarts.startContext, lease),
    ).toMatchObject({ kind: "ready", ticket: { id: w.ticketId, live: false }, body: null });
    await w.t.run(async (ctx) => {
      const ticket = await ctx.db.query("tickets").first();
      await ctx.db.delete(ticket!._id);
    });
    expect(
      await asRunner(w.t, w.runnerB).query(api.sessionStarts.startContext, lease),
    ).toMatchObject({ ticket: { live: false } });

    // An owner who left the project's Workspace may no longer work in it.
    await w.t.run(async (ctx) => {
      const project = await ctx.db.query("projects").first();
      await ctx.db.patch(project!._id, { deletedAt: 3 });
    });
    expect(await asRunner(w.t, w.runnerB).query(api.sessionStarts.startContext, lease)).toEqual({
      kind: "unavailable",
      reason: "project_unavailable",
    });
  });

  test("a Board Session reads no ticket, and a payload it cannot read reads lease_lost", async () => {
    const w = await world();
    const clientRequestId = randomUUID();
    await startOn(w, { clientRequestId, ticketId: null });
    const { bootId } = await claim(w, w.runnerB);
    const lease = { jobId: clientRequestId, bootId, attempt: 1 };
    expect(
      await asRunner(w.t, w.runnerB).query(api.sessionStarts.startContext, lease),
    ).toMatchObject({ kind: "ready", ticket: null });
    await w.t.run(async (ctx) => {
      const job = await ctx.db.query("runnerJobs").first();
      await ctx.db.patch(job!._id, { payload: { format: "unknown" } });
    });
    expect(await asRunner(w.t, w.runnerB).query(api.sessionStarts.startContext, lease)).toEqual({
      kind: "unavailable",
      reason: "lease_lost",
    });
  });
});

describe("a start on another of the person's runners", () => {
  test("runner B is born the Session's claimant, and a later command from any device reaches B", async () => {
    const w = await world();
    const clientRequestId = randomUUID();
    const { sessionId } = await startOn(w, { clientRequestId });
    const status = () => asUser(w.t, "alice").query(api.sessionStarts.status, { sessionId });

    // B claims the start, mints the Session and drains its first facts.
    const { bootId } = await claim(w, w.runnerB);
    expect(await status()).toMatchObject({ state: "starting" });
    const { events } = await writeSession({
      sessionId,
      projectId: w.projectId,
      ticketId: w.ticketId,
    });
    await asRunner(w.t, w.runnerB).mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: events.map(wire),
    });
    await asRunner(w.t, w.runnerB).mutation(api.runnerJobs.complete, {
      jobId: clientRequestId,
      bootId,
      attempt: 1,
      outcome: {
        status: "done",
        result: {
          kind: "started",
          sessionId,
          model: { providerId: "anthropic", modelId: "claude", reasoningLevel: "high" },
        },
      },
    });
    expect(await status()).toMatchObject({ state: "started", failure: null });
    const rows = await w.t.run(async (ctx) => ({
      session: await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", sessionId))
        .unique(),
      intake: await ctx.db
        .query("sessionIntake")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique(),
    }));
    expect(rows.session).toMatchObject({ ownerUserId: w.alice, placeRunnerId: w.runnerB });
    expect(rows.intake).toMatchObject({ claim: { runnerId: w.runnerB, generation: 1 } });

    // Alice, on her Mac (runner A), sends a follow-up: it is queued for B.
    const commandId = randomUUID();
    const next = cloudMessageSubmit({
      sessionId,
      commandId,
      message: { id: "message-2", role: "user", parts: [{ type: "text", text: "Also lint" }] },
    });
    const sent = await asUser(w.t, "alice").mutation(api.sessions.command, {
      sessionId,
      commandId,
      intent: next.intent,
      body: next.body,
    });
    expect(sent).toMatchObject({ status: "queued", runner: { id: w.runnerB } });
    expect(await jobOf(w, commandId)).toMatchObject({
      kind: "session.command",
      runnerId: w.runnerB,
    });
    const { claimed } = await claim(w, w.runnerB);
    expect(claimed.map(({ job }) => job.id)).toEqual([commandId]);
    expect(
      await asRunner(w.t, w.runnerB).query(api.transcripts.commandArtifact, {
        sessionId,
        generation: 1,
        digest: next.reference.digest!,
      }),
    ).toMatchObject({ body: next.body });
    // Runner A never sees either job.
    expect((await claim(w, w.runnerA)).claimed).toEqual([]);
  });

  test("a refusal reads as a failed start, with the runner's words", async () => {
    const w = await world();
    const clientRequestId = randomUUID();
    const { sessionId } = await startOn(w, { clientRequestId });
    const { bootId } = await claim(w, w.runnerB);
    await asRunner(w.t, w.runnerB).mutation(api.runnerJobs.complete, {
      jobId: clientRequestId,
      bootId,
      attempt: 1,
      outcome: {
        status: "failed",
        code: "model_unavailable",
        detail: "anthropic isn't signed in on runner-1 — run `volli-runner login anthropic`.",
        retryable: false,
      },
    });
    expect(await asUser(w.t, "alice").query(api.sessionStarts.status, { sessionId })).toEqual({
      sessionId,
      state: "failed",
      runner: expect.objectContaining({ id: w.runnerB }),
      failure: {
        code: "model_unavailable",
        detail: "anthropic isn't signed in on runner-1 — run `volli-runner login anthropic`.",
      },
    });
    // Only the person who asked reads it.
    expect(await asUser(w.t, "bob").query(api.sessionStarts.status, { sessionId })).toBeNull();
    expect(
      await asUser(w.t, "alice").query(api.sessionStarts.status, { sessionId: randomUUID() }),
    ).toBeNull();
    expect(
      await asUser(w.t, "alice").query(api.sessionStarts.status, { sessionId: "nope" }),
    ).toBeNull();
    // A cancelled start says so, and a runner gone from the record reads as none.
    await w.t.run(async (ctx) => {
      const job = await ctx.db.query("runnerJobs").first();
      await ctx.db.patch(job!._id, { status: "cancelled", failure: null });
      const runner = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", w.runnerB))
        .unique();
      await ctx.db.delete(runner!._id);
    });
    expect(await asUser(w.t, "alice").query(api.sessionStarts.status, { sessionId })).toEqual({
      sessionId,
      state: "failed",
      runner: null,
      failure: { code: "cancelled", detail: null },
    });
  });
});

describe("a start's loose ends", () => {
  test("a start waiting on a runner since cut off reads failed, and a retry keeps its reason", async () => {
    const w = await world();
    const { sessionId } = await startOn(w);
    const status = () => asUser(w.t, "alice").query(api.sessionStarts.status, { sessionId });
    const { bootId } = await claim(w, w.runnerB);
    const job = (await w.t.run((ctx) => ctx.db.query("runnerJobs").first()))!;
    await asRunner(w.t, w.runnerB).mutation(api.runnerJobs.complete, {
      jobId: job.id,
      bootId,
      attempt: 1,
      outcome: {
        status: "failed",
        code: "runtime_unavailable",
        detail: "Not ready.",
        retryable: true,
      },
    });
    expect(await status()).toMatchObject({
      state: "queued",
      failure: { code: "runtime_unavailable", detail: "Not ready." },
    });
    await patchRunner(w, w.runnerB, { status: "revoked", revokedAt: 1 });
    expect(await status()).toMatchObject({
      state: "failed",
      runner: { id: w.runnerB, status: "revoked" },
      failure: { code: "runner_unavailable" },
    });
  });

  test("the sweep drops the first message of a start whose Session was never born, and only that", async () => {
    const w = await world();
    const unborn = await startOn(w);
    const born = await startOn(w);
    // The second start's Session was born on B; then both jobs finished long ago.
    const { events } = await writeSession({
      sessionId: born.sessionId,
      projectId: w.projectId,
      ticketId: w.ticketId,
    });
    await asRunner(w.t, w.runnerB).mutation(api.sessions.accept, {
      sessionId: born.sessionId,
      generation: 1,
      events: events.map(wire),
    });
    await w.t.run(async (ctx) => {
      for (const job of await ctx.db.query("runnerJobs").collect())
        if (job.kind === "session.start")
          await ctx.db.patch(job._id, { status: "failed", completedAt: 1, expiresAt: 1 });
    });
    await w.t.mutation(internal.runnerJobs.sweep, {});
    const left = await w.t.run((ctx) => ctx.db.query("transcriptArtifacts").collect());
    expect(left.map((row) => row.sessionId)).toEqual([born.sessionId]);
    expect(
      (await w.t.run((ctx) => ctx.db.query("runnerJobs").collect())).filter(
        (job) => job.kind === "session.start",
      ),
    ).toEqual([]);
    expect(unborn.sessionId).not.toBe(born.sessionId);
  });
});

describe("runnerPicker.forComposer", () => {
  test("lists the caller's live runners with power, providers and update state, and the default", async () => {
    const w = await world();
    const linux = await w.t.run((ctx) => seedTestRunner(ctx, w.alice, "hetzner-1"));
    await patchRunner(w, linux, {
      kind: "linux",
      statusChangedAt: 50,
      version: "0.3.1",
      capabilities: { power: { source: "ac", alwaysOn: true } },
    });
    await patchRunner(w, w.runnerA, { status: "upgrade_required" });
    await patchRunner(w, w.runnerB, { status: "revoked", revokedAt: 1 });
    await w.t.run(async (ctx) => {
      for (const providerId of ["openai", "anthropic", "anthropic"])
        await ctx.db.insert("runnerLocalCredentials", {
          runnerId: linux,
          providerId,
          kind: "api_key",
          expiresAt: null,
        });
    });
    const answer = await asUser(w.t, "alice").query(api.runnerPicker.forComposer, {
      projectId: w.projectId,
    });
    expect(answer.defaultRunnerId).toBe(linux);
    expect(answer.runners.map((runner) => runner.name)).toEqual(["hetzner-1", "runner-0"]);
    expect(answer.runners[0]).toEqual({
      id: linux,
      name: "hetzner-1",
      kind: "linux",
      status: "online",
      statusChangedAt: 50,
      power: { source: "ac", alwaysOn: true },
      providers: ["anthropic", "openai"],
      version: "0.3.1",
      upgradeRequired: false,
    });
    expect(answer.runners[1]).toMatchObject({
      id: w.runnerA,
      power: { source: "unknown", alwaysOn: false },
      providers: [],
      upgradeRequired: true,
    });

    // Bob sees only his own; nobody plugged in and always on is no default.
    const bobs = await asUser(w.t, "bob").query(api.runnerPicker.forComposer, {
      projectId: w.projectId,
    });
    expect(bobs).toEqual({
      runners: [expect.objectContaining({ id: w.bobRunner, name: "bob-mac" })],
      defaultRunnerId: null,
    });
    await signIn(w.t, "carol");
    await expect(
      asUser(w.t, "carol").query(api.runnerPicker.forComposer, { projectId: w.projectId }),
    ).rejects.toThrow(code("not_a_member"));
  });
});
