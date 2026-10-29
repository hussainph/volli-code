/**
 * The SQLite → Volli Cloud migration's backend side: internal functions the
 * importer calls with the deployment's admin key, never a client.
 *
 * - {@link begin} checks (or, for a dry run, creates) the person, Workspace
 *   and runner an import lands under.
 * - {@link importRows} writes one batch of one export stream through the
 *   import core it shares with the person-authorized `projectImports.*`
 *   (`lib/migrationImport.ts`): each record mapped by `migrationDocument`
 *   from `@volli/shared/cloud` (the same function the verifier applies on its
 *   side), a new row inserted, an existing row with the same digest left
 *   alone, and one with a different digest reported as a conflict and never
 *   overwritten. A re-run is therefore idempotent.
 * - {@link readPage} pages one table back out, and {@link readSessionEvents}
 *   reads one Session's events by index, both scoped to the target, for the
 *   verifier's counts and digests.
 *
 * Every row an import writes must belong to a project of the target
 * Workspace; an id that already exists elsewhere is a conflict, the "already
 * migrated" case (§6.10.5). Reports name fields and codes, never values: a
 * migration report must be safe to paste.
 */

import { ConvexError, v } from "convex/values";

import {
  DEFAULT_WORKSPACE_POLICY,
  MIGRATION_IMPORT_STREAMS,
  isUuid,
  newId,
  type MigrationImportStream,
  type MigrationTarget,
} from "@volli/shared/cloud";

import { internalMutation, internalQuery } from "./_generated/server.js";
import {
  ProjectScope,
  importBatch,
  withoutSystemFields,
  type ImportRowsResult,
  type Reader,
  type Row,
} from "./lib/migrationImport";
import { literals, nullable } from "./lib/validators";

const targetValidator = v.object({
  userId: v.string(),
  workspaceId: v.string(),
  runnerId: v.string(),
});
const streamValidator = literals(MIGRATION_IMPORT_STREAMS);

function migrationError(
  code: string,
  message: string,
): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

/** Whether a row belongs to the target: its project is the target's, its Workspace (projects, audit) or its person (personal settings). */
async function ownedByTarget(
  scope: ProjectScope,
  target: MigrationTarget,
  stream: MigrationImportStream,
  doc: Row,
): Promise<boolean> {
  if (stream === "auditLog" || stream === "projects") {
    return doc.workspaceId === target.workspaceId;
  }
  // A personal setting belongs to the person, not to a project.
  if (stream === "configEntries" && doc.level === "personal") {
    return doc.userId === target.userId && doc.projectId === null;
  }
  return (await scope.workspaceOf(await scope.of(stream, doc))) === target.workspaceId;
}

async function requireTarget(db: Reader, target: MigrationTarget): Promise<void> {
  for (const [field, value] of Object.entries(target)) {
    if (!isUuid(value)) throw migrationError("invalid_target", `${field} is not a canonical UUID`);
  }
  const user = await db
    .query("users")
    .withIndex("by_uuid", (q) => q.eq("id", target.userId))
    .unique();
  if (user === null || user.status !== "active") {
    throw migrationError("invalid_target", "the migrating person has no active account");
  }
  const workspace = await db
    .query("workspaces")
    .withIndex("by_uuid", (q) => q.eq("id", target.workspaceId))
    .unique();
  if (workspace === null || workspace.deletedAt !== null) {
    throw migrationError("invalid_target", "the target Workspace does not exist");
  }
  const member = await db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", target.workspaceId).eq("userId", target.userId),
    )
    .unique();
  if (member === null || member.status !== "active" || member.role === "member") {
    throw migrationError(
      "invalid_target",
      "the migrating person does not manage the target Workspace",
    );
  }
  const runner = await db
    .query("runners")
    .withIndex("by_uuid", (q) => q.eq("id", target.runnerId))
    .unique();
  if (runner === null || runner.ownerUserId !== target.userId || runner.revokedAt !== null) {
    throw migrationError("invalid_target", "the target runner is not the migrating person's");
  }
}

/**
 * Checks the import target. With `createMissing` (a dry run against a fresh
 * deployment) it first creates whichever of the person, their Workspace and
 * this Mac's runner row is absent, with the ids given. A real migration runs
 * after sign-in, Workspace creation and runner linking, which own those rows,
 * and passes `createMissing: false`.
 */
