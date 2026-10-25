import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, TRANSCRIPT_ARTIFACT_MEDIA_TYPE } from "@volli/session-engine";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  AGENT_TOKEN_ISSUER,
  RUNNER_TOKEN_ISSUER,
  newId,
  parseJobPayload,
} from "@volli/shared/cloud";
import type { SessionEvent } from "@volli/shared";
import { api, internal } from "../functions/_generated/api";
import { onSessionFact } from "../functions/lib/watches";
import {
  boardFixture,
  code,
  createTicket,
  seedSession,
  setup,
  signIn,
  type Tester,
} from "./board-helpers";
import { moreTurns, wire, writeSession } from "./sessionFixtures";

const asRunner = (t: Tester, id: string) =>
  t.withIdentity({ issuer: RUNNER_TOKEN_ISSUER, subject: `runner:${id}` });
const agent = (t: Tester, sessionId: string, own: string, rnr: string) =>
  t.withIdentity({ issuer: AGENT_TOKEN_ISSUER, subject: `agent:${sessionId}`, own, rnr, gen: 1 });
const accept = (t: Tester, runner: string, sessionId: string, events: SessionEvent[]) =>
  asRunner(t, runner).mutation(api.sessions.accept, {
    sessionId,
    generation: 1,
    events: events.map(wire),
  });
const notices = (t: Tester, sid: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("runnerJobs")
        .withIndex("by_session", (q) => q.eq("sessionId", sid))
        .collect()
    ).filter((j) => j.kind === "session.notice"),
  );
const watchRows = (t: Tester, sid: string) =>
  t.run((ctx) =>
    ctx.db
      .query("watches")
      .withIndex("by_watcher", (q) => q.eq("watcherSessionId", sid))
      .collect(),
  );

async function world(boardCaller = false) {
  const t = setup();
  const alice = await boardFixture(t);
  const ticket = await createTicket(alice.as, alice.projectId);
  const watcher = await seedSession(
    t,
    { projectId: alice.projectId, ticketId: ticket.ticketId },
    alice.userId,
  );
  if (boardCaller)
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", watcher.sessionId))
        .unique();
      await ctx.db.patch(row!._id, {
        role: "project",
        ticketId: null,
        visibility: "private",
        visibilityReason: "adhoc",
      });
    });
  const target = await writeSession({ projectId: alice.projectId, ticketId: ticket.ticketId });
  const turnEnd = target.events.findIndex((e) => e.payload.kind === "turn.completed");
  await accept(t, watcher.runnerId, target.sessionId, target.events.slice(0, turnEnd));
  const as = agent(t, watcher.sessionId, alice.userId, watcher.runnerId);
  const arm = (
    commandId = newId("command"),
    id = target.sessionId,
    kind: "session" | "ticket" = "session",
  ) =>
    as.mutation(api.watches.watch, {
      watcherSessionId: watcher.sessionId,
      target: { kind, id },
      commandId,
    });
  return { t, ...alice, person: alice.as, ticket, watcher, target, turnEnd, as, arm };
}

function steerArgs(commandId: string) {
  const artifact = canonicalJson({
    version: 1,
    threadId: commandId,
    branchId: commandId,
    attemptId: commandId,
    turnId: null,
    message: {
      id: `${commandId}:message`,
      role: "user",
      parts: [{ type: "text", text: "Steer from the watcher" }],
    },
  });
  const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
  return {
    artifact,
    intent: JSON.stringify({
      kind: "message.submit",
      reference: { id: digest, digest, mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE },
    }),
  };
}

afterEach(() => vi.useRealTimers());

