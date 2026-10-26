/** Seeds and sign-ins the board unit suites share (convex-test, no backend). */

import { convexTest } from "convex-test";
import type { GenericMutationCtx } from "convex/server";
import { expect } from "vite-plus/test";

import { newId } from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import type { DataModel } from "../functions/_generated/dataModel.js";
import schema from "../functions/schema";
import { enrollPreview } from "./preview-fixtures";

const modules = import.meta.glob("../functions/**/*.ts");

export type Ctx = GenericMutationCtx<DataModel>;
export function setup() {
  return convexTest(schema, modules);
}

export type Tester = ReturnType<typeof setup>;
/** A tester signed in as someone: it can query and mutate, but not reach the database. */
export type Client = Pick<Tester, "query" | "mutation">;

export function identity(name: string) {
  return { subject: `user:${name}`, issuer: "https://issuer.test" };
}

export function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

/**
 * Signs `name` in, enrolls them for the preview (every product call rechecks the
 * live grant and the accepted agreement), and returns their user id and a
 * client acting as them.
 */
export async function signIn(t: Tester, name: string) {
  const as = t.withIdentity(identity(name));
  const { userId } = await as.mutation(api.accounts.ensureViewer, {});
  await enrollPreview(t, userId);
  return { userId, as };
}

export async function seedWorkspace(
  t: Tester,
  members: { userId: string; status?: "active" | "suspended" | "left" }[],
) {
  return t.run(async (ctx) => {
    const id = newId("workspace");
    await ctx.db.insert("workspaces", {
      id,
      name: "Acme",
      slug: `acme-${id.slice(0, 8)}`,
      iconKey: null,
      createdByUserId: members[0]!.userId,
      planKey: "free",
      activeMemberCount: members.length,
      createdAt: 0,
      deletedAt: null,
      purgeAfter: null,
    });
    for (const member of members) {
      await ctx.db.insert("workspaceMembers", {
        id: newId("member"),
        workspaceId: id,
        userId: member.userId,
        role: "member",
        status: member.status ?? "active",
        billingTier: "free",
        joinedAt: 0,
        suspendedAt: null,
        leftAt: null,
        invitedByUserId: null,
      });
    }
    return id;
  });
}

/** A signed-in member with a fresh Workspace and one project in it. */
export async function boardFixture(t: Tester, name = "alice") {
  const alice = await signIn(t, name);
  const workspaceId = await seedWorkspace(t, [{ userId: alice.userId }]);
  const projectId = newId("project");
  await alice.as.mutation(api.projects.create, {
    commandId: newId("command"),
    workspaceId,
    projectId,
    name: "Volli Code",
    origin: "github",
  });
  return { ...alice, workspaceId, projectId };
}

export async function createTicket(
  as: Client,
  projectId: string,
  fields: {
    title?: string;
    status?: "backlog" | "todo" | "doing" | "needs_review" | "done";
    labels?: string[];
  } = {},
) {
  const ticketId = newId("ticket");
  const reply = await as.mutation(api.board.createTicket, {
    commandId: newId("command"),
    projectId,
    ticketId,
    status: fields.status ?? "todo",
    title: fields.title ?? "A ticket",
    ...(fields.labels === undefined ? {} : { labels: fields.labels }),
  });
  return reply;
}

/** A ticket's row as stored. */
export async function ticketRow(t: Tester, ticketId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("tickets")
      .withIndex("by_uuid", (q) => q.eq("id", ticketId))
      .unique(),
  );
}

export async function projectEvents(t: Tester, projectId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("boardEvents")
      .withIndex("by_project_seq", (q) => q.eq("projectId", projectId))
      .collect(),
  );
}

export async function jobs(t: Tester, ticketId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("runnerJobs")
      .withIndex("by_ticket", (q) => q.eq("ticketId", ticketId))
      .collect(),
  );
}