export const begin = internalMutation({
  args: {
    target: targetValidator,
    createMissing: v.boolean(),
    displayName: v.string(),
    runnerName: v.string(),
  },
  handler: async (ctx, { target, createMissing, displayName, runnerName }) => {
    const created: string[] = [];
    if (createMissing) {
      // Only a test deployment (one that trusts the test issuer) may mint
      // people, Workspaces and runners this way.
      if (!process.env.VOLLI_TEST_JWKS) {
        throw migrationError("not_a_test_deployment", "createMissing is for test deployments only");
      }
      for (const [field, value] of Object.entries(target)) {
        if (!isUuid(value))
          throw migrationError("invalid_target", `${field} is not a canonical UUID`);
      }
      const now = Date.now();
      const db = ctx.db;
      if (
        (await db
          .query("users")
          .withIndex("by_uuid", (q) => q.eq("id", target.userId))
          .unique()) === null
      ) {
        await db.insert("users", {
          id: target.userId,
          primaryEmail: null,
          emailVerified: false,
          displayName,
          avatarKey: null,
          status: "active",
          deletionRequestedAt: null,
          purgeAfter: null,
          trialSeededWorkspaceId: null,
          createdAt: now,
          lastSeenAt: now,
        });
        created.push("user");
      }
      if (
        (await db
          .query("workspaces")
          .withIndex("by_uuid", (q) => q.eq("id", target.workspaceId))
          .unique()) === null
      ) {
        await db.insert("workspaces", {
          id: target.workspaceId,
          name: displayName,
          slug: `migration-${target.workspaceId}`,
          iconKey: null,
          createdByUserId: target.userId,
          planKey: "free",
          activeMemberCount: 1,
          createdAt: now,
          deletedAt: null,
          purgeAfter: null,
        });
        await db.insert("workspacePolicies", {
          workspaceId: target.workspaceId,
          ...DEFAULT_WORKSPACE_POLICY,
          revision: 0,
          updatedByUserId: target.userId,
          updatedAt: now,
        });
        await db.insert("workspaceMembers", {
          id: newId("member"),
          workspaceId: target.workspaceId,
          userId: target.userId,
          role: "owner",
          status: "active",
          billingTier: "free",
          joinedAt: now,
          suspendedAt: null,
          leftAt: null,
          invitedByUserId: null,
        });
        created.push("workspace");
      }
      if (
        (await db
          .query("runners")
          .withIndex("by_uuid", (q) => q.eq("id", target.runnerId))
          .unique()) === null
      ) {
        await db.insert("runners", {
          id: target.runnerId,
          ownerUserId: target.userId,
          kind: "mac",
          name: runnerName,
          status: "offline",
          statusReason: null,
          statusChangedAt: now,
          version: "migration",
          platform: { os: "darwin", distro: null, kernel: null, arch: "unknown", glibc: null },
          capabilities: {},
          installMode: "app",
          linkedVia: "desktop",
          linkedAt: now,
          autoUpdate: { enabled: false, channel: "stable", pinnedVersion: null },
          update: null,
          revokedAt: null,
          createdAt: now,
        });
        created.push("runner");
      }
    }
    await requireTarget(ctx.db, target);
    return { created };
  },
});

/** Writes one batch of `stream`. Rows are independent: one refusal does not stop the rest. */
export const importRows = internalMutation({
  args: { target: targetValidator, stream: streamValidator, rows: v.array(v.any()) },
  handler: async (ctx, { target, stream, rows }): Promise<ImportRowsResult> => {
    await requireTarget(ctx.db, target);
    const scope = new ProjectScope(ctx.db);
    return importBatch(
      ctx,
      { target, stream, rows },
      {
        owns: (rowStream, doc) => ownedByTarget(scope, target, rowStream, doc),
        // Another Workspace's row with this key came from another copy of the profile.
        foreign: async () => ({
          code: "already_migrated",
          detail: "another Workspace holds this row",
        }),
        outside: {
          code: "outside_target",
          detail: "its project is not in the target Workspace",
        },
      },
    );
  },
});

/**
 * One page of `stream`'s table, without Convex's own fields, limited to rows
 * of the target Workspace. A page may hold fewer rows than asked for (rows of
 * other Workspaces are skipped, and `maximumBytesRead` bounds large rows).
 */
export const readPage = internalQuery({
  args: {
    target: targetValidator,
    stream: streamValidator,
    cursor: nullable(v.string()),
    numItems: v.number(),
    maximumBytesRead: v.optional(v.number()),
  },
  handler: async (ctx, { target, stream, cursor, numItems, maximumBytesRead }) => {
    const page = await (ctx.db.query(stream) as any).paginate({
      cursor,
      numItems,
      ...(maximumBytesRead === undefined ? {} : { maximumBytesRead }),
    });
    const scope = new ProjectScope(ctx.db);
    const rows: Row[] = [];
    for (const doc of page.page as Row[]) {
      const row = withoutSystemFields(doc);
      if (await ownedByTarget(scope, target, stream, row)) rows.push(row);
    }
    return { rows, continueCursor: page.continueCursor as string, isDone: page.isDone as boolean };
  },
});

