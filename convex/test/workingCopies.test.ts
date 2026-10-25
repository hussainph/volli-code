import { describe, expect, test } from "vite-plus/test";

import { newId } from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { seedTestWorld } from "../functions/lib/testWorld";
import { asRunner, clearMembership, code, copyReport, runnerWorld } from "./runnerContextFixtures";

describe("workingCopies.report", () => {
  test("mints once by (ticket, runner, repo) without a job and preserves richer metadata", async () => {
    const world = await runnerWorld();
    const args = copyReport(world);
    const first = await world.runner.mutation(api.workingCopies.report, args);
    expect(first.workingCopyId).toMatch(/^[0-9a-f-]{36}$/);
    await world.t.run(async (ctx) => {
      const copy = await ctx.db.query("workingCopies").first();
      await ctx.db.patch(copy!._id, {
        ahead: 3,
        dirty: { files: 2, insertions: 4, deletions: 1, untracked: 0, truncated: false },
        firstRun: { copy: "done", setup: "done" },
      });
    });
    expect(
      await world.runner.mutation(api.workingCopies.report, {
        ...args,
        branch: "volli/TS-1-renamed",
        headSha: "b".repeat(40),
        state: "trimmed",
      }),
    ).toEqual(first);
    const copies = await world.t.run((ctx) => ctx.db.query("workingCopies").collect());
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      id: first.workingCopyId,
      ticketId: world.ticketId,
      projectId: world.projectId,
      runnerId: world.runnerId,
      projectRepoId: world.projectRepoId,
      state: "trimmed",
      branch: "volli/TS-1-renamed",
      headSha: "b".repeat(40),
      ahead: 3,
      dirty: { files: 2 },
      firstRun: { copy: "done", setup: "done" },
      reportedAt: expect.any(Number),
    });
    expect(copies[0]).not.toHaveProperty("path");
    expect(await world.t.run((ctx) => ctx.db.query("runnerJobs").collect())).toEqual([]);
  });

  test("another runner reports its own copy, never overwrites a teammate's", async () => {
    const world = await runnerWorld();
    const args = copyReport(world);
    const own = await world.runner.mutation(api.workingCopies.report, args);
    const teammate = await world.memberRunner.mutation(api.workingCopies.report, {
      ...args,
      branch: "bobs-branch",
    });
    const sameOwnerOtherMac = await world.nextRunner.mutation(api.workingCopies.report, args);
    expect(
      new Set([own.workingCopyId, teammate.workingCopyId, sameOwnerOtherMac.workingCopyId]).size,
    ).toBe(3);
    const copies = await world.t.run((ctx) => ctx.db.query("workingCopies").collect());
    expect(copies.find((copy) => copy.id === own.workingCopyId)?.branch).toBe(args.branch);
  });

  test("first folder reports share one durable default repository across runners", async () => {
    const world = await runnerWorld({ repo: false });
    await world.runner.mutation(api.workingCopies.report, copyReport(world));
    await world.nextRunner.mutation(api.workingCopies.report, copyReport(world));
    const repos = await world.t.run((ctx) => ctx.db.query("projectRepos").collect());
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      id: world.projectId,
      projectId: world.projectId,
      role: "primary",
    });
  });

  test("refuses nonmembers and former members even when their copy already exists", async () => {
    const world = await runnerWorld();
    const args = copyReport(world);
    await expect(
      world.outsiderRunner.mutation(api.workingCopies.report, args),
    ).rejects.toMatchObject(code("not_found"));
    await world.runner.mutation(api.workingCopies.report, args);
    await clearMembership(world.t, world.workspaceId, world.alice.userId);
    await expect(world.runner.mutation(api.workingCopies.report, args)).rejects.toMatchObject(
      code("not_found"),
    );
  });

  test("rejects missing and cross-project repositories without creating a copy", async () => {
    const world = await runnerWorld();
    const other = await world.t.run((ctx) =>
      seedTestWorld(ctx, {
        ownerUserId: world.alice.userId,
        runners: 0,
      }),
    );
    await world.runner.mutation(api.projectCheckouts.report, {
      projectId: other.projectId,
      projectRepoId: other.projectId,
      kind: "main",
      headBranch: "main",
    });
    for (const projectRepoId of [other.projectId, newId("projectRepo")]) {
      await expect(
        world.runner.mutation(api.workingCopies.report, {
          ...copyReport(world),
          projectRepoId,
        }),
      ).rejects.toMatchObject(code("invalid_repo"));
    }
    expect(await world.t.run((ctx) => ctx.db.query("workingCopies").collect())).toEqual([]);
  });

  test("requires runner auth and validates ids and bounded git metadata", async () => {
    const world = await runnerWorld();
    const args = copyReport(world);
    await expect(world.t.mutation(api.workingCopies.report, args)).rejects.toMatchObject(
      code("unauthenticated"),
    );
    await expect(world.alice.as.mutation(api.workingCopies.report, args)).rejects.toMatchObject(
      code("not_a_runner"),
    );
    await expect(
      world.runner.mutation(api.workingCopies.report, { ...args, projectRepoId: "invalid" }),
    ).rejects.toThrow();
    await expect(
      world.runner.mutation(api.workingCopies.report, { ...args, branch: "x\nsecret" }),
    ).rejects.toMatchObject(code("invalid_request"));
  });

  test("the first successful report ends the previous credential's grace", async () => {
    const world = await runnerWorld();
    await world.t.run((ctx) =>
      ctx.db.insert("runnerCredentials", {
        runnerId: world.runnerId,
        currentHash: "current",
        previousHash: "previous",
        currentFirstUsedAt: null,
        generation: 2,
        rotatedAt: 1,
        lastUsedAt: 1,
        lastUsedIp: null,
      }),
    );
    await asRunner(world.t, world.runnerId, 2).mutation(
      api.workingCopies.report,
      copyReport(world),
    );
    expect(await world.t.run((ctx) => ctx.db.query("runnerCredentials").first())).toMatchObject({
      currentFirstUsedAt: expect.any(Number),
    });
  });
});
