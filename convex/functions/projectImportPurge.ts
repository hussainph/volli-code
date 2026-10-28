/**
 * The purge of an aborted move (`projectImports.abort`): every row the move
 * wrote, and what the backend derived there while it was shown, then its
 * objects, taking the import from `aborting` to `purged`. Once purged, the
 * project id is free and the project can be moved again.
 *
 * A scheduled chain, each link one bounded transaction:
 *
 * 1. **rows**: {@link step} deletes the project's rows by index
 *    (`lib/projectPurge.ts`), at most {@link STEP_MAX_ROWS} rows or about
 *    {@link STEP_MAX_BYTES} per transaction, children before their owner.
 * 2. **audit**: the import's own audit rows (MCP operations), one page of the
 *    Workspace's audit log per transaction, then the project row itself.
 * 3. **objects**: {@link objects} lists and deletes `v1/p/<projectId>/` and
 *    `v1/m/<moveId>/` (signed ListObjectsV2 and DELETE, sent from the
 *    action), then {@link finish} marks the import `purged`. It starts no
 *    sooner than {@link OBJECTS_AFTER_ABORT_MS} after the abort, once every
 *    upload URL the move was given has expired.
 *
 * What it never touches: a project that is not this import's hidden one (a
 * committed or visible project, or another Workspace's), any key outside the
 * two prefixes, and `v1/u/` (a person's kept legacy archive). Every link
 * re-reads the import and the project first: the rows phase runs only while
 * the project row is hidden under this move (`moveState: "importing"`, its
 * Workspace), and the project prefix is deleted only while no project row
 * holds the id at all. A row reached through the project that names another
 * project, or a listed key outside its prefix, stops the purge with an error
 * on the import (`purge.error`) instead.
 *
 * A link that fails leaves the import `aborting` with the error recorded;
 * {@link resume} (a cron) restarts a purge that failed or made no progress
 * for {@link STALL_MS}, and `abort` called again restarts it at once. A stop
 * is restarted only by `abort`.
 */

import { ConvexError, v } from "convex/values";

import { S3_LIST_MAX_KEYS, migrationPrefix, parseId, projectPrefix } from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { audit } from "./lib/audit";
import type { Reader, Row } from "./lib/migrationImport";
import {
  ObjectStoreError,
  PRESIGN_EXPIRES_SECONDS,
  deleteObject,
  listObjectKeys,
  objectStoreConfig,
} from "./lib/objectStore";
import { PROJECT_PURGE, PurgeStop, isImportedAuditRow, type PurgeNode } from "./lib/projectPurge";

type ImportRow = Doc<"projectImports">;
type Purge = NonNullable<ImportRow["purge"]>;

/** The most rows one rows-phase transaction deletes. */
export const STEP_MAX_ROWS = 256;
/** About the most bytes one transaction deletes (each document measured by `approximateSize`). */
export const STEP_MAX_BYTES = 4 * 1024 * 1024;
/** Rows read per index query: a full one stays inside the read budget even at 1 MiB a row. */
const TAKE = 8;
/** Audit rows read per audit-phase transaction. */
const AUDIT_PAGE = 256;
/** Pages of keys one `objects` run deletes before it schedules the next. */
const OBJECT_PAGES_PER_RUN = 10;
/** Deletes in flight at once. */
const DELETE_CONCURRENCY = 8;
/** A purge with no progress for this long is restarted by {@link resume}. */
export const STALL_MS = 10 * 60 * 1000;
/**
 * How long after the abort the objects phase waits: every upload URL signed
 * before it has expired (`PRESIGN_EXPIRES_SECONDS`), with a minute to spare,
 * so no upload lands under a prefix after it was emptied.
 */
export const OBJECTS_AFTER_ABORT_MS = (PRESIGN_EXPIRES_SECONDS + 60) * 1000;

function freshPurge(now: number): Purge {
  return {
    phase: "rows",
    auditCursor: null,
    rows: 0,
    objects: 0,
    objectsSkipped: null,
    error: null,
    updatedAt: now,
  };
}

async function importById(ctx: { db: Reader }, moveId: string) {
  return ctx.db
    .query("projectImports")
    .withIndex("by_uuid", (q) => q.eq("id", moveId))
    .unique();
}

/**
 * Starts (or restarts) the purge of an `aborting` import: what `abort` and
 * {@link resume} call. Returns whether a link was scheduled.
 */
