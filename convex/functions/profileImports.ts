/**
 * The profile step of "Move to Volli Cloud": the moving person's own settings
 * (personal `configEntries`: model defaults, the decision model, compaction,
 * the Code Mode policy, unbound Automations), carried from their local
 * profile once, before the first project moves. `projectImports.importRows`
 * refuses them: they belong to the person, not to a project.
 *
 * Under the person's own sign-in, through the import core the dry run and the
 * project import share (`lib/migrationImport.ts`), so a row is inserted once
 * and a re-sent one answers `unchanged`. A row whose id the person already
 * holds with other content (settings changed since an earlier move) is a
 * `conflict`: the stored one is kept, never overwritten, and the client
 * reports it. Nothing reads personal entries in a cloud launch yet; they are
 * carried, not applied.
 */

import { ConvexError, v } from "convex/values";

import { isUuid, type MigrationTarget } from "@volli/shared/cloud";

import { mutation } from "./_generated/server.js";
import { requireMember } from "./lib/auth";
import { importBatch, type ImportPolicy, type Row } from "./lib/migrationImport";

/** The most rows one batch takes (the client sends at most 200). */
const MAX_ROWS = 500;

/** Whether a stored or new entry is this person's own personal setting. */
function personal(doc: Row, userId: string): boolean {
  return (
    doc.level === "personal" &&
    doc.userId === userId &&
    doc.projectId === null &&
    doc.workspaceId === null
  );
}

/**
 * Imports one batch of the person's personal settings. `workspaceId` and
 * `runnerId` are the move's (a Workspace they are a Member of, a runner of
 * their own): what an exported row's placeholders resolve to. A personal row
 * names neither, so one that does is refused as not the person's.
 */
export const importPersonalSettings = mutation({
  args: { workspaceId: v.string(), runnerId: v.string(), rows: v.array(v.any()) },
  handler: async (ctx, { workspaceId, runnerId, rows }) => {
    const { viewer } = await requireMember(ctx, workspaceId);
    if (rows.length > MAX_ROWS) {
      throw new ConvexError({
        code: "invalid_argument",
        message: `A batch holds at most ${MAX_ROWS} rows.`,
      });
    }
    const runner = isUuid(runnerId)
      ? await ctx.db
          .query("runners")
          .withIndex("by_uuid", (q) => q.eq("id", runnerId))
          .unique()
      : null;
    if (
      runner === null ||
      runner.ownerUserId !== viewer.userId ||
      runner.revokedAt !== null ||
      runner.status === "revoked"
    ) {
      throw new ConvexError({
        code: "runner_unavailable",
        message: "That runner is not one of yours.",
      });
    }
    const target: MigrationTarget = { userId: viewer.userId, workspaceId, runnerId };
    const policy: ImportPolicy = {
      owns: async (_stream, doc) => personal(doc, viewer.userId),
      foreign: async () => ({ code: "conflict", detail: "another person's setting has this id" }),
      outside: { code: "not_personal", detail: "it is not one of the person's own settings" },
      // Written by the person themself: a setting names no one else as its author.
      async check(_stream, doc) {
        const by = doc.updatedBy as { kind?: unknown; userId?: unknown } | null;
        return by?.kind === "person" && by.userId === viewer.userId
          ? null
          : { code: "foreign_identity", detail: "updatedBy names someone other than the person" };
      },
    };
    return importBatch(ctx, { target, stream: "configEntries", rows }, policy);
  },
});
