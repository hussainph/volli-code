import { describe, expect, test } from "vite-plus/test";

import { newId } from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { boardFixture, code, projectEvents, seedWorkspace, setup, signIn } from "./board-helpers";

describe("projects.create", () => {
  test("creates the project, its counter and a project_created event; a retry replays", async () => {
    const t = setup();
    const alice = await signIn(t, "alice");
    const workspaceId = await seedWorkspace(t, [{ userId: alice.userId }]);
    const projectId = newId("project");
    const args = {
      commandId: newId("command"),
      workspaceId,
      projectId,
      name: " Volli Code ",
      origin: "github" as const,
    };
    const first = await alice.as.mutation(api.projects.create, args);
    expect(first).toEqual({
      projectId,
      ticketPrefix: "VC",
      receipt: { commandId: args.commandId, status: "completed", replayed: false },
    });
    const again = await alice.as.mutation(api.projects.create, args);
    expect(again.receipt.replayed).toBe(true);

    await expect(alice.as.query(api.projects.get, { projectId })).resolves.toMatchObject({
      id: projectId,
      workspaceId,
      name: "Volli Code",
      ticketPrefix: "VC",
      colorIndex: 0,
      origin: "github",
      createdByUserId: alice.userId,
      archivedAt: null,
    });
    const counter = await t.run((ctx) =>
      ctx.db
        .query("projectCounters")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .unique(),
    );
    expect(counter).toMatchObject({ nextTicketNumber: 1, boardSeq: 1 });
    expect(await projectEvents(t, projectId)).toEqual([
      expect.objectContaining({
        seq: 1,
        ticketId: null,
        kind: "project_created",
        actor: { kind: "person", userId: alice.userId },
        payload: { kind: "project_created", name: "Volli Code", ticketPrefix: "VC" },
      }),
    ]);
  });

  test("refuses a taken prefix, a taken id, a non-member and a malformed id", async () => {
    const t = setup();
    const { as, workspaceId, projectId } = await boardFixture(t);
    const create = (fields: Record<string, unknown>) =>
      as.mutation(api.projects.create, {
        commandId: newId("command"),
        workspaceId,
        projectId: newId("project"),
        name: "Other",
        origin: "promoted_local",
        ...fields,
      });
    await expect(create({ ticketPrefix: "VC" })).rejects.toThrow(code("prefix_taken"));
    await expect(create({ projectId })).rejects.toThrow(code("id_taken"));
    await expect(create({ projectId: "nope" })).rejects.toThrow(code("invalid_id"));
    await expect(create({ name: "  " })).rejects.toThrow(code("invalid_argument"));
    const bob = await signIn(t, "bob");
    await expect(
      bob.as.mutation(api.projects.create, {
        commandId: newId("command"),
        workspaceId,
        projectId: newId("project"),
        name: "Mine",
        origin: "github",
      }),
    ).rejects.toThrow(code("not_a_member"));
    await expect(bob.as.query(api.projects.list, { workspaceId })).rejects.toThrow(
      code("not_a_member"),
    );
  });
});

describe("projects.rename / archive / unarchive", () => {
  test("record their events once; repeats and unchanged names change nothing", async () => {
    const t = setup();
    const { as, workspaceId, projectId } = await boardFixture(t);
    const cmd = () => ({ commandId: newId("command"), projectId });
    const rename = (name: string) => as.mutation(api.projects.rename, { ...cmd(), name });

    expect(await rename("Volli")).toMatchObject({ changed: true });
    expect(await rename("Volli")).toMatchObject({ changed: false });
    expect(await as.mutation(api.projects.archive, cmd())).toMatchObject({ changed: true });
    expect(await as.mutation(api.projects.archive, cmd())).toMatchObject({ changed: false });
    const [listed] = await as.query(api.projects.list, { workspaceId });
    expect(listed).toMatchObject({
      name: "Volli",
      ticketPrefix: "VC",
      archivedAt: expect.any(Number),
    });
    expect(await as.mutation(api.projects.unarchive, cmd())).toMatchObject({ changed: true });

    const kinds = (await projectEvents(t, projectId)).map((event) => [event.seq, event.kind]);
    expect(kinds).toEqual([
      [1, "project_created"],
      [2, "project_renamed"],
      [3, "project_archived"],
      [4, "project_unarchived"],
    ]);
  });

  test("a suspended member sees and changes nothing", async () => {
    const t = setup();
    const { workspaceId, projectId } = await boardFixture(t);
    const bob = await signIn(t, "bob");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceMembers", {
        id: newId("member"),
        workspaceId,
        userId: bob.userId,
        role: "member",
        status: "suspended",
        billingTier: "free",
        joinedAt: 0,
        suspendedAt: 1,
        leftAt: null,
        invitedByUserId: null,
      });
    });
    await expect(bob.as.query(api.projects.get, { projectId })).rejects.toThrow(
      code("not_a_member"),
    );
    await expect(
      bob.as.mutation(api.projects.rename, { commandId: newId("command"), projectId, name: "X" }),
    ).rejects.toThrow(code("not_a_member"));
  });
});
