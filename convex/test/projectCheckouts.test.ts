import { describe, expect, test } from "vite-plus/test";

import { newId } from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { seedTestWorld } from "../functions/lib/testWorld";
import { asRunner, clearMembership, code, runnerWorld } from "./runnerContextFixtures";

function checkout(world: Awaited<ReturnType<typeof runnerWorld>>) {
  return {
    projectId: world.projectId,
    projectRepoId: world.projectRepoId,
    kind: "main" as const,
    headBranch: "develop",
    headSha: "a".repeat(40),
  };
}

describe("projectCheckouts.report and locate", () => {
  test("upserts its natural key and locates only the calling runner's metadata", async () => {
    const world = await runnerWorld();
    const args = checkout(world);
    expect(
      await world.runner.query(api.projectCheckouts.locate, { projectId: world.projectId }),
    ).toBeNull();
    expect(await world.runner.mutation(api.projectCheckouts.report, args)).toEqual({
      projectRepoId: world.projectRepoId,
    });
    await world.runner.mutation(api.projectCheckouts.report, {
      ...args,
      headBranch: "main",
      headSha: "b".repeat(40),
      kind: "managed_clone",
    });
    const located = await world.runner.query(api.projectCheckouts.locate, {
      projectId: world.projectId,
    });
    expect(located).toMatchObject({
      runnerId: world.runnerId,
      projectId: world.projectId,
      projectRepoId: world.projectRepoId,
      kind: "managed_clone",
      headBranch: "main",
      headSha: "b".repeat(40),
    });
    expect(located).not.toHaveProperty("_id");
    expect(located).not.toHaveProperty("_creationTime");
    expect(located).not.toHaveProperty("path");
    expect(await world.t.run((ctx) => ctx.db.query("projectCheckouts").collect())).toHaveLength(1);
    expect(
      await world.nextRunner.query(api.projectCheckouts.locate, { projectId: world.projectId }),
    ).toBeNull();
    await world.memberRunner.mutation(api.projectCheckouts.report, args);
    expect(await world.t.run((ctx) => ctx.db.query("projectCheckouts").collect())).toHaveLength(2);
    expect(
      (
        await world.runner.query(api.projectCheckouts.locate, {
          projectId: world.projectId,
          projectRepoId: world.projectRepoId,
        })
      )?.headBranch,
    ).toBe("main");
  });

  test("folder reports create the default primary once and older reports preserve a known head", async () => {
    const world = await runnerWorld({ repo: false });
    const args = checkout(world);
    await world.runner.mutation(api.projectCheckouts.report, args);
    await world.nextRunner.mutation(api.projectCheckouts.report, args);
    const { headSha: _ignored, ...older } = args;
    const locate = { projectId: world.projectId, projectRepoId: world.projectRepoId };
    await world.runner.mutation(api.projectCheckouts.report, older);
    expect((await world.runner.query(api.projectCheckouts.locate, locate))?.headSha).toBe(
      args.headSha,
    );
    expect(await world.t.run((ctx) => ctx.db.query("projectRepos").collect())).toHaveLength(1);
    await world.runner.mutation(api.projectCheckouts.report, { ...args, headSha: null });
    expect((await world.runner.query(api.projectCheckouts.locate, locate))?.headSha).toBeNull();
  });

  test("legacy rows lacking headSha are read as null", async () => {
    const world = await runnerWorld();
    await world.t.run((ctx) =>
      ctx.db.insert("projectCheckouts", {
        runnerId: world.runnerId,
        projectId: world.projectId,
        projectRepoId: world.projectRepoId,
        kind: "main",
        headBranch: "develop",
        reportedAt: 1,
      }),
    );
    expect(
      (
        await world.runner.query(api.projectCheckouts.locate, {
          projectId: world.projectId,
        })
      )?.headSha,
    ).toBeNull();
  });

  test("rejects missing or foreign repo ids, and cannot locate a different project's checkout", async () => {
    const world = await runnerWorld();
    await world.runner.mutation(api.projectCheckouts.report, checkout(world));
    const other = await world.t.run((ctx) =>
      seedTestWorld(ctx, {
        ownerUserId: world.alice.userId,
        runners: 0,
      }),
    );
    await expect(
      world.runner.mutation(api.projectCheckouts.report, {
        ...checkout(world),
        projectId: other.projectId,
      }),
    ).rejects.toMatchObject(code("invalid_repo"));
    await expect(
      world.runner.mutation(api.projectCheckouts.report, {
        ...checkout(world),
        projectRepoId: newId("projectRepo"),
      }),
    ).rejects.toMatchObject(code("invalid_repo"));
    expect(
      await world.runner.query(api.projectCheckouts.locate, {
        projectId: other.projectId,
        projectRepoId: world.projectRepoId,
      }),
    ).toBeNull();
  });

  test("requires current membership for both reports and lookups", async () => {
    const world = await runnerWorld();
    await world.runner.mutation(api.projectCheckouts.report, checkout(world));
    for (const runner of [world.outsiderRunner, world.runner]) {
      if (runner === world.runner) {
        await clearMembership(world.t, world.workspaceId, world.alice.userId);
      }
      await expect(
        runner.mutation(api.projectCheckouts.report, checkout(world)),
      ).rejects.toMatchObject(code("not_found"));
      await expect(
        runner.query(api.projectCheckouts.locate, { projectId: world.projectId }),
      ).rejects.toMatchObject(code("not_found"));
    }
  });

  test("both surfaces require runner auth and reports validate git metadata", async () => {
    const world = await runnerWorld();
    await expect(
      world.t.query(api.projectCheckouts.locate, { projectId: world.projectId }),
    ).rejects.toMatchObject(code("unauthenticated"));
    await expect(
      world.alice.as.mutation(api.projectCheckouts.report, checkout(world)),
    ).rejects.toMatchObject(code("not_a_runner"));
    await expect(
      world.runner.mutation(api.projectCheckouts.report, {
        ...checkout(world),
        headBranch: "a".repeat(1025),
      }),
    ).rejects.toMatchObject(code("invalid_request"));
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
      api.projectCheckouts.report,
      checkout(world),
    );
    expect(await world.t.run((ctx) => ctx.db.query("runnerCredentials").first())).toMatchObject({
      currentFirstUsedAt: expect.any(Number),
    });
  });
});
