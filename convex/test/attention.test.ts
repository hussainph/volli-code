import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  ATTENTION_LIMITS,
  RUNNER_TOKEN_ISSUER,
  newId,
  type Actor,
  type UserId,
} from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import type { Doc } from "../functions/_generated/dataModel.js";
import { attentionVisibility, raiseAttention, raiseRunnerAlert } from "../functions/lib/attention";
import { BoardWrite } from "../functions/lib/board";
import { seedTestRunner, seedTestWorld } from "../functions/lib/testWorld";
import schema from "../functions/schema";
import { enrollPreview } from "./preview-fixtures";
import { wire, writeSession } from "./sessionFixtures";

const modules = import.meta.glob("../functions/**/*.ts");
const ISSUER = "https://issuer.test";

const setup = () => convexTest(schema, modules);
type T = ReturnType<typeof setup>;

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

const asUser = (t: T, name: string) => t.withIdentity({ subject: `user:${name}`, issuer: ISSUER });
const asRunner = (t: T, runnerId: string) =>
  t.withIdentity({ subject: `runner:${runnerId}`, issuer: RUNNER_TOKEN_ISSUER });

async function signIn(t: T, name: string): Promise<UserId> {
  const result = await asUser(t, name).mutation(api.accounts.ensureViewer, {});
  // Every product call rechecks the grant and the accepted agreement, for a
  // person and for a runner token's owner alike.
  await enrollPreview(t, result.userId);
  return result.userId as UserId;
}

/** Alice owns the world and its runners; Bob and Dan are Members; Carol is outside it. */
async function world() {
  const t = setup();
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const carol = await signIn(t, "carol");
  const dan = await signIn(t, "dan");
  const seeded = await t.run(async (ctx) => {
    const rows = await seedTestWorld(ctx, {
      ownerUserId: alice,
      memberUserIds: [bob, dan],
      runners: 2,
    });
    // The board's counter, which `projects.create` writes for a real project.
    await ctx.db.insert("projectCounters", {
      projectId: rows.projectId,
      nextTicketNumber: 2,
      boardSeq: 0,
    });
    return rows;
  });
  return { t, alice, bob, carol, dan, ...seeded };
}

async function items(t: T): Promise<Doc<"attentionItems">[]> {
  return t.run((ctx) => ctx.db.query("attentionItems").collect());
}

async function item(t: T, id: string): Promise<Doc<"attentionItems"> | null> {
  return t.run((ctx) =>
    ctx.db
      .query("attentionItems")
      .withIndex("by_uuid", (q) => q.eq("id", id))
      .unique(),
  );
}

function move(t: T, who: string, projectId: string, ticketId: string, toStatus: string) {
  return asUser(t, who).mutation(api.board.moveTickets, {
    commandId: randomUUID(),
    projectId,
    ticketIds: [ticketId],
    toStatus: toStatus as "needs_review",
  });
}

async function assign(t: T, ticketId: string, to: string | null, actor: Actor) {
  await t.run(async (ctx) => {
    const ticket = (await ctx.db
      .query("tickets")
      .withIndex("by_uuid", (q) => q.eq("id", ticketId))
      .unique())!;
    await ctx.db.patch(ticket._id, { assigneeUserId: to });
    const write = await BoardWrite.open(ctx, ticket.projectId, actor, Date.now());
    await write.append([
      {
        ticketId: ticketId as never,
        payload: {
          kind: "assigned",
          from: ticket.assigneeUserId as UserId | null,
          to: to as UserId | null,
        },
      },
    ]);
    await write.commit();
  });
}