export async function schedulePurge(ctx: MutationCtx, row: ImportRow): Promise<boolean> {
  if (row.status !== "aborting") return false;
  const now = Date.now();
  const purge = row.purge ?? freshPurge(now);
  await ctx.db.patch(row._id, { purge: { ...purge, error: null, updatedAt: now } });
  await ctx.scheduler.runAfter(0, internal.projectImportPurge.step, { moveId: row.id });
  return true;
}

/** A content-free code for why a link failed. A stop (`stopped:…`) is not retried by itself. */
function errorCode(error: unknown): string {
  if (error instanceof PurgeStop) return `${STOPPED}${error.code}`;
  if (error instanceof ObjectStoreError) return `${error.code}:${error.operation}:${error.status}`;
  if (error instanceof ConvexError) {
    const code = (error.data as { code?: unknown } | null)?.code;
    if (typeof code === "string") return code;
  }
  return "failed";
}

const STOPPED = "stopped:";

/**
 * Whether a purge in progress has stalled or failed and should be restarted:
 * no progress for {@link STALL_MS}, or a failure that may pass (the store
 * was unreachable). A stop (a row or key that is not the move's) waits for a
 * person: it would only stop again.
 */
export function purgeStalled(row: ImportRow, now: number): boolean {
  if (row.status !== "aborting") return false;
  if (row.purge === undefined) return true;
  if (row.purge.error !== null) return !row.purge.error.code.startsWith(STOPPED);
  return now - row.purge.updatedAt >= STALL_MS;
}

/** What one rows-phase transaction may still delete. */
class Budget {
  rows = 0;
  private bytes = 0;

  get spent(): boolean {
    return this.rows >= STEP_MAX_ROWS || this.bytes >= STEP_MAX_BYTES;
  }

  take(): number {
    return Math.min(TAKE, STEP_MAX_ROWS - this.rows);
  }

  count(doc: Row): void {
    this.rows += 1;
    this.bytes += approximateSize(doc);
  }
}

/** About how many bytes a Convex value takes (bytes and 64-bit integers included). */
function approximateSize(value: unknown): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === "string") return value.length + 2;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "boolean") return 1;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value))
    return value.reduce((total: number, item) => total + approximateSize(item), 2);
  let total = 2;
  for (const [key, item] of Object.entries(value as Row))
    total += key.length + approximateSize(item);
  return total;
}

/**
 * Deletes `node`'s rows under `owner` (children first), within `budget`.
 * Answers whether none is left. Always reads the first remaining rows, so a
 * link needs no cursor and a repeated link deletes nothing twice.
 */
async function drain(
  ctx: Pick<MutationCtx, "db">,
  node: PurgeNode,
  owner: Row,
  projectId: string,
  budget: Budget,
): Promise<boolean> {
  const value = node.value === undefined ? owner.id : node.value(owner);
  for (;;) {
    if (budget.spent) return false;
    const rows = (await (ctx.db.query(node.table) as any)
      .withIndex(node.index, (q: any) => q.eq(node.field, value))
      .take(node.children === undefined ? budget.take() : 1)) as Row[];
    if (rows.length === 0) return true;
    for (const doc of rows) {
      // Reached through the moved project, so it must be the moved project's.
      if (typeof doc.projectId === "string" && doc.projectId !== projectId) {
        throw new PurgeStop(`foreign_row:${node.table}`);
      }
      for (const child of node.children ?? []) {
        if (!(await drain(ctx, child, doc, projectId, budget))) return false;
      }
      await ctx.db.delete(doc._id as never);
      budget.count(doc);
    }
  }
}

/**
 * The project row when it is this import's hidden one, `null` when no project
 * holds the id, or `"taken"` when another project does (committed, visible,
 * or in another Workspace): the purge then deletes none of its rows and none
 * of its objects.
 */
async function hiddenProject(
  ctx: Pick<MutationCtx, "db">,
  row: ImportRow,
): Promise<Doc<"projects"> | null | "taken"> {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_uuid", (q) => q.eq("id", row.projectId))
    .unique();
  if (project === null) return null;
  const imports = await ctx.db
    .query("projectImports")
    .withIndex("by_project", (q) => q.eq("projectId", row.projectId))
    .collect();
  const ours =
    project.moveState === "importing" &&
    project.workspaceId === row.workspaceId &&
    imports.every((other) => other.status !== "committed");
  return ours ? project : "taken";
}

