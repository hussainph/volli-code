import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vite-plus/test";

import { newId } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { RECOVERY_COMMAND_WINDOW, RECOVERY_SIBLING_LIMIT } from "../functions/runnerRecovery";
import { clearMembership, code, runnerWorld, type asRunner } from "./runnerContextFixtures";
import { userProvenance, wire, writeSession } from "./sessionFixtures";

type World = Awaited<ReturnType<typeof runnerWorld>>;
type RunnerClient = ReturnType<typeof asRunner>;

/** Writes a ticket Session and accepts its whole history from `runner`. */
async function sibling(world: World, runner: RunnerClient = world.runner) {
  const written = await writeSession({ projectId: world.projectId, ticketId: world.ticketId });
  await runner.mutation(api.sessions.accept, {
    sessionId: written.sessionId,
    generation: 1,
    events: written.events.map(wire),
  });
  return written;
}

function siblings(world: World, sessionId: string, since: number, ticketId = world.ticketId) {
  return world.runner.query(api.runnerRecovery.ticketSiblings, {
    sessionId,
    projectId: world.projectId,
    ticketId,
    since,
  });
}

describe("runnerRecovery.ticketSiblings", () => {
  test("answers the shared moved-on rule from a sibling's accepted commands", async () => {
    const world = await runnerWorld();
    const other = await sibling(world, world.nextRunner);
    const recovering = newId("session");
    // The sibling's person sent a message after a loss at 0, never after 10^9.
    expect(await siblings(world, recovering, 0)).toEqual({
      siblings: [{ sessionId: other.sessionId, movedOn: true }],
      complete: true,
    });
    expect(await siblings(world, recovering, 1_000_000_000)).toEqual({
      siblings: [{ sessionId: other.sessionId, movedOn: false }],
      complete: true,
    });
    // Nothing a sibling said leaves the backend: one answer per sibling.
    expect(Object.keys((await siblings(world, recovering, 0)).siblings[0]!).toSorted()).toEqual([
      "movedOn",
      "sessionId",
    ]);
  });

  test("a running sibling has moved on whenever its loss was", async () => {
    const world = await runnerWorld();
    const other = await sibling(world, world.nextRunner);
    await world.t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", other.sessionId))
        .unique();
      await ctx.db.patch(row!._id, { turnActive: true });
    });
    expect((await siblings(world, newId("session"), 1_000_000_000)).siblings).toEqual([
      { sessionId: other.sessionId, movedOn: true },
    ]);
  });

  test("leaves out the recovering Session itself and siblings the owner cannot see", async () => {
    const world = await runnerWorld();
    const own = await sibling(world);
    const teammate = await sibling(world, world.memberRunner);
    expect((await siblings(world, own.sessionId, 0)).siblings).toEqual([
      { sessionId: teammate.sessionId, movedOn: true },
    ]);
    await world.t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", teammate.sessionId))
        .unique();
      await ctx.db.patch(row!._id, { visibility: "private" });
    });
    expect((await siblings(world, own.sessionId, 0)).siblings).toEqual([]);
  });

  test("a window the newest commands fill cannot settle an older start", async () => {
    const world = await runnerWorld();
    const written = await writeSession({ projectId: world.projectId, ticketId: world.ticketId });
    // Commands that start nothing, newer than every message the person sent.
    for (let index = 0; index <= RECOVERY_COMMAND_WINDOW; index += 1) {
      await written.engine.submit({
        commandId: randomUUID(),
        sessionId: written.sessionId,
        intent: { kind: "session.signal", signal: "blocked", reason: `wait ${index}` },
        provenance: userProvenance,
      });
    }
    const events = await written.engine.listEvents({ sessionId: written.sessionId });
    for (let index = 0; index < events.length; index += 100) {
      await world.nextRunner.mutation(api.sessions.accept, {
        sessionId: written.sessionId,
        generation: 1,
        events: events.slice(index, index + 100).map(wire),
      });
    }
    const recovering = newId("session");
    expect((await siblings(world, recovering, 0)).siblings).toEqual([
      { sessionId: written.sessionId, movedOn: null },
    ]);
    // A loss older than every command in the window is settled by it.
    expect((await siblings(world, recovering, 1_000_000_000)).siblings).toEqual([
      { sessionId: written.sessionId, movedOn: false },
    ]);
  });

  test("says when more siblings exist than one read judges", async () => {
    const world = await runnerWorld();
    for (let index = 0; index <= RECOVERY_SIBLING_LIMIT; index += 1) {
      await sibling(world, world.nextRunner);
    }
    const reply = await siblings(world, newId("session"), 0);
    expect(reply.complete).toBe(false);
    expect(reply.siblings).toHaveLength(RECOVERY_SIBLING_LIMIT);
  });

  test("a ticketless Session has no siblings, after the same project checks", async () => {
    const world = await runnerWorld();
    await expect(
      world.runner.query(api.runnerRecovery.ticketSiblings, {
        sessionId: newId("session"),
        projectId: world.projectId,
        ticketId: null,
        since: 0,
      }),
    ).resolves.toEqual({ siblings: [], complete: true });
    await expect(
      world.outsiderRunner.query(api.runnerRecovery.ticketSiblings, {
        sessionId: newId("session"),
        projectId: world.projectId,
        ticketId: null,
        since: 0,
      }),
    ).rejects.toMatchObject(code("not_found"));
  });

  test("refuses a Session this runner does not hold, or another owner's", async () => {
    const world = await runnerWorld();
    const own = await sibling(world);
    const args = {
      sessionId: own.sessionId,
      projectId: world.projectId,
      ticketId: world.ticketId,
      since: 0,
    };
    await expect(world.runner.query(api.runnerRecovery.ticketSiblings, args)).resolves.toEqual({
      siblings: [],
      complete: true,
    });
    await expect(
      world.nextRunner.query(api.runnerRecovery.ticketSiblings, args),
    ).rejects.toMatchObject(code("fenced"));
    await expect(
      world.memberRunner.query(api.runnerRecovery.ticketSiblings, args),
    ).rejects.toMatchObject(code("not_your_runner"));
    await expect(
      world.runner.query(api.runnerRecovery.ticketSiblings, { ...args, ticketId: null }),
    ).rejects.toMatchObject(code("invalid_request"));
    await world.t.mutation(internal.sessions.transferClaim, {
      sessionId: own.sessionId,
      toRunnerId: world.runnerIds[1]!,
      headSequence: own.events.length,
    });
    await expect(world.runner.query(api.runnerRecovery.ticketSiblings, args)).rejects.toMatchObject(
      code("fenced"),
    );
  });

  test("refuses an owner who lost membership and a ticket from another project", async () => {
    const world = await runnerWorld();
    await expect(siblings(world, newId("session"), 0, newId("ticket"))).rejects.toMatchObject(
      code("not_found"),
    );
    await clearMembership(world.t, world.workspaceId, world.alice.userId);
    await expect(siblings(world, newId("session"), 0)).rejects.toMatchObject(code("not_found"));
  });

  test("needs a runner", async () => {
    const world = await runnerWorld();
    await expect(
      world.alice.as.query(api.runnerRecovery.ticketSiblings, {
        sessionId: newId("session"),
        projectId: world.projectId,
        ticketId: world.ticketId,
        since: 0,
      }),
    ).rejects.toMatchObject(code("not_a_runner"));
  });
});
