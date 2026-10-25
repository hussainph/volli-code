import { describe, expect, test } from "vite-plus/test";

import { newId } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { Doc } from "../functions/_generated/dataModel";
import { seedTestWorld } from "../functions/lib/testWorld";
import { asRunner, clearMembership, code, context, runnerWorld } from "./runnerContextFixtures";
import { wire, writeSession } from "./sessionFixtures";

describe("runnerContext.forSession", () => {
  test("reads a local birth's brief before first accept without creating a Session", async () => {
    const world = await runnerWorld();
    const result = await context(world);
    expect(result).toMatchObject({
      ownerUserId: world.alice.userId,
      project: { id: world.projectId, name: "Test", ticketPrefix: "TS" },
      ticket: {
        id: world.ticketId,
        number: 1,
        title: "Ticket",
        checkoutMode: "worktree",
        branch: "volli/TS-1-ticket",
        baseBranch: "develop",
      },
      body: "The cloud ticket brief.",
      ticketPrefix: "TS",
      primaryRepo: { id: world.projectRepoId, projectId: world.projectId, baseBranch: "develop" },
    });
    for (const row of [result.project, result.ticket, result.primaryRepo]) {
      expect(row).not.toHaveProperty("_id");
      expect(row).not.toHaveProperty("_creationTime");
      expect(row).not.toHaveProperty("path");
    }
    expect(await world.t.run((ctx) => ctx.db.query("sessions").collect())).toEqual([]);
    expect(await world.t.run((ctx) => ctx.db.query("sessionIntake").collect())).toEqual([]);
  });

  test("returns a stable default primary repo for a folder project without writing one", async () => {
    const world = await runnerWorld({ repo: false });
    expect((await context(world)).primaryRepo).toMatchObject({
      id: world.projectId,
      projectId: world.projectId,
      provider: "none",
      baseBranch: null,
    });
    expect(await world.t.run((ctx) => ctx.db.query("projectRepos").collect())).toEqual([]);
  });

  test("a known Session needs only its id; identity hints cannot select another brief", async () => {
    const world = await runnerWorld();
    const { sessionId, events } = await writeSession(world);
    await world.runner.mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: events.slice(0, 2).map(wire),
    });
    expect(await world.runner.query(api.runnerContext.forSession, { sessionId })).toMatchObject({
      sessionId,
      ownerUserId: world.alice.userId,
      ticket: { id: world.ticketId },
    });
    await expect(
      world.runner.query(api.runnerContext.forSession, {
        sessionId,
        projectId: newId("project"),
      }),
    ).rejects.toMatchObject(code("invalid_request"));
    await expect(
      world.runner.query(api.runnerContext.forSession, {
        sessionId,
        ticketId: null,
      }),
    ).rejects.toMatchObject(code("invalid_request"));
    await expect(
      world.nextRunner.query(api.runnerContext.forSession, { sessionId }),
    ).rejects.toMatchObject(code("fenced"));
    await expect(
      world.memberRunner.query(api.runnerContext.forSession, { sessionId }),
    ).rejects.toMatchObject(code("not_your_runner"));
  });

  test("claim transfer fences the old runner and release fences the new one", async () => {
    const world = await runnerWorld();
    const { sessionId, events } = await writeSession(world);
    await world.runner.mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: events.slice(0, 2).map(wire),
    });
    await world.t.mutation(internal.sessions.transferClaim, {
      sessionId,
      toRunnerId: world.runnerIds[1]!,
      headSequence: 2,
    });
    await expect(
      world.runner.query(api.runnerContext.forSession, { sessionId }),
    ).rejects.toMatchObject(code("fenced"));
    expect(await world.nextRunner.query(api.runnerContext.forSession, { sessionId })).toMatchObject(
      { sessionId },
    );
    await world.t.run(async (ctx) => {
      const intake = await ctx.db
        .query("sessionIntake")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique();
      await ctx.db.patch(intake!._id, { state: "released" });
    });
    await expect(
      world.nextRunner.query(api.runnerContext.forSession, { sessionId }),
    ).rejects.toMatchObject(code("fenced"));
  });

  test("refuses nonmembers, suspended owners, and a moved project's former member", async () => {
    const world = await runnerWorld();
    const args = {
      sessionId: newId("session"),
      projectId: world.projectId,
      ticketId: world.ticketId,
    };
    await expect(
      world.outsiderRunner.query(api.runnerContext.forSession, args),
    ).rejects.toMatchObject(code("not_found"));
    await clearMembership(world.t, world.workspaceId, world.alice.userId);
    await expect(world.runner.query(api.runnerContext.forSession, args)).rejects.toMatchObject(
      code("not_found"),
    );
    const destination = await world.t.run((ctx) =>
      seedTestWorld(ctx, {
        ownerUserId: world.outsider.userId,
        runners: 0,
      }),
    );
    await world.t.run(async (ctx) => {
      const project = await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", world.projectId))
        .unique();
      await ctx.db.patch(project!._id, { workspaceId: destination.workspaceId });
    });
    // Bob is still active in the source Workspace, but not in the destination.
    await expect(
      world.memberRunner.query(api.runnerContext.forSession, args),
    ).rejects.toMatchObject(code("not_found"));
  });

  test("known claims do not bypass current membership", async () => {
    const world = await runnerWorld();
    const { sessionId, events } = await writeSession(world);
    await world.runner.mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: events.slice(0, 1).map(wire),
    });
    await clearMembership(world.t, world.workspaceId, world.alice.userId);
    await expect(
      world.runner.query(api.runnerContext.forSession, { sessionId }),
    ).rejects.toMatchObject(code("not_found"));
  });

  test("requires a project for new births and refuses cross-project/deleted tickets", async () => {
    const world = await runnerWorld();
    await expect(
      world.runner.query(api.runnerContext.forSession, { sessionId: newId("session") }),
    ).rejects.toMatchObject(code("invalid_request"));
    const other = await world.t.run((ctx) =>
      seedTestWorld(ctx, {
        ownerUserId: world.alice.userId,
        runners: 0,
      }),
    );
    await expect(
      world.runner.query(api.runnerContext.forSession, {
        sessionId: newId("session"),
        projectId: world.projectId,
        ticketId: other.ticketId,
      }),
    ).rejects.toMatchObject(code("not_found"));
    await world.t.run(async (ctx) => {
      const ticket = await ctx.db
        .query("tickets")
        .withIndex("by_uuid", (q) => q.eq("id", world.ticketId))
        .unique();
      await ctx.db.patch(ticket!._id, { deletedAt: 1 });
    });
    await expect(context(world)).rejects.toMatchObject(code("not_found"));
  });

  test("ticketless context is explicit and a missing ticket body is empty", async () => {
    const world = await runnerWorld();
    expect(
      await world.runner.query(api.runnerContext.forSession, {
        sessionId: newId("session"),
        projectId: world.projectId,
      }),
    ).toMatchObject({ ticket: null, body: null, retention: null });
    await world.t.run(async (ctx) => {
      const body = await ctx.db.query("ticketBodies").first();
      await ctx.db.delete(body!._id);
    });
    expect(await context(world)).toMatchObject({ body: "" });
  });

  test("requires runner auth and immediately respects revocation", async () => {
    const world = await runnerWorld();
    const args = { sessionId: newId("session"), projectId: world.projectId };
    await expect(world.t.query(api.runnerContext.forSession, args)).rejects.toMatchObject(
      code("unauthenticated"),
    );
    await expect(world.alice.as.query(api.runnerContext.forSession, args)).rejects.toMatchObject(
      code("not_a_runner"),
    );
    await world.t.run(async (ctx) => {
      const runner = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", world.runnerId))
        .unique();
      await ctx.db.patch(runner!._id, { revokedAt: 1 });
    });
    await expect(
      asRunner(world.t, world.runnerId).query(api.runnerContext.forSession, args),
    ).rejects.toMatchObject(code("revoked"));
  });
});