export async function seedWorkingCopy(
  t: Tester,
  ticket: { ticketId: string; projectId: string },
  fields: {
    runnerId?: string;
    state?: "ready" | "trimmed" | "reclaimed" | "requested" | "failed";
    kind?: "worktree" | "main_checkout";
  } = {},
) {
  return t.run(async (ctx) => {
    const id = newId("workingCopy");
    // By default the copy sits on a runner of the project's creator (a Member).
    const project = await ctx.db
      .query("projects")
      .withIndex("by_uuid", (q) => q.eq("id", ticket.projectId))
      .unique();
    const runnerId = fields.runnerId ?? (await insertRunner(ctx, project!.createdByUserId));
    await ctx.db.insert("workingCopies", {
      id,
      ticketId: ticket.ticketId,
      projectId: ticket.projectId,
      runnerId,
      projectRepoId: newId("projectRepo"),
      kind: fields.kind ?? "worktree",
      state: fields.state ?? "ready",
      failure: null,
      branch: "volli/VC-1-a",
      baseBranch: "main",
      headSha: null,
      upstreamSha: null,
      ahead: 0,
      behind: 0,
      dirty: { files: 0, insertions: 0, deletions: 0, untracked: 0, truncated: false },
      changeSetRevision: null,
      firstRun: { copy: "done", setup: "done" },
      setupRecipeSha: null,
      setupOutcome: null,
      lastResumeAt: null,
      lastResumeBootId: null,
      reportedAt: 0,
      createdAt: 0,
    });
    return { workingCopyId: id, runnerId };
  });
}

export async function seedSession(
  t: Tester,
  ticket: { ticketId: string; projectId: string },
  ownerUserId: string,
  fields: { turnActive?: boolean; intake?: "active" | "released" | null; stopped?: boolean } = {},
) {
  return t.run(async (ctx) => {
    const id = newId("session");
    const runnerId = await insertRunner(ctx, ownerUserId);
    await ctx.db.insert("sessions", {
      id,
      projectId: ticket.projectId,
      ticketId: ticket.ticketId,
      role: "ticket",
      parentSessionId: null,
      ownerUserId,
      origin: { kind: "user" },
      title: null,
      visibility: "shared",
      visibilityReason: "ticket",
      sharedAt: null,
      status: "open",
      turnActive: fields.turnActive ?? true,
      lastTurnOutcome: null,
      signal: null,
      stopped: fields.stopped === true ? { at: 1, reason: null } : null,
      needsUser: false,
      attentionCount: 0,
      placeRunnerId: runnerId,
      model: null,
      usageTotals: {},
      createdAt: 0,
      lastActivityAt: 0,
      deletedAt: null,
      purgeAfter: null,
    });
    const intake = fields.intake === undefined ? "active" : fields.intake;
    if (intake !== null) {
      await ctx.db.insert("sessionIntake", {
        sessionId: id,
        claim: { runnerId, generation: 1 },
        acceptedThrough: 0,
        lastEventId: null,
        lastAcceptedAt: null,
        state: intake,
      });
    }
    return { sessionId: id, runnerId };
  });
}

export async function seedAutomation(
  t: Tester,
  projectId: string,
  armedByUserId: string,
  arm: {
    status?: "backlog" | "todo" | "doing" | "needs_review" | "done";
    deleted?: boolean;
  } | null,
) {
  return t.run(async (ctx) => {
    const automationId = newId("automation");
    const runnerId = await insertRunner(ctx, armedByUserId);
    await ctx.db.insert("automations", {
      id: automationId,
      projectId,
      name: "Review",
      instructions: "Review it",
      runtime: null,
      triggerSpec: null,
      createdBy: { kind: "person", userId: armedByUserId },
      createdAt: 0,
      updatedAt: 0,
      deletedAt: arm?.deleted === true ? 1 : null,
    });
    if (arm !== null) {
      await ctx.db.insert("automationArmings", {
        projectId,
        status: arm.status ?? "needs_review",
        automationId,
        armedByUserId,
        runnerId,
        armedAt: 0,
      });
    }
    return { automationId, runnerId };
  });
}

/** A runner row owned by `ownerUserId`. */
export async function seedRunner(t: Tester, ownerUserId: string) {
  return t.run((ctx) => insertRunner(ctx, ownerUserId));
}

async function insertRunner(ctx: Pick<Ctx, "db">, ownerUserId: string) {
  {
    const id = newId("runner");
    await ctx.db.insert("runners", {
      id,
      ownerUserId,
      kind: "mac",
      name: `mac-${id.slice(0, 4)}`,
      status: "online",
      statusReason: null,
      statusChangedAt: 0,
      version: "0.3.0",
      platform: { os: "macos", distro: null, kernel: null, arch: "arm64", glibc: null },
      capabilities: {},
      installMode: "app",
      linkedVia: "desktop",
      linkedAt: 0,
      autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
      update: null,
      revokedAt: null,
      createdAt: 0,
    });
    return id;
  }
}