/**
 * One Session's events after `afterSequence`, in sequence order, through the
 * `(sessionId, sequence)` index. The verifier reads `sessionEvents` this way:
 * a ranged read stays cheap however large the table grows, where paging the
 * whole table does not.
 */
export const readSessionEvents = internalQuery({
  args: {
    target: targetValidator,
    sessionId: v.string(),
    afterSequence: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { target, sessionId, afterSequence, limit }) => {
    const scope = new ProjectScope(ctx.db);
    if (!(await ownedByTarget(scope, target, "sessionIntake", { sessionId }))) {
      return { rows: [] as Row[] };
    }
    const docs = await ctx.db
      .query("sessionEvents")
      .withIndex("by_session_sequence", (q) =>
        q.eq("sessionId", sessionId).gt("sequence", afterSequence),
      )
      .take(limit);
    return { rows: docs.map((doc) => withoutSystemFields(doc as Row)) };
  },
});

/** Operator-only cleanup of the harness's disposable Workspace, AFTER the
 * normal project-import purge has removed every row and object. Never a
 * generic Workspace deletion door; staging must explicitly opt in.
 * One bounded page per call. The harness retries until done.
 */
export const cleanupRehearsal = internalMutation({
  args: { workspaceId: v.string(), userId: v.string(), checkOnly: v.optional(v.boolean()) },
  handler: async (ctx, { workspaceId, userId, checkOnly }): Promise<{ done: boolean }> => {
    if (process.env.VOLLI_MIGRATION_REHEARSAL !== "enabled")
      throw migrationError("rehearsal_disabled", "Enable rehearsal cleanup on staging first.");
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_uuid", (q) => q.eq("id", workspaceId))
      .unique();
    if (workspace === null) return { done: true };
    if (
      workspace.name !== `migration-rehearsal-${workspaceId}` ||
      workspace.createdByUserId !== userId
    )
      throw migrationError("not_rehearsal", "Only a fresh rehearsal Workspace can be removed.");
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId))
      .take(2);
    if (members.length > 1 || members.some((member) => member.userId !== userId))
      throw migrationError("shared_workspace", "A shared Workspace is not disposable.");
    if (
      await ctx.db
        .query("workspaceInvites")
        .withIndex("by_workspace_email", (q) => q.eq("workspaceId", workspaceId))
        .first()
    )
      throw migrationError("invites_remain", "A rehearsal Workspace must not be shared.");
    // A rehearsal creates no Workspace-level resources. Refuse rather than
    // orphan anything an operator added during the manual hold.
    const extras = await Promise.all([
      ctx.db
        .query("legalHolds")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .first(),
      ctx.db
        .query("billingAccounts")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .first(),
      ctx.db
        .query("workspaceBlobs")
        .withIndex("by_workspace_sha", (q) => q.eq("workspaceId", workspaceId))
        .first(),
      ctx.db
        .query("secretKeys")
        .withIndex("by_owner", (q) => q.eq("owner", `w:${workspaceId}`))
        .first(),
      ctx.db
        .query("secrets")
        .withIndex("by_scope_name", (q) => q.eq("scopeKey", `w:${workspaceId}`))
        .first(),
      ctx.db
        .query("configEntries")
        .withIndex("by_scope_kind_name", (q) => q.eq("scopeKey", `w:${workspaceId}`))
        .first(),
    ]);
    if (extras.some(Boolean))
      throw migrationError(
        "workspace_extended",
        "Remove added Workspace resources through their own lifecycle first.",
      );
    // This is a shape/opt-in check before uncommit, not permission to delete
    // projects. The deletion call below still requires the imports purged.
    if (checkOnly) return { done: false };
    if (
      await ctx.db
        .query("projects")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .first()
    )
      throw migrationError("projects_remain", "Purge the rehearsal imports first.");
    const move = await ctx.db
      .query("projectImports")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .first();
    if (move) {
      if (move.status !== "purged")
        throw migrationError("purge_incomplete", "Wait for the normal import purge.");
      for (const stream of await ctx.db
        .query("projectImportStreams")
        .withIndex("by_move_stream", (q) => q.eq("moveId", move.id))
        .take(100))
        await ctx.db.delete(stream._id);
      await ctx.db.delete(move._id);
      return { done: false };
    }
    const audits = await ctx.db
      .query("auditLog")
      .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId))
      .take(100);
    for (const row of audits) await ctx.db.delete(row._id);
    if (audits.length === 100) return { done: false };
    const policy = await ctx.db
      .query("workspacePolicies")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (policy) await ctx.db.delete(policy._id);
    for (const member of members) await ctx.db.delete(member._id);
    await ctx.db.delete(workspace._id);
    return { done: true };
  },
});