async function retentionHistory(
  world: Awaited<ReturnType<typeof runnerWorld>>,
  status: Doc<"tickets">["status"],
  events: {
    kind: "created" | "status_changed" | "commented";
    payload: unknown;
    occurredAt: number;
    projectId?: string;
  }[],
  pullRequests: Doc<"tickets">["pullRequests"] = [],
) {
  await world.t.run(async (ctx) => {
    const ticket = await ctx.db
      .query("tickets")
      .withIndex("by_uuid", (q) => q.eq("id", world.ticketId))
      .unique();
    await ctx.db.patch(ticket!._id, { status, pullRequests, updatedAt: 100_000 });
    for (const [index, event] of events.entries()) {
      await ctx.db.insert("boardEvents", {
        id: newId("boardEvent"),
        projectId: event.projectId ?? world.projectId,
        ticketId: world.ticketId,
        seq: index + 1,
        kind: event.kind,
        actor: { kind: "person", userId: world.alice.userId },
        occurredAt: event.occurredAt,
        payload: event.payload,
      });
    }
  });
}

describe("runnerContext retention facts", () => {
  test("dates the latest Done dwell by sequence, not an older Done entry or a later edit", async () => {
    const world = await runnerWorld();
    await retentionHistory(world, "done", [
      {
        kind: "created",
        payload: { kind: "created", status: "todo", title: "Ticket" },
        occurredAt: 1,
      },
      {
        kind: "status_changed",
        payload: { kind: "status_changed", from: "todo", to: "done" },
        occurredAt: 300,
      },
      {
        kind: "status_changed",
        payload: { kind: "status_changed", from: "done", to: "doing" },
        occurredAt: 400,
      },
      // Even a clock moving backwards cannot make an older sequence the current dwell.
      {
        kind: "status_changed",
        payload: { kind: "status_changed", from: "doing", to: "done" },
        occurredAt: 200,
      },
      {
        kind: "commented",
        payload: { kind: "commented", commentId: newId("comment") },
        occurredAt: 500,
      },
    ]);
    expect((await context(world)).retention).toEqual({
      doneEntryAt: 200,
      prUrl: null,
      prState: null,
    });
  });

  test("a reopened ticket has no Done dwell", async () => {
    const world = await runnerWorld();
    await retentionHistory(world, "doing", [
      {
        kind: "status_changed",
        payload: { kind: "status_changed", from: "todo", to: "done" },
        occurredAt: 100,
      },
      {
        kind: "status_changed",
        payload: { kind: "status_changed", from: "done", to: "doing" },
        occurredAt: 200,
      },
    ]);
    expect((await context(world)).retention?.doneEntryAt).toBeNull();
  });

  test("a ticket born Done uses its creation event, but missing history never uses createdAt", async () => {
    const world = await runnerWorld();
    await retentionHistory(world, "done", []);
    expect((await context(world)).retention?.doneEntryAt).toBeNull();
    await retentionHistory(world, "done", [
      {
        kind: "created",
        payload: { kind: "created", status: "done", title: "Ticket" },
        occurredAt: 123,
      },
    ]);
    expect((await context(world)).retention?.doneEntryAt).toBe(123);
  });

  test.each([
    { payload: { kind: "status_changed", from: "done", to: "doing" }, occurredAt: 200 },
    { payload: { kind: "status_changed", from: "unknown", to: "done" }, occurredAt: 200 },
    { payload: "unreadable", occurredAt: 200 },
    { payload: { kind: "status_changed", from: "todo", to: "done" }, occurredAt: -1 },
    {
      payload: { kind: "status_changed", from: "todo", to: "done" },
      occurredAt: Number.POSITIVE_INFINITY,
    },
    {
      payload: { kind: "status_changed", from: "todo", to: "done" },
      occurredAt: Number.MAX_SAFE_INTEGER,
    },
  ])("an unverifiable latest transition fails closed: %j", async (latest) => {
    const world = await runnerWorld();
    await retentionHistory(world, "done", [
      {
        kind: "created",
        payload: { kind: "created", status: "done", title: "Ticket" },
        occurredAt: 10,
      },
      {
        kind: "status_changed",
        payload: { kind: "status_changed", from: "todo", to: "done" },
        occurredAt: 100,
      },
      { kind: "status_changed", ...latest },
    ]);
    expect((await context(world)).retention?.doneEntryAt).toBeNull();
  });

  test.each(["open", "merged", "closed"] as const)(
    "returns the observed %s PR metadata",
    async (state) => {
      const world = await runnerWorld();
      const url = "https://github.com/example/repo/pull/1";
      await retentionHistory(
        world,
        "done",
        [],
        [
          {
            projectRepoId: world.projectRepoId,
            url,
            number: 1,
            state,
            mergedAt: null,
          },
        ],
      );
      expect((await context(world)).retention).toEqual({
        doneEntryAt: null,
        prUrl: url,
        prState: state,
      });
    },
  );

  test("any open PR blocks retention even when another repository's PR is merged", async () => {
    const world = await runnerWorld();
    await retentionHistory(
      world,
      "done",
      [],
      [
        {
          projectRepoId: world.projectRepoId,
          url: "https://github.com/example/repo/pull/1",
          number: 1,
          state: "merged",
          mergedAt: 1,
        },
        {
          projectRepoId: newId("projectRepo"),
          url: "https://github.com/example/other/pull/2",
          number: 2,
          state: "open",
          mergedAt: null,
        },
      ],
    );
    expect((await context(world)).retention).toMatchObject({
      prState: "open",
      prUrl: "https://github.com/example/other/pull/2",
    });
  });

  test("retention facts still require current runner-owner membership", async () => {
    const world = await runnerWorld();
    await retentionHistory(world, "done", [
      {
        kind: "created",
        payload: { kind: "created", status: "done", title: "Ticket" },
        occurredAt: 100,
      },
    ]);
    const args = {
      sessionId: newId("session"),
      projectId: world.projectId,
      ticketId: world.ticketId,
    };
    await expect(
      world.outsiderRunner.query(api.runnerContext.forSession, args),
    ).rejects.toMatchObject(code("not_found"));
    await clearMembership(world.t, world.workspaceId, world.alice.userId);
    await expect(world.runner.query(api.runnerContext.forSession, args)).rejects.toMatchObject(
      code("not_found"),
    );
  });
});
