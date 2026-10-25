import { randomUUID } from "node:crypto";
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

async function world() {
  const t = setup();
  const alice = await boardFixture(t);
  const ticket = await createTicket(alice.as, alice.projectId);
  const watcher = await seedSession(
    t,
    { projectId: alice.projectId, ticketId: ticket.ticketId },
    alice.userId,
  );
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

afterEach(() => vi.useRealTimers());

describe("durable watches", () => {
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
    const w = await world();
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
      intent: JSON.stringify({
        kind: "message.submit",
        reference: { id: "body", mediaType: null, digest: null },
      }),
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