/** One link of the rows and audit phases. */
export const step = internalMutation({
  args: { moveId: v.string() },
  handler: async (ctx, { moveId }) => {
    const row = await importById(ctx, moveId);
    if (row === null || row.status !== "aborting") return { status: row?.status ?? null };
    const now = Date.now();
    const purge = row.purge ?? freshPurge(now);
    const save = (next: Partial<Purge>) =>
      ctx.db.patch(row._id, { purge: { ...purge, ...next, updatedAt: now } });
    const toObjects = async (next: Partial<Purge>) => {
      await save({ ...next, phase: "objects", auditCursor: null });
      await ctx.scheduler.runAt(objectsNotBefore(row), internal.projectImportPurge.objects, {
        moveId,
      });
      return { status: row.status, phase: "objects" as const };
    };
    if (purge.phase === "objects") return toObjects({});

    const project = await hiddenProject(ctx, row);
    if (project === "taken") return toObjects({ objectsSkipped: "project_id_taken" });
    // No project row: the import never wrote one, or an earlier link deleted
    // it after everything else, so there are no rows left to find.
    if (project === null) return toObjects({});

    if (purge.phase === "rows") {
      const budget = new Budget();
      let done = true;
      try {
        for (const node of PROJECT_PURGE) {
          if (!(await drain(ctx, node, project as unknown as Row, row.projectId, budget))) {
            done = false;
            break;
          }
        }
      } catch (error) {
        if (!(error instanceof PurgeStop)) throw error;
        // What this link deleted before it was the moved project's own; the
        // purge goes no further until someone looks (`resume` leaves it).
        await save({ rows: purge.rows + budget.rows, error: { code: errorCode(error), at: now } });
        return { status: row.status, phase: "rows" as const };
      }
      const rows = purge.rows + budget.rows;
      if (!done) {
        await save({ rows });
        await ctx.scheduler.runAfter(0, internal.projectImportPurge.step, { moveId });
        return { status: row.status, phase: "rows" as const };
      }
      await save({ rows, phase: "audit", auditCursor: null });
      await ctx.scheduler.runAfter(0, internal.projectImportPurge.step, { moveId });
      return { status: row.status, phase: "audit" as const };
    }

    // audit: one page of the Workspace's audit log, then the project row.
    const page = await ctx.db
      .query("auditLog")
      .withIndex("by_workspace_at", (q) => q.eq("workspaceId", row.workspaceId))
      .paginate({
        cursor: purge.auditCursor,
        numItems: AUDIT_PAGE,
        maximumBytesRead: STEP_MAX_BYTES,
      });
    let deleted = 0;
    for (const doc of page.page) {
      if (!isImportedAuditRow(doc as unknown as Row, row)) continue;
      await ctx.db.delete(doc._id);
      deleted += 1;
    }
    if (!page.isDone) {
      await save({ rows: purge.rows + deleted, auditCursor: page.continueCursor });
      await ctx.scheduler.runAfter(0, internal.projectImportPurge.step, { moveId });
      return { status: row.status, phase: "audit" as const };
    }
    await ctx.db.delete(project._id);
    return toObjects({ rows: purge.rows + deleted + 1 });
  },
});

/** Records why a link failed; the import stays `aborting` until {@link resume} or `abort` restarts it. */
export const recordError = internalMutation({
  args: { moveId: v.string(), code: v.string() },
  handler: async (ctx, { moveId, code }) => {
    const row = await importById(ctx, moveId);
    if (row === null || row.status !== "aborting") return;
    const now = Date.now();
    const purge = row.purge ?? freshPurge(now);
    await ctx.db.patch(row._id, {
      purge: { ...purge, error: { code, at: now }, updatedAt: now },
    });
  },
});

/** When the objects phase of `row`'s purge may start. */
function objectsNotBefore(row: ImportRow): number {
  return (row.abortedAt ?? row.updatedAt) + OBJECTS_AFTER_ABORT_MS;
}

/**
 * The prefixes the objects phase may delete now, or `null` when it may delete
 * nothing (the import is not `aborting` in that phase), with when it may
 * start. The project prefix is included only while no project row holds the id.
 */
export const objectPrefixes = internalQuery({
  args: { moveId: v.string() },
  handler: async (ctx, { moveId }): Promise<{ prefixes: string[]; notBefore: number } | null> => {
    const row = await importById(ctx, moveId);
    if (row === null || row.status !== "aborting" || row.purge?.phase !== "objects") return null;
    const project = await ctx.db
      .query("projects")
      .withIndex("by_uuid", (q) => q.eq("id", row.projectId))
      .unique();
    const prefixes: string[] = [];
    if (project === null && row.purge.objectsSkipped !== "project_id_taken") {
      prefixes.push(projectPrefix(row.projectId));
    }
    prefixes.push(migrationPrefix(row.id));
    return { prefixes, notBefore: objectsNotBefore(row) };
  },
});