const reviewId = (ticketId: string, userId: string) => `t:${ticketId}:review:${userId}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("the one writer", () => {
  test("only lib/attention.ts inserts attention items", () => {
    const root = join(import.meta.dirname, "../functions");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      (file) => file.endsWith(".ts") && !file.startsWith("_generated"),
    );
    const writers = files.filter((file) => {
      const source = readFileSync(join(root, file), "utf8");
      return source.includes('insert("attentionItems"');
    });
    expect(writers).toEqual([join("lib", "attention.ts")]);
  });

  test("a raise reopens a cleared item unseen, and leaves an open one's seenAt alone", async () => {
    const { t, alice } = await world();
    const draft = {
      id: "x:1",
      userId: alice,
      projectId: null,
      ticketId: null,
      sessionId: null,
      source: "runner_alert" as const,
      sourceId: "x",
      kind: "x",
      title: "X",
      detail: null,
      raisedAt: 1,
    };
    await t.run(async (ctx) => {
      expect(await raiseAttention(ctx, draft)).toBe("raised");
      expect(await raiseAttention(ctx, { ...draft, title: "Y" })).toBe("updated");
    });
    await asUser(t, "alice").mutation(api.attention.markSeen, { ids: ["x:1"] });
    await t.run(async (ctx) => {
      expect(await raiseAttention(ctx, { ...draft, raisedAt: 2 })).toBe("updated");
    });
    expect(await item(t, "x:1")).toMatchObject({
      title: "X",
      raisedAt: 2,
      seenAt: expect.any(Number),
    });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("attentionItems").first())!;
      await ctx.db.patch(row._id, { clearedAt: 3, clearedReason: "resolved" });
      expect(await raiseAttention(ctx, { ...draft, raisedAt: 4 })).toBe("raised");
    });
    expect(await item(t, "x:1")).toMatchObject({
      raisedAt: 4,
      seenAt: null,
      clearedAt: null,
      clearedReason: null,
    });
  });
});

describe("review requests", () => {
  test("a ticket entering Needs Review asks its assignee, and leaving the column clears it", async () => {
    const { t, bob, projectId, ticketId } = await world();
    await assign(t, ticketId, bob, { kind: "person", userId: bob });
    expect(await items(t)).toEqual([]);
    await move(t, "alice", projectId, ticketId, "needs_review");
    expect(await items(t)).toEqual([
      expect.objectContaining({
        id: reviewId(ticketId, bob),
        userId: bob,
        projectId,
        ticketId,
        sessionId: null,
        source: "review_requested",
        sourceId: ticketId,
        kind: "review_requested",
        title: "TS-1 needs your review",
        detail: "Ticket",
        clearedAt: null,
        seenAt: null,
      }),
    ]);
    await move(t, "bob", projectId, ticketId, "done");
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({
      clearedReason: "resolved",
      clearedAt: expect.any(Number),
    });
    // Back into the column: asked again, unseen.
    await move(t, "alice", projectId, ticketId, "needs_review");
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({ clearedAt: null, seenAt: null });
  });

  test("nobody is asked by their own move, or without an assignee", async () => {
    const { t, bob, projectId, ticketId } = await world();
    await move(t, "alice", projectId, ticketId, "needs_review");
    expect(await items(t)).toEqual([]);
    await move(t, "alice", projectId, ticketId, "doing");
    await assign(t, ticketId, bob, { kind: "person", userId: bob });
    await move(t, "bob", projectId, ticketId, "needs_review");
    expect(await items(t)).toEqual([]);
  });

  test("a new assignee takes the request over; an archive clears it", async () => {
    const { t, alice, bob, dan, projectId, ticketId } = await world();
    await assign(t, ticketId, bob, { kind: "person", userId: alice });
    await move(t, "alice", projectId, ticketId, "needs_review");
    await assign(t, ticketId, dan, { kind: "person", userId: alice });
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({ clearedReason: "superseded" });
    expect(await item(t, reviewId(ticketId, dan))).toMatchObject({ userId: dan, clearedAt: null });
    // Dan taking it himself means nobody is waiting on anybody.
    await assign(t, ticketId, bob, { kind: "person", userId: alice });
    await assign(t, ticketId, dan, { kind: "person", userId: dan });
    expect((await items(t)).filter((row) => row.clearedAt === null)).toEqual([]);
    // An agent bringing work back to its person does ask them.
    await assign(t, ticketId, bob, { kind: "agent", userId: bob, sessionId: newId("session") });
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({ clearedAt: null });
    await asUser(t, "alice").mutation(api.board.archiveTicket, {
      commandId: randomUUID(),
      ticketId,
    });
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({ clearedReason: "superseded" });
  });
});

describe("review requests and membership", () => {
  test("a person who is not an active Member is never asked", async () => {
    vi.useFakeTimers();
    const { t, alice, bob, workspaceId, projectId, ticketId } = await world();
    await assign(t, ticketId, bob, { kind: "person", userId: alice });
    await move(t, "alice", projectId, ticketId, "needs_review");
    await asUser(t, "alice").mutation(api.members.suspend, { workspaceId, userId: bob });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({ clearedReason: "access_lost" });
    await move(t, "alice", projectId, ticketId, "doing");
    await move(t, "alice", projectId, ticketId, "needs_review");
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({ clearedReason: "access_lost" });
    await asUser(t, "alice").mutation(api.members.unsuspend, { workspaceId, userId: bob });
    await move(t, "alice", projectId, ticketId, "doing");
    await move(t, "alice", projectId, ticketId, "needs_review");
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({ clearedAt: null });
  });

  test("unarchiving a ticket in Needs Review asks again", async () => {
    const { t, alice, bob, projectId, ticketId } = await world();
    await assign(t, ticketId, bob, { kind: "person", userId: alice });
    await move(t, "alice", projectId, ticketId, "needs_review");
    await asUser(t, "alice").mutation(api.board.archiveTicket, {
      commandId: randomUUID(),
      ticketId,
    });
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({ clearedReason: "superseded" });
    await asUser(t, "alice").mutation(api.board.unarchiveTicket, {
      commandId: randomUUID(),
      ticketId,
    });
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({ clearedAt: null, seenAt: null });
  });
});

describe("attention.markSeen", () => {
  test("marks the viewer's own items only, idempotently, within the bound", async () => {
    const { t, bob, projectId, ticketId } = await world();
    await assign(t, ticketId, bob, { kind: "person", userId: bob });
    await move(t, "alice", projectId, ticketId, "needs_review");
    const id = reviewId(ticketId, bob);
    await expect(
      asUser(t, "alice").mutation(api.attention.markSeen, { ids: [id] }),
    ).resolves.toEqual({ marked: 0 });
    expect(await item(t, id)).toMatchObject({ seenAt: null });
    await expect(
      asUser(t, "bob").mutation(api.attention.markSeen, { ids: [id, id, "missing"] }),
    ).resolves.toEqual({ marked: 1 });
    expect(await item(t, id)).toMatchObject({ seenAt: expect.any(Number), clearedAt: null });
    await expect(asUser(t, "bob").mutation(api.attention.markSeen, { ids: [id] })).resolves.toEqual(
      {
        marked: 0,
      },
    );
    await expect(
      asUser(t, "bob").mutation(api.attention.markSeen, {
        ids: Array.from({ length: ATTENTION_LIMITS.markSeenIds + 1 }, (_, index) => `${index}`),
      }),
    ).rejects.toThrow(code("invalid_argument"));
    await expect(t.mutation(api.attention.markSeen, { ids: [] })).rejects.toThrow(
      code("unauthenticated"),
    );
  });
});

describe("visibility", () => {
  test("an item with no project or Workspace is its person's alone", async () => {
    const { t, alice, bob, runnerIds } = await world();
    await t.run(async (ctx) => {
      await raiseRunnerAlert(
        ctx,
        { id: runnerIds[0]!, ownerUserId: alice, name: "runner-0" },
        "credential_reuse",
        1,
      );
      const row = (await ctx.db.query("attentionItems").first())!;
      expect(row.projectId).toBeNull();
      expect(await attentionVisibility(ctx, { userId: alice })(row)).toBe(true);
      expect(await attentionVisibility(ctx, { userId: bob })(row)).toBe(false);
    });
  });

  test("a project's or a Workspace's item, while its person is an active Member there", async () => {
    const { t, bob, carol, workspaceId, projectId } = await world();
    const base = {
      ticketId: null,
      sessionId: null,
      source: "billing" as const,
      sourceId: "b",
      kind: "billing",
      title: "B",
      detail: null,
      raisedAt: 1,
    };
    await t.run(async (ctx) => {
      await raiseAttention(ctx, { ...base, id: "w", userId: bob, projectId: null, workspaceId });
      await raiseAttention(ctx, { ...base, id: "p", userId: bob, projectId });
      await raiseAttention(ctx, { ...base, id: "c", userId: carol, projectId });
      const rows = new Map((await ctx.db.query("attentionItems").collect()).map((r) => [r.id, r]));
      const bobSees = attentionVisibility(ctx, { userId: bob });
      expect(await bobSees(rows.get("w")!)).toBe(true);
      expect(await bobSees(rows.get("p")!)).toBe(true);
      // Named for Carol, who is not a Member: hidden from her, and never shown to Bob.
      expect(await attentionVisibility(ctx, { userId: carol })(rows.get("c")!)).toBe(false);
      expect(await bobSees(rows.get("c")!)).toBe(false);
      const member = (await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", bob))
        .unique())!;
      await ctx.db.patch(member._id, { status: "suspended" });
      const suspended = attentionVisibility(ctx, { userId: bob });
      expect(await suspended(rows.get("w")!)).toBe(false);
      expect(await suspended(rows.get("p")!)).toBe(false);
      await ctx.db.patch(member._id, { status: "active" });
      const project = (await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", projectId))
        .unique())!;
      await ctx.db.patch(project._id, { deletedAt: 5 });
      const workspace = (await ctx.db
        .query("workspaces")
        .withIndex("by_uuid", (q) => q.eq("id", workspaceId))
        .unique())!;
      await ctx.db.patch(workspace._id, { deletedAt: 5 });
      const gone = attentionVisibility(ctx, { userId: bob });
      expect(await gone(rows.get("p")!)).toBe(false);
      expect(await gone(rows.get("w")!)).toBe(false);
    });
  });
});

describe("access_lost sweeps", () => {
  async function bobHasItems() {
    vi.useFakeTimers();
    const seeded = await world();
    const { t, bob, projectId, ticketId } = seeded;
    await assign(t, ticketId, bob, { kind: "person", userId: bob });
    await move(t, "alice", projectId, ticketId, "needs_review");
    // Bob's own runner alert, and an item in a Workspace of his own: neither is swept.
    const elsewhere = await t.run(async (ctx) => {
      const other = await seedTestWorld(ctx, { ownerUserId: bob, runners: 0 });
      const runnerId = await seedTestRunner(ctx, bob, "bobs-box");
      await raiseRunnerAlert(
        ctx,
        { id: runnerId, ownerUserId: bob, name: "bobs-box" },
        "credential_reuse",
        1,
      );
      await raiseAttention(ctx, {
        id: "elsewhere",
        userId: bob,
        projectId: other.projectId,
        ticketId: null,
        sessionId: null,
        source: "mention",
        sourceId: "m",
        kind: "mention",
        title: "M",
        detail: null,
        raisedAt: 1,
      });
      return runnerId;
    });
    return { ...seeded, alertId: `r:${elsewhere}:credential_reuse` };
  }

  test.each(["suspend", "remove"] as const)(
    "%s clears the Member's open items in that Workspace only",
    async (change) => {
      const { t, bob, workspaceId, ticketId, alertId } = await bobHasItems();
      await asUser(t, "alice").mutation(api.members[change], { workspaceId, userId: bob });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await item(t, reviewId(ticketId, bob))).toMatchObject({
        clearedReason: "access_lost",
      });
      expect(await item(t, alertId)).toMatchObject({ clearedAt: null });
      expect(await item(t, "elsewhere")).toMatchObject({ clearedAt: null });
    },
  );

  test("leaving does too, and one who is back before the sweep runs keeps theirs", async () => {
    const { t, bob, workspaceId, ticketId } = await bobHasItems();
    await asUser(t, "alice").mutation(api.members.suspend, { workspaceId, userId: bob });
    await asUser(t, "alice").mutation(api.members.unsuspend, { workspaceId, userId: bob });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({ clearedAt: null });
    await asUser(t, "bob").mutation(api.members.leave, { workspaceId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await item(t, reviewId(ticketId, bob))).toMatchObject({ clearedReason: "access_lost" });
  });

  test("pages through many items, some of which stay, and sweeps billing items too", async () => {
    vi.useFakeTimers();
    const { t, bob, workspaceId, projectId } = await world();
    const otherProjectId = await t.run(async (ctx) => {
      const other = await seedTestWorld(ctx, { ownerUserId: bob, runners: 0 });
      await raiseAttention(ctx, {
        id: "billing",
        userId: bob,
        projectId: null,
        workspaceId,
        ticketId: null,
        sessionId: null,
        source: "billing",
        sourceId: "b",
        kind: "billing",
        title: "B",
        detail: null,
        raisedAt: 0,
      });
      return other.projectId;
    });
    await t.run(async (ctx) => {
      for (let index = 0; index < 450; index += 1) {
        await raiseAttention(ctx, {
          id: `m:${index}`,
          userId: bob,
          // Every third item is in Bob's own Workspace and stays.
          projectId: index % 3 === 0 ? otherProjectId : projectId,
          ticketId: null,
          sessionId: null,
          source: "mention",
          sourceId: `${index}`,
          kind: "mention",
          title: "M",
          detail: null,
          raisedAt: index,
        });
      }
    });
    await asUser(t, "alice").mutation(api.members.remove, { workspaceId, userId: bob });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const open = (await items(t)).filter((row) => row.clearedAt === null);
    expect(open).toHaveLength(150);
    expect(open.every((row) => row.projectId === otherProjectId)).toBe(true);
    expect(await item(t, "billing")).toMatchObject({ clearedReason: "access_lost" });
  });
});

describe("attention.raiseFromRunner (volli notify)", () => {
  async function claimedSession() {
    const seeded = await world();
    const { t, projectId, runnerIds } = seeded;
    const { sessionId, events } = await writeSession({ projectId });
    await asRunner(t, runnerIds[0]!).mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: events.slice(0, 1).map(wire),
    });
    return { ...seeded, sessionId };
  }

  test("the runner holding the Session raises an item for its owner, once per call", async () => {
    const { t, alice, projectId, runnerIds, sessionId } = await claimedSession();
    const notifyId = randomUUID();
    const call = {
      sessionId,
      generation: 1,
      notifyId,
      title: " Deploy finished ",
      detail: "All green.",
    };
    const runner = asRunner(t, runnerIds[0]!);
    await expect(runner.mutation(api.attention.raiseFromRunner, call)).resolves.toEqual({
      attentionId: `s:${sessionId}:volli:notify:${notifyId}`,
      userId: alice,
      displayName: expect.any(String),
      duplicate: false,
    });
    const raised = await item(t, `s:${sessionId}:volli:notify:${notifyId}`);
    expect(raised).toMatchObject({
      userId: alice,
      projectId,
      ticketId: null,
      sessionId,
      source: "notify",
      kind: "notify",
      title: "Deploy finished",
      detail: "All green.",
      clearedAt: null,
    });
    // Its owner reads it in their Session's attention, and seeing it is its answer.
    const open = await asUser(t, "alice").query(api.sessions.attention, {});
    expect(open.map((row) => row.source)).toContain("notify");
    await asUser(t, "alice").mutation(api.attention.markSeen, { ids: [raised!.id] });
    expect(await item(t, raised!.id)).toMatchObject({ clearedReason: "resolved" });
    // A retry of the same call never reopens it.
    await expect(runner.mutation(api.attention.raiseFromRunner, call)).resolves.toMatchObject({
      duplicate: true,
    });
    expect(await item(t, raised!.id)).toMatchObject({ clearedReason: "resolved" });
  });

  test("a runner that does not hold the Session, or another person's runner, is refused", async () => {
    const { t, bob, runnerIds, sessionId } = await claimedSession();
    const call = { sessionId, generation: 1, notifyId: randomUUID(), title: "Hi", detail: null };
    await expect(
      asRunner(t, runnerIds[1]!).mutation(api.attention.raiseFromRunner, call),
    ).rejects.toThrow(code("fenced"));
    const bobsRunner = await t.run((ctx) => seedTestRunner(ctx, bob, "bobs"));
    await expect(
      asRunner(t, bobsRunner).mutation(api.attention.raiseFromRunner, call),
    ).rejects.toThrow(code("not_found"));
    await expect(
      asRunner(t, runnerIds[0]!).mutation(api.attention.raiseFromRunner, {
        ...call,
        sessionId: randomUUID(),
      }),
    ).rejects.toThrow(code("not_found"));
    // The claim at another generation, a released claim, a deleted Session.
    const holder = asRunner(t, runnerIds[0]!);
    await expect(
      holder.mutation(api.attention.raiseFromRunner, { ...call, generation: 2 }),
    ).rejects.toThrow(code("fenced"));
    const patchRow = (table: "sessionIntake" | "sessions", fields: Record<string, unknown>) =>
      t.run(async (ctx) => {
        const row = (await ctx.db.query(table).first())!;
        await ctx.db.patch(row._id, fields);
      });
    await patchRow("sessionIntake", { state: "released" });
    await expect(holder.mutation(api.attention.raiseFromRunner, call)).rejects.toThrow(
      code("fenced"),
    );
    await patchRow("sessionIntake", { state: "active" });
    await patchRow("sessions", { deletedAt: 1 });
    await expect(holder.mutation(api.attention.raiseFromRunner, call)).rejects.toThrow(
      code("not_found"),
    );
    // A person is not a runner.
    await expect(asUser(t, "alice").mutation(api.attention.raiseFromRunner, call)).rejects.toThrow(
      code("not_a_runner"),
    );
    expect(await items(t)).toEqual([]);
  });

  test("checks its arguments", async () => {
    const { t, runnerIds, sessionId } = await claimedSession();
    const runner = asRunner(t, runnerIds[0]!);
    const call = { sessionId, generation: 1, notifyId: randomUUID(), title: "Hi", detail: null };
    for (const bad of [
      { ...call, sessionId: "nope" },
      { ...call, notifyId: "nope" },
      { ...call, title: "  " },
      { ...call, title: "x".repeat(ATTENTION_LIMITS.notifyTitleLength + 1) },
      { ...call, detail: "x".repeat(ATTENTION_LIMITS.notifyDetailLength + 1) },
    ]) {
      await expect(runner.mutation(api.attention.raiseFromRunner, bad)).rejects.toThrow(
        code("invalid_argument"),
      );
    }
    await expect(
      runner.mutation(api.attention.raiseFromRunner, { ...call, detail: "  " }),
    ).resolves.toMatchObject({ duplicate: false });
  });

  test("a Session holds a bounded number of unseen notifications", async () => {
    const { t, runnerIds, sessionId } = await claimedSession();
    const runner = asRunner(t, runnerIds[0]!);
    const notify = (notifyId: string) =>
      runner.mutation(api.attention.raiseFromRunner, {
        sessionId,
        generation: 1,
        notifyId,
        title: "Hi",
        detail: null,
      });
    const first = randomUUID();
    await notify(first);
    for (let index = 1; index < ATTENTION_LIMITS.notifyOpenPerSession; index += 1) {
      await notify(randomUUID());
    }
    await expect(notify(randomUUID())).rejects.toThrow(code("limit_reached"));
    // A retry of one already raised still answers; seeing one makes room.
    await expect(notify(first)).resolves.toMatchObject({ duplicate: true });
    await asUser(t, "alice").mutation(api.attention.markSeen, {
      ids: [`s:${sessionId}:volli:notify:${first}`],
    });
    await expect(notify(randomUUID())).resolves.toMatchObject({ duplicate: false });
  });

  test("an owner who left the project's Workspace is not notified there", async () => {
    const { t, alice, workspaceId, runnerIds, sessionId } = await claimedSession();
    await t.run(async (ctx) => {
      const member = (await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", alice))
        .unique())!;
      await ctx.db.patch(member._id, { status: "left" });
    });
    await expect(
      asRunner(t, runnerIds[0]!).mutation(api.attention.raiseFromRunner, {
        sessionId,
        generation: 1,
        notifyId: randomUUID(),
        title: "Hi",
        detail: null,
      }),
    ).rejects.toThrow(code("not_found"));
  });
});
