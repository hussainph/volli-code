/** Shared runner identities and cloud-board facts for the context/report suites. */
import { newId, RUNNER_TOKEN_ISSUER } from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { seedTestRunner, seedTestWorld } from "../functions/lib/testWorld";
import { code, setup, signIn, type Tester } from "./board-helpers";

export { code };

export function asRunner(t: Tester, runnerId: string, generation?: number) {
  return t.withIdentity({
    subject: `runner:${runnerId}`,
    issuer: RUNNER_TOKEN_ISSUER,
    ...(generation === undefined ? {} : { gen: generation }),
  });
}

export async function runnerWorld(options: { repo?: boolean } = {}) {
  const t = setup();
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const outsider = await signIn(t, "outsider");
  const seeded = await t.run((ctx) =>
    seedTestWorld(ctx, {
      ownerUserId: alice.userId,
      memberUserIds: [bob.userId],
      runners: 2,
    }),
  );
  const memberRunner = await t.run((ctx) => seedTestRunner(ctx, bob.userId, "bobs-mac"));
  const outsiderRunner = await t.run((ctx) => seedTestRunner(ctx, outsider.userId, "outsider-mac"));
  const projectRepoId = options.repo === false ? seeded.projectId : newId("projectRepo");
  await t.run(async (ctx) => {
    if (options.repo !== false) {
      await ctx.db.insert("projectRepos", {
        id: projectRepoId,
        projectId: seeded.projectId,
        role: "primary",
        position: "a0",
        provider: "none",
        githubRepoId: null,
        installationId: null,
        owner: null,
        name: "test-repo",
        baseBranch: "develop",
        defaultBranchCache: "main",
        dirName: "test-repo",
      });
    }
    await ctx.db.insert("ticketBodies", {
      ticketId: seeded.ticketId,
      body: "The cloud ticket brief.",
      revision: 1,
      updatedBy: { kind: "person", userId: alice.userId },
      updatedAt: 1,
    });
    const ticket = await ctx.db
      .query("tickets")
      .withIndex("by_uuid", (q) => q.eq("id", seeded.ticketId))
      .unique();
    await ctx.db.patch(ticket!._id, { branch: "volli/TS-1-ticket", baseBranch: "develop" });
  });
  const runnerId = seeded.runnerIds[0]!;
  return {
    ...seeded,
    t,
    alice,
    bob,
    outsider,
    runnerId,
    runner: asRunner(t, runnerId),
    nextRunner: asRunner(t, seeded.runnerIds[1]!),
    memberRunner: asRunner(t, memberRunner),
    outsiderRunner: asRunner(t, outsiderRunner),
    projectRepoId,
  };
}

export function copyReport(world: Awaited<ReturnType<typeof runnerWorld>>) {
  return {
    ticketId: world.ticketId,
    projectRepoId: world.projectRepoId,
    kind: "worktree" as const,
    state: "ready" as const,
    branch: "volli/TS-1-ticket",
    baseBranch: "develop",
    headSha: "a".repeat(40),
  };
}

export async function clearMembership(t: Tester, workspaceId: string, userId: string) {
  await t.run(async (ctx) => {
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
      .unique();
    await ctx.db.patch(membership!._id, { status: "suspended", suspendedAt: Date.now() });
  });
}

export async function context(
  world: Awaited<ReturnType<typeof runnerWorld>>,
  sessionId: string = newId("session"),
) {
  return world.runner.query(api.runnerContext.forSession, {
    sessionId,
    projectId: world.projectId,
    ticketId: world.ticketId,
  });
}