describe("durable watches", () => {
  test("retired awaits keep a replay-safe subset of watch kinds", async () => {
    const w = await world();
    const args = {
      watcherSessionId: w.watcher.sessionId,
      target: { kind: "session" as const, id: w.target.sessionId },
      commandId: `${w.watcher.sessionId}:retired-await`,
      kinds: ["verdict"],
    };
    const first = await w.as.mutation(api.watches.watch, args);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.kinds).toEqual(["verdict"]);
    expect(await w.as.mutation(api.watches.watch, args)).toEqual(first);
    await expect(
      w.as.mutation(api.watches.watch, { ...args, kinds: ["turn"] }),
    ).rejects.toMatchObject({ data: { code: "id_taken" } });
    await expect(
      w.as.mutation(api.watches.watch, {
        ...args,
        commandId: newId("command"),
        kinds: ["comment"],
      }),
    ).rejects.toMatchObject({ data: { code: "invalid_request" } });
    await accept(
      w.t,
      w.watcher.runnerId,
      w.target.sessionId,
      w.target.events.slice(w.turnEnd, w.turnEnd + 1),
    );
    expect(await notices(w.t, w.watcher.sessionId)).toHaveLength(0);
  });
  test("arm retries do not re-arm a fired turn; new commands do, and unwatch ends intent", async () => {
    const w = await world();
    const commandId = newId("command");
    const first = await w.arm(commandId);
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, w.target.events.slice(w.turnEnd));
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(false);
    expect(await w.arm(commandId)).toEqual(first);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(false);
    await w.arm();
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(true);
    await expect(w.arm(commandId, w.ticket.ticketId, "ticket")).rejects.toMatchObject(
      code("id_taken"),
    );
    expect(
      await w.as.query(api.watches.list, { watcherSessionId: w.watcher.sessionId }),
    ).toHaveLength(1);
    expect(
      await w.as.mutation(api.watches.unwatch, { watcherSessionId: w.watcher.sessionId }),
    ).toEqual({ ended: 1 });
    expect(await w.as.query(api.watches.list, { watcherSessionId: w.watcher.sessionId })).toEqual(
      [],
    );
    await w.arm(commandId);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.endedReason).toBe("unwatched");
  });

  test("requires watcher-scoped Agent identity, hides private targets and refuses ended work", async () => {
    const w = await world();
    const args = {
      watcherSessionId: w.watcher.sessionId,
      target: { kind: "session" as const, id: w.target.sessionId },
      commandId: newId("command"),
    };
    await expect(
      w.as.mutation(api.watches.watch, { ...args, watcherSessionId: w.target.sessionId }),
    ).rejects.toMatchObject(code("forbidden"));
    await expect(
      w.as.mutation(api.watches.watch, {
        ...args,
        target: { kind: "session", id: w.watcher.sessionId },
      }),
    ).rejects.toMatchObject(code("self_watch"));
    await expect(
      w.as.mutation(api.watches.watch, { ...args, target: { kind: "session", id: randomUUID() } }),
    ).rejects.toMatchObject(code("not_found"));
    await expect(
      w.as.mutation(api.watches.watch, { ...args, target: { kind: "ticket", id: randomUUID() } }),
    ).rejects.toMatchObject(code("not_found"));
    await expect(
      w.as.mutation(api.watches.watch, { ...args, target: { kind: "session", id: "bad" } }),
    ).rejects.toThrow();
    await expect(
      w.as.query(api.watches.list, { watcherSessionId: w.target.sessionId }),
    ).rejects.toMatchObject(code("forbidden"));
    await expect(
      w.as.mutation(api.watches.watch, { ...args, commandId: "" }),
    ).rejects.toMatchObject(code("invalid_request"));
    await expect(w.as.mutation(api.watches.watch, args)).resolves.toBeTruthy();
    await expect(w.person.mutation(api.watches.watch, args)).rejects.toMatchObject(
      code("forbidden"),
    );
    await expect(
      asRunner(w.t, w.watcher.runnerId).mutation(api.watches.watch, args),
    ).rejects.toMatchObject(code("not_a_person"));
    const bob = await signIn(w.t, "bob");
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.target.sessionId))
        .unique();
      await ctx.db.patch(row!._id, { ownerUserId: bob.userId, visibility: "private" });
    });
    await expect(w.arm()).rejects.toMatchObject(code("not_found"));
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.target.sessionId))
        .unique();
      await ctx.db.patch(row!._id, {
        ownerUserId: w.userId,
        visibility: "shared",
        stopped: { at: 1, reason: null },
      });
    });
    await expect(w.arm()).rejects.toMatchObject(code("target_stopped"));
  });

  test("coalesces Session facts and board changes until claim, then starts a new job", async () => {
    const w = await world();
    await w.arm();
    await w.arm(newId("command"), w.ticket.ticketId, "ticket");
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, w.target.events.slice(w.turnEnd));
    await w.as.mutation(api.board.createComment, {
      commandId: newId("command"),
      ticketId: w.ticket.ticketId,
      commentId: newId("comment"),
      body: "own comment",
    });
    let jobs = await notices(w.t, w.watcher.sessionId);
    expect(jobs).toHaveLength(1);
    let payload = parseJobPayload("session.notice", jobs[0]!.payload);
    expect(payload.notice).toBe("watch");
    if (payload.notice !== "watch") throw new Error("not watch");
    expect(payload.changes).toHaveLength(2);
    await w.as.mutation(api.board.createComment, {
      commandId: newId("command"),
      ticketId: w.ticket.ticketId,
      commentId: newId("comment"),
      body: "own comment again",
    });
    await w.person.mutation(api.board.createComment, {
      commandId: newId("command"),
      ticketId: w.ticket.ticketId,
      commentId: newId("comment"),
      body: "other author",
    });
    jobs = await notices(w.t, w.watcher.sessionId);
    payload = parseJobPayload("session.notice", jobs[0]!.payload);
    expect(payload.notice === "watch" && payload.changes.length).toBe(3);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2_000);
    const claimed = await asRunner(w.t, w.watcher.runnerId).mutation(api.runnerJobs.claim, {
      bootId: randomUUID(),
    });
    expect(claimed.filter((j) => j.job.kind === "session.notice")).toHaveLength(1);
    await w.person.mutation(api.board.createComment, {
      commandId: newId("command"),
      ticketId: w.ticket.ticketId,
      commentId: newId("comment"),
      body: "after claim",
    });
    expect(await notices(w.t, w.watcher.sessionId)).toHaveLength(2);
  });
  test("completed turns defer for running children; interrupted turns still fire", async () => {
    const w = await world();
    await w.arm();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("delegations", {
        childSessionId: randomUUID(),
        parentSessionId: w.target.sessionId,
        ticketId: w.ticket.ticketId,
        depth: 1,
        toolCallId: "tool",
        createCommandId: "create",
        status: "running",
        answerRef: null,
        createdAt: 0,
        settledAt: null,
      });
    });
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, [w.target.events[w.turnEnd]!]);
    expect(await notices(w.t, w.watcher.sessionId)).toHaveLength(0);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(true);
    await fire(w, { kind: "turn.interrupted", attachmentId: "a", turnId: "t" });
    const payload = parseJobPayload(
      "session.notice",
      (await notices(w.t, w.watcher.sessionId))[0]!.payload,
    );
    expect(payload.notice === "watch" && payload.changes[0]?.fact).toBe("turn-interrupted");
  });

  test("late child birth retracts a premature completion before claim", async () => {
    const w = await world();
    await w.arm();
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, [w.target.events[w.turnEnd]!]);
    const child = await writeSession({
      projectId: w.projectId,
      ticketId: w.ticket.ticketId,
      parentSessionId: w.target.sessionId,
    });
    await accept(w.t, w.watcher.runnerId, child.sessionId, child.events.slice(0, 2));
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(true);
    expect((await notices(w.t, w.watcher.sessionId))[0]?.status).toBe("cancelled");
  });

  test("own stop is silent and ends target watch; watcher stop/archive cancels queued notices", async () => {
    const w = await world();
    await w.arm();
    await fire(w, {
      kind: "session.stopped",
      by: { kind: "session", sessionId: w.watcher.sessionId },
      reason: null,
    });
    expect(await notices(w.t, w.watcher.sessionId)).toEqual([]);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.endedReason).toBe("target_stopped");
    await w.arm();
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, w.target.events.slice(w.turnEnd));
    await fire(w, { kind: "session.archived" }, w.watcher.sessionId);
    expect((await notices(w.t, w.watcher.sessionId))[0]?.status).toBe("cancelled");
    expect((await watchRows(w.t, w.watcher.sessionId)).at(-1)?.endedReason).toBe("watcher_stopped");
  });

  test("access is checked at fire time and dormant ticket watches expire", async () => {
    const w = await world();
    await w.arm();
    await w.arm(newId("command"), w.ticket.ticketId, "ticket");
    await w.t.run(async (ctx) => {
      const member = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", w.workspaceId).eq("userId", w.userId),
        )
        .unique();
      await ctx.db.patch(member!._id, { status: "suspended" });
    });
    await fire(w, { kind: "session.signaled", signal: "done", reason: null });
    expect(await notices(w.t, w.watcher.sessionId)).toEqual([]);
    expect(
      (await watchRows(w.t, w.watcher.sessionId)).find((row) => row.target.kind === "session")
        ?.endedReason,
    ).toBe("access_lost");
    await w.t.mutation(internal.watches.sweep, {});
    expect(
      (await watchRows(w.t, w.watcher.sessionId)).find((row) => row.target.kind === "ticket")
        ?.endedReason,
    ).toBe("access_lost");
    await w.t.run(async (ctx) => {
      const member = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", w.workspaceId).eq("userId", w.userId),
        )
        .unique();
      await ctx.db.patch(member!._id, { status: "active" });
    });
    await w.arm(newId("command"), w.ticket.ticketId, "ticket");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 15 * 24 * 60 * 60_000);
    await w.t.mutation(internal.watches.sweep, {});
    expect((await watchRows(w.t, w.watcher.sessionId)).at(-1)?.endedReason).toBe("expired");
  });

  test("accepted Session-origin starts and steers arm once, but delegated children do not", async () => {
    const w = await world(true);
    const started = await writeSession({ projectId: w.projectId, ticketId: w.ticket.ticketId });
    const first = started.events[0]!;
    first.provenance = {
      ...first.provenance,
      source: {
        ...first.provenance.source,
        detail: { sessionOrigin: { kind: "session", sessionId: w.watcher.sessionId } },
      },
    };
    await accept(w.t, w.watcher.runnerId, started.sessionId, started.events);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.origin).toBe("started");
    const child = await writeSession({
      projectId: w.projectId,
      ticketId: w.ticket.ticketId,
      parentSessionId: w.watcher.sessionId,
    });
    child.events[0]!.provenance = first.provenance;
    await accept(w.t, w.watcher.runnerId, child.sessionId, child.events.slice(0, 2));
    expect(await watchRows(w.t, w.watcher.sessionId)).toHaveLength(1);
    const commandId = newId("command");
    const args = {
      sessionId: started.sessionId,
      commandId,
      ...steerArgs(commandId),
    };
    await w.as.mutation(api.sessions.command, args);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.origin).toBe("steered");
    const extra = moreTurns(started.events, 1);
    await accept(w.t, w.watcher.runnerId, started.sessionId, extra);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(false);
    await w.as.mutation(api.sessions.command, args);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(false);
  });

  test("quotes a bounded staged last reply as untrusted prose", async () => {
    const w = await world();
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, w.target.events.slice(w.turnEnd));
    const body = JSON.stringify({
      message: { role: "assistant", parts: [{ type: "text", text: "x".repeat(5_000) }] },
    });
    await w.t.run((ctx) =>
      ctx.db.insert("transcriptArtifacts", {
        sessionId: w.target.sessionId,
        digest: `sha256:${"b".repeat(64)}`,
        mediaType: "application/json",
        bytes: body.length,
        body,
        spillKey: null,
        firstSequence: null,
        uploadedBy: "runner",
        packedSegmentId: null,
        expiresAt: null,
        createdAt: 0,
      }),
    );
    await w.arm();
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, moreTurns(w.target.events, 1));
    const payload = parseJobPayload(
      "session.notice",
      (await notices(w.t, w.watcher.sessionId))[0]!.payload,
    );
    if (payload.notice !== "watch" || payload.changes[0]?.fact !== "turn-completed")
      throw new Error("No turn notice");
    expect(payload.changes[0].lastMessage).toEqual({
      state: "text",
      message: { text: "x".repeat(4_000), totalChars: 5_000 },
    });
  });
  test("new arms ignore already accepted facts replayed by a delayed fold", async () => {
    const w = await world();
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, w.target.events.slice(w.turnEnd));
    await w.arm();
    await w.t.run(async (ctx) => {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.target.sessionId))
        .unique();
      await onSessionFact(ctx, session!, w.target.events[w.turnEnd]!);
    });
    expect(await notices(w.t, w.watcher.sessionId)).toEqual([]);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(true);
  });

  test("explicitly re-arming a dormant ticket renews its lifetime", async () => {
    const w = await world();
    await w.arm(newId("command"), w.ticket.ticketId, "ticket");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 15 * 24 * 60 * 60_000);
    await w.arm(newId("command"), w.ticket.ticketId, "ticket");
    await w.t.mutation(internal.watches.sweep, {});
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.endedAt).toBeNull();
    await w.person.mutation(api.board.createComment, {
      commandId: newId("command"),
      ticketId: w.ticket.ticketId,
      commentId: newId("comment"),
      body: "still interested",
    });
    expect(await notices(w.t, w.watcher.sessionId)).toHaveLength(1);
  });
  test("a refused arm does not roll back an accepted steer", async () => {
    const w = await world(true);
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.target.sessionId))
        .unique();
      await ctx.db.patch(row!._id, { stopped: { at: 1, reason: null } });
    });
    const commandId = newId("command");
    const reply = await w.as.mutation(api.sessions.command, {
      sessionId: w.target.sessionId,
      commandId,
      ...steerArgs(commandId),
    });
    expect(reply).toMatchObject({
      commandId,
      status: "queued",
      watch: { status: "not_armed", code: "target_stopped" },
    });
    expect(
      await w.t.run((ctx) =>
        ctx.db
          .query("runnerJobs")
          .withIndex("by_uuid", (q) => q.eq("id", commandId))
          .unique(),
      ),
    ).not.toBeNull();
  });

  test("routing refusal is visible and keeps the turn arm for recovery", async () => {
    const w = await world();
    await w.arm();
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", w.watcher.runnerId))
        .unique();
      await ctx.db.patch(row!._id, { revokedAt: 1, status: "revoked" });
    });
    await fire(w, { kind: "turn.completed", attachmentId: "a", turnId: "t" });
    expect(await notices(w.t, w.watcher.sessionId)).toEqual([]);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(true);
    const attention = await w.t.run((ctx) =>
      ctx.db
        .query("attentionItems")
        .withIndex("by_session", (q) => q.eq("sessionId", w.watcher.sessionId))
        .collect(),
    );
    expect(attention).toEqual([
      expect.objectContaining({
        sourceId: "volli:watch-delivery",
        kind: "runner_alert",
        clearedAt: null,
      }),
    ]);
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", w.watcher.runnerId))
        .unique();
      await ctx.db.patch(row!._id, { revokedAt: null, status: "online" });
    });
    await fire(w, { kind: "turn.completed", attachmentId: "a", turnId: "next" });
    expect(await notices(w.t, w.watcher.sessionId)).toHaveLength(1);
    expect(
      (
        await w.t.run((ctx) =>
          ctx.db
            .query("attentionItems")
            .withIndex("by_session", (q) => q.eq("sessionId", w.watcher.sessionId))
            .collect(),
        )
      )[0]?.clearedReason,
    ).toBe("resolved");
  });

  test("access loss removes now-hidden prose from an unleased notice", async () => {
    const w = await world();
    await w.arm();
    await w.arm(newId("command"), w.ticket.ticketId, "ticket");
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, w.target.events.slice(w.turnEnd));
    await w.person.mutation(api.board.createComment, {
      commandId: newId("command"),
      ticketId: w.ticket.ticketId,
      commentId: newId("comment"),
      body: "still visible",
    });
    const bob = await signIn(w.t, "other-owner");
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.target.sessionId))
        .unique();
      await ctx.db.patch(row!._id, { ownerUserId: bob.userId, visibility: "private" });
    });
    await w.t.mutation(internal.watches.sweep, {});
    const payload = parseJobPayload(
      "session.notice",
      (await notices(w.t, w.watcher.sessionId))[0]!.payload,
    );
    expect(payload.notice === "watch" && payload.changes.map((c) => c.fact)).toEqual([
      "ticket-commented",
    ]);
  });

  test("a turn merged into an already-due job gets its own child-deferral window", async () => {
    const w = await world();
    await w.arm();
    await fire(w, { kind: "session.signaled", signal: "blocked", reason: "earlier" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2_000);
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, [w.target.events[w.turnEnd]!]);
    const child = await writeSession({
      projectId: w.projectId,
      ticketId: w.ticket.ticketId,
      parentSessionId: w.target.sessionId,
    });
    await accept(w.t, w.watcher.runnerId, child.sessionId, child.events.slice(0, 2));
    const payload = parseJobPayload(
      "session.notice",
      (await notices(w.t, w.watcher.sessionId))[0]!.payload,
    );
    expect(payload.notice === "watch" && payload.changes.map((c) => c.fact)).toEqual([
      "signaled-blocked",
    ]);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(true);
  });

  test("a child already ended before the parent does not retract its final completion", async () => {
    const w = await world();
    await w.arm();
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, [w.target.events[w.turnEnd]!]);
    const child = await writeSession({
      projectId: w.projectId,
      ticketId: w.ticket.ticketId,
      parentSessionId: w.target.sessionId,
    });
    await accept(w.t, w.watcher.runnerId, child.sessionId, child.events);
    expect((await notices(w.t, w.watcher.sessionId))[0]?.status).toBe("queued");
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(false);
  });

  test("an accepted Session-origin submit re-arms independently of the command door", async () => {
    const w = await world();
    await w.arm();
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, w.target.events.slice(w.turnEnd));
    const before = w.target.events.length;
    await w.target.engine.submit({
      commandId: newId("command"),
      sessionId: w.target.sessionId,
      intent: { kind: "message.submit", reference: { id: "body", mediaType: null, digest: null } },
      provenance: {
        source: {
          kind: "user",
          id: "desktop",
          detail: { sessionOrigin: { kind: "session", sessionId: w.watcher.sessionId } },
        },
        venue: { id: "local", kind: "local" },
      },
    });
    const added = [...(await w.target.engine.listEvents({ sessionId: w.target.sessionId }))].slice(
      before,
    );
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, added);
    expect((await watchRows(w.t, w.watcher.sessionId))[0]).toMatchObject({
      origin: "steered",
      turnArmed: true,
    });
  });
  test("claim re-checks visibility even after unwatch, without waiting for the sweep", async () => {
    const w = await world();
    await w.arm();
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, w.target.events.slice(w.turnEnd));
    await w.as.mutation(api.watches.unwatch, { watcherSessionId: w.watcher.sessionId });
    const bob = await signIn(w.t, "claim-private-owner");
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.target.sessionId))
        .unique();
      await ctx.db.patch(row!._id, { ownerUserId: bob.userId, visibility: "private" });
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2_000);
    expect(
      await asRunner(w.t, w.watcher.runnerId).mutation(api.runnerJobs.claim, {
        bootId: randomUUID(),
      }),
    ).toEqual([]);
    expect((await notices(w.t, w.watcher.sessionId))[0]?.failure?.code).toBe("access_lost");
  });
  test.each([false, true])(
    "access cleanup preserves anonymous overflow counts (other listed change: %s)",
    async (other) => {
      const w = await world();
      await w.arm();
      await w.arm(newId("command"), w.ticket.ticketId, "ticket");
      await accept(w.t, w.watcher.runnerId, w.target.sessionId, w.target.events.slice(w.turnEnd));
      if (other)
        await w.person.mutation(api.board.createComment, {
          commandId: newId("command"),
          ticketId: w.ticket.ticketId,
          commentId: newId("comment"),
          body: "visible",
        });
      const bob = await signIn(w.t, `overflow-owner-${other}`);
      await w.t.run(async (ctx) => {
        const row = await ctx.db
          .query("sessions")
          .withIndex("by_uuid", (q) => q.eq("id", w.target.sessionId))
          .unique();
        await ctx.db.patch(row!._id, { ownerUserId: bob.userId, visibility: "private" });
        const job = (
          await ctx.db
            .query("runnerJobs")
            .withIndex("by_session", (q) => q.eq("sessionId", w.watcher.sessionId))
            .collect()
        ).find((j) => j.kind === "session.notice")!;
        const payload = parseJobPayload("session.notice", job.payload);
        await ctx.db.patch(job._id, { payload: { ...payload, overflow: 5 } });
      });
      await w.t.mutation(internal.watches.sweep, {});
      const job = (await notices(w.t, w.watcher.sessionId))[0]!;
      const payload = parseJobPayload("session.notice", job.payload);
      expect(job.status).toBe("queued");
      expect(payload.notice === "watch" && payload.overflow).toBe(5);
      expect(payload.notice === "watch" && payload.changes.length).toBe(other ? 1 : 0);
    },
  );

  test("late-child deferral does not infer causality from runner clocks", async () => {
    const w = await world();
    await w.arm();
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, [w.target.events[w.turnEnd]!]);
    const child = await writeSession({
      projectId: w.projectId,
      ticketId: w.ticket.ticketId,
      parentSessionId: w.target.sessionId,
    });
    const future = Date.now() + 365 * 24 * 60 * 60_000;
    const birth = child.events.slice(0, 2);
    for (const event of birth) {
      const payload = event.payload;
      event.occurredAt = future;
      event.recordedAt = future;
      if (payload.kind === "command.recorded")
        event.payload = { ...payload, command: { ...payload.command, createdAt: future } };
      else if (payload.kind === "session.created")
        event.payload = { ...payload, session: { ...payload.session, createdAt: future } };
    }
    await accept(w.t, w.watcher.runnerId, child.sessionId, birth);
    expect((await notices(w.t, w.watcher.sessionId))[0]?.status).toBe("cancelled");
    expect((await watchRows(w.t, w.watcher.sessionId))[0]?.turnArmed).toBe(true);
  });
  test("a crashed lease cancelled for changed access reports visible work and re-arms it", async () => {
    const w = await world();
    await w.arm();
    const visible = await writeSession({ projectId: w.projectId, ticketId: w.ticket.ticketId });
    await accept(w.t, w.watcher.runnerId, visible.sessionId, visible.events);
    await w.arm(newId("command"), visible.sessionId);
    await fire(w, { kind: "turn.completed", attachmentId: "a", turnId: "t" }, visible.sessionId);
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, w.target.events.slice(w.turnEnd));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2_000);
    expect(
      await asRunner(w.t, w.watcher.runnerId).mutation(api.runnerJobs.claim, {
        bootId: randomUUID(),
      }),
    ).toHaveLength(1);
    const bob = await signIn(w.t, "reclaim-private-owner");
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.target.sessionId))
        .unique();
      await ctx.db.patch(row!._id, { ownerUserId: bob.userId, visibility: "private" });
    });
    expect(
      await asRunner(w.t, w.watcher.runnerId).mutation(api.runnerJobs.claim, {
        bootId: randomUUID(),
      }),
    ).toEqual([]);
    expect((await notices(w.t, w.watcher.sessionId))[0]?.status).toBe("cancelled");
    const attention = await w.t.run((ctx) =>
      ctx.db
        .query("attentionItems")
        .withIndex("by_session", (q) => q.eq("sessionId", w.watcher.sessionId))
        .collect(),
    );
    expect(attention).toEqual([
      expect.objectContaining({ sourceId: "volli:watch-delivery", clearedAt: null }),
    ]);
    expect(
      (await watchRows(w.t, w.watcher.sessionId)).find((row) => row.target.id === visible.sessionId)
        ?.turnArmed,
    ).toBe(true);
  });
  test("an unreadable notice is leased for permanent failure without starving other work", async () => {
    const w = await world();
    await w.arm();
    await accept(w.t, w.watcher.runnerId, w.target.sessionId, w.target.events.slice(w.turnEnd));
    await w.t.run(async (ctx) => {
      const job = (
        await ctx.db
          .query("runnerJobs")
          .withIndex("by_session", (q) => q.eq("sessionId", w.watcher.sessionId))
          .collect()
      ).find((j) => j.kind === "session.notice")!;
      await ctx.db.patch(job._id, { payload: { format: "old-notice" } });
    });
    await fire(w, { kind: "session.signaled", signal: "blocked", reason: "new fact still drains" });
    await w.person.mutation(api.sessions.command, {
      sessionId: w.watcher.sessionId,
      commandId: newId("command"),
      intent: JSON.stringify({ kind: "session.retitle", title: "other work" }),
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2_000);
    const jobs = await asRunner(w.t, w.watcher.runnerId).mutation(api.runnerJobs.claim, {
      bootId: randomUUID(),
    });
    expect(jobs.map((j) => j.job.kind).toSorted()).toEqual([
      "session.command",
      "session.notice",
      "session.notice",
    ]);
    expect(
      jobs.some((j) => JSON.stringify(j.job.payload) === JSON.stringify({ format: "old-notice" })),
    ).toBe(true);
  });
});

async function fire(
  w: Awaited<ReturnType<typeof world>>,
  payload: SessionEvent["payload"],
  sessionId = w.target.sessionId,
) {
  await w.t.run(async (ctx) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", sessionId))
      .unique();
    const base = w.target.events.at(-1)!;
    await onSessionFact(ctx, session!, {
      ...base,
      id: randomUUID(),
      sessionId,
      sequence: base.sequence + 1,
      payload,
    });
  });
}
