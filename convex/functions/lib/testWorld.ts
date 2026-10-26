/**
 * A minimal world for tests: a Workspace, its Members, one project with one
 * ticket, and runners owned by the first Member. The functions that create
 * these for real belong to other areas (Workspaces, the board, runner
 * registration); until they all exist, the intake tests seed through here,
 * under `convex-test` directly and on the fixture backend through
 * `testSeed.seedWorld`, which refuses to run on any deployment that does not
 * trust the test issuer.
 */

import { newId } from "@volli/shared/cloud";

import type { MutationCtx } from "../_generated/server";

export interface TestWorld {
  workspaceId: string;
  projectId: string;
  ticketId: string;
  runnerIds: string[];
}

export async function seedTestWorld(
  ctx: Pick<MutationCtx, "db">,
  args: { ownerUserId: string; memberUserIds?: string[]; runners?: number; shareAll?: boolean },
): Promise<TestWorld> {
  const now = Date.now();
  const workspaceId = newId("workspace");
  await ctx.db.insert("workspaces", {
    id: workspaceId,
    name: "Test",
    slug: `test-${workspaceId}`,
    iconKey: null,
    createdByUserId: args.ownerUserId,
    planKey: "free",
    activeMemberCount: 1 + (args.memberUserIds?.length ?? 0),
    createdAt: now,
    deletedAt: null,
    purgeAfter: null,
  });
  for (const [index, userId] of [args.ownerUserId, ...(args.memberUserIds ?? [])].entries()) {
    await ctx.db.insert("workspaceMembers", {
      id: newId("member"),
      workspaceId,
      userId,
      role: index === 0 ? "owner" : "member",
      status: "active",
      billingTier: "free",
      joinedAt: now,
      suspendedAt: null,
      leftAt: null,
      invitedByUserId: null,
    });
  }
  if (args.shareAll) {
    await ctx.db.insert("workspacePolicies", {
      workspaceId,
      shareAll: true,
      whoCanInvite: "members",
      revision: 1,
      updatedAt: now,
      updatedByUserId: args.ownerUserId,
    });
  }
  const projectId = newId("project");
  await ctx.db.insert("projects", {
    id: projectId,
    workspaceId,
    name: "Test",
    description: "",
    iconKey: null,
    colorIndex: 0,
    ticketPrefix: "TS",
    origin: "github",
    shipBehaviour: "pr",
    customShipPrompt: null,
    coAuthorDefault: true,
    countsTowardCap: true,
    createdByUserId: args.ownerUserId,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    purgeAfter: null,
  });
  const ticketId = newId("ticket");
  await ctx.db.insert("tickets", {
    id: ticketId,
    projectId,
    number: 1,
    title: "Ticket",
    status: "todo",
    priority: "medium",
    position: "a0",
    labelIds: [],
    assigneeUserId: null,
    checkoutMode: "worktree",
    preferredHarnessId: "pi",
    branch: null,
    baseBranch: null,
    pullRequests: [],
    retentionKeep: false,
    placeRunnerId: null,
    createdBy: { kind: "person", userId: args.ownerUserId },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    purgeAfter: null,
  });
  const runnerIds: string[] = [];
  for (let index = 0; index < (args.runners ?? 1); index += 1) {
    runnerIds.push(await seedTestRunner(ctx, args.ownerUserId, `runner-${index}`));
  }
  return { workspaceId, projectId, ticketId, runnerIds };
}

export async function seedTestRunner(
  ctx: Pick<MutationCtx, "db">,
  ownerUserId: string,
  name: string,
): Promise<string> {
  const now = Date.now();
  const id = newId("runner");
  await ctx.db.insert("runners", {
    id,
    ownerUserId,
    kind: "mac",
    name,
    status: "online",
    statusReason: null,
    statusChangedAt: now,
    version: "0.3.0",
    platform: { os: "darwin", distro: null, kernel: null, arch: "arm64", glibc: null },
    capabilities: {},
    installMode: "app",
    linkedVia: "desktop",
    linkedAt: now,
    autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
    update: null,
    revokedAt: null,
    createdAt: now,
  });
  return id;
}