/** Counts deleted objects, so a long objects phase shows progress (and is not seen as stalled). */
export const objectsProgress = internalMutation({
  args: { moveId: v.string(), deleted: v.number() },
  handler: async (ctx, { moveId, deleted }) => {
    const row = await importById(ctx, moveId);
    if (row?.status !== "aborting" || row.purge === undefined) return;
    await ctx.db.patch(row._id, {
      purge: { ...row.purge, objects: row.purge.objects + deleted, updatedAt: Date.now() },
    });
  },
});

async function inBatches(keys: readonly string[], run: (key: string) => Promise<void>) {
  for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
    await Promise.all(keys.slice(i, i + DELETE_CONCURRENCY).map(run));
  }
}

/**
 * The objects phase: lists each prefix from its start and deletes what is
 * listed, page by page, until nothing is left; then {@link finish}. Every
 * page re-checks which prefixes it may delete, and every listed key must be
 * under the prefix it was listed for.
 */
export const objects = internalAction({
  args: { moveId: v.string() },
  handler: async (ctx, { moveId }): Promise<void> => {
    try {
      const config = objectStoreConfig(process.env);
      if (config === null) {
        // Nothing could have been uploaded without a store (`presignPut` refuses).
        await ctx.runMutation(internal.projectImportPurge.finish, {
          moveId,
          skipped: "storage_unconfigured",
        });
        return;
      }
      for (let pages = 0; pages < OBJECT_PAGES_PER_RUN; pages += 1) {
        const plan = await ctx.runQuery(internal.projectImportPurge.objectPrefixes, { moveId });
        if (plan === null) return;
        if (Date.now() < plan.notBefore) {
          await ctx.scheduler.runAt(plan.notBefore, internal.projectImportPurge.objects, {
            moveId,
          });
          return;
        }
        const { prefixes } = plan;
        let page: { prefix: string; keys: string[] } | null = null;
        for (const prefix of prefixes) {
          const listed = await listObjectKeys(config, prefix, null, S3_LIST_MAX_KEYS);
          if (listed.keys.length > 0) {
            page = { prefix, keys: listed.keys };
            break;
          }
        }
        if (page === null) {
          await ctx.runMutation(internal.projectImportPurge.finish, { moveId, skipped: null });
          return;
        }
        const { prefix, keys } = page;
        if (keys.some((key) => !key.startsWith(prefix))) {
          throw new PurgeStop("foreign_key");
        }
        await inBatches(keys, (key) => deleteObject(config, key));
        await ctx.runMutation(internal.projectImportPurge.objectsProgress, {
          moveId,
          deleted: keys.length,
        });
      }
      await ctx.scheduler.runAfter(0, internal.projectImportPurge.objects, { moveId });
    } catch (error) {
      await ctx.runMutation(internal.projectImportPurge.recordError, {
        moveId,
        code: errorCode(error),
      });
      throw error;
    }
  },
});

/** Marks the purge done: the import is `purged`, and the project id is free again. */
export const finish = internalMutation({
  args: {
    moveId: v.string(),
    skipped: v.union(v.null(), v.literal("storage_unconfigured")),
  },
  handler: async (ctx, { moveId, skipped }) => {
    const row = await importById(ctx, moveId);
    if (row === null || row.status !== "aborting" || row.purge?.phase !== "objects") return;
    const now = Date.now();
    const purge: Purge = {
      ...row.purge,
      objectsSkipped: row.purge.objectsSkipped ?? skipped,
      error: null,
      updatedAt: now,
    };
    await ctx.db.patch(row._id, { status: "purged", updatedAt: now, purgedAt: now, purge });
    await audit(ctx, {
      workspaceId: row.workspaceId,
      // The purge runs for the person who cancelled the move.
      actor: { kind: "person", userId: parseId("user", row.userId) },
      kind: "project.import_purged",
      targetKind: "project",
      targetId: row.projectId,
      at: now,
      detail: {
        moveId: row.id,
        rows: purge.rows,
        objects: purge.objects,
        objectsSkipped: purge.objectsSkipped,
      },
    });
  },
});

/** Restarts purges that stalled or failed (a cron). */
export const resume = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const aborting = await ctx.db
      .query("projectImports")
      .withIndex("by_status", (q) => q.eq("status", "aborting"))
      .take(100);
    let restarted = 0;
    for (const row of aborting) {
      if (purgeStalled(row, now) && (await schedulePurge(ctx, row))) restarted += 1;
    }
    return { restarted };
  },
});
