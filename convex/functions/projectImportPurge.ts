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
 *    `v1/m/<moveId>/` (signed ListObjectsV2 and one DELETE per key, sent
 *    from the action), then {@link finish} marks the import `purged`. It
 *    starts no sooner than {@link OBJECTS_AFTER_ABORT_MS} after the abort, so
 *    the uploads the move was signed for have expired and landed.
 *
 * What it never touches: a project that is not this import's hidden one (a
 * committed or visible project, or another Workspace's), any key outside the
 * two prefixes, and `v1/u/`. Every link re-reads the import and the project
 * first: the rows phase runs only while the project row is hidden under this
 * move (`moveState: "importing"`, its Workspace), and the project prefix is
 * deleted only while no project row holds the id at all. A row reached
 * through the project that names another project, or a listed key outside
 * its prefix, stops the purge (`stopped:…` on `purge.error`) instead.
 *
 * Each (re)start mints a run id (`purge.run`) that every link carries; a link
 * of an older run does nothing, and every batch of object deletes is claimed
 * under the current run first, so two runs never delete at once and a run
 * left behind by a restart cannot delete after the move is purged.
 *
 * A link that fails leaves the import `aborting` with the error recorded;
 * {@link resume} (a cron) restarts a purge that failed or made no progress
 * for {@link STALL_MS}, at most {@link MAX_RESTARTS} times in a row without
 * progress (then it stops as `stopped:stalled`). `abort` called again
 * restarts any purge at once.
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
const STEP_MAX_ROWS = 256;
/**
 * About the most bytes one transaction deletes (UTF-8, by {@link approximateSize}).
 * With {@link TAKE} rows of at most 1 MiB read past it, a link stays well
 * inside a transaction's 16 MiB read budget.
 */
const STEP_MAX_BYTES = 2 * 1024 * 1024;
/** Rows read per index query. */
const TAKE = 4;
/** Audit rows read per audit-phase transaction. */
const AUDIT_PAGE = 256;
/** Pages of keys one `objects` run deletes before it schedules the next. */
const OBJECT_PAGES_PER_RUN = 10;
/** Deletes in flight at once: one claimed batch. */
const DELETE_BATCH = 8;
/** A purge with no progress for this long is restarted by {@link resume}. */
const STALL_MS = 10 * 60 * 1000;
/** Restarts in a row without progress before {@link resume} gives up. */
const MAX_RESTARTS = 5;
/**
 * How long after the abort the objects phase waits: every upload URL signed
 * before it has expired (`PRESIGN_EXPIRES_SECONDS`), and an upload begun just
 * before that (at most `moveObjectMaxBytes`, 1 GiB) has had 25 minutes to land.
 */
const OBJECTS_AFTER_ABORT_MS = PRESIGN_EXPIRES_SECONDS * 1000 + 25 * 60 * 1000;

const STOPPED = "stopped:";

function freshPurge(now: number): Purge {
  return {
    run: "",
    phase: "rows",
    auditCursor: null,
    rows: 0,
    objects: 0,
    objectsSkipped: null,
    error: null,
    restarts: 0,
    updatedAt: now,
  };
}

async function importById(ctx: { db: Reader }, moveId: string) {
  return ctx.db
    .query("projectImports")
    .withIndex("by_uuid", (q) => q.eq("id", moveId))
    .unique();
}

/** The import when `run` is its purge's current run, still `aborting`; otherwise `null`. */
async function currentRun(ctx: { db: Reader }, moveId: string, run: string) {
  const row = await importById(ctx, moveId);
  return row !== null && row.status === "aborting" && row.purge?.run === run ? row : null;
}

/**
 * Starts (or restarts) the purge of an `aborting` import under a new run:
 * what `abort` and {@link resume} call. A restart by the cron counts toward
 * {@link MAX_RESTARTS}; one a person asked for (`abort` again) starts over.
 */
export async function schedulePurge(
  ctx: MutationCtx,
  row: ImportRow,
  by: "person" | "cron",
): Promise<void> {
  const now = Date.now();
  const purge = row.purge ?? freshPurge(now);
  const run = crypto.randomUUID();
  await ctx.db.patch(row._id, {
    purge: {
      ...purge,
      run,
      error: null,
      restarts: by === "cron" ? purge.restarts + 1 : 0,
      updatedAt: now,
    },
  });
  await ctx.scheduler.runAfter(0, internal.projectImportPurge.step, { moveId: row.id, run });
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

/** When the objects phase of `row`'s purge may start. */
function objectsNotBefore(row: ImportRow): number {
  return (row.abortedAt ?? row.updatedAt) + OBJECTS_AFTER_ABORT_MS;
}

/**
 * Whether a purge in progress has stalled or failed and should be restarted:
 * no progress for {@link STALL_MS} (an objects phase waiting for its start
 * is not stalled), or a failure that may pass (the store was unreachable). A
 * stop (a row or key that is not the move's) waits for a person.
 */
export function purgeStalled(row: ImportRow, now: number): boolean {
  if (row.status !== "aborting") return false;
  if (row.purge === undefined) return true;
  if (row.purge.error !== null) return !row.purge.error.code.startsWith(STOPPED);
  const since =
    row.purge.phase === "objects"
      ? Math.max(row.purge.updatedAt, objectsNotBefore(row))
      : row.purge.updatedAt;
  return now - since >= STALL_MS;
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

const utf8 = new TextEncoder();

/** About how many bytes a Convex value takes: strings as UTF-8, bytes and 64-bit integers included. */
function approximateSize(value: unknown): number {
  if (value === null || value === undefined || typeof value === "boolean") return 1;
  if (typeof value === "string") return utf8.encode(value).length + 2;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value)) {
    return value.reduce((total: number, item) => total + approximateSize(item), 2);
  }
  let total = 2;
  for (const [key, item] of Object.entries(value as Row)) {
    total += key.length + approximateSize(item);
  }
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
      if (budget.spent) return false;
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
  args: { moveId: v.string(), run: v.string() },
  handler: async (ctx, { moveId, run }) => {
    const row = await currentRun(ctx, moveId, run);
    if (row === null) return { phase: null };
    const purge = row.purge!;
    const now = Date.now();
    const save = (next: Partial<Purge>) =>
      ctx.db.patch(row._id, { purge: { ...purge, ...next, updatedAt: now } });
    const next = async (phase: "rows" | "audit", fields: Partial<Purge>) => {
      await save({ ...fields, phase });
      await ctx.scheduler.runAfter(0, internal.projectImportPurge.step, { moveId, run });
      return { phase };
    };
    const toObjects = async (fields: Partial<Purge>) => {
      await save({ ...fields, phase: "objects", auditCursor: null });
      await ctx.scheduler.runAt(objectsNotBefore(row), internal.projectImportPurge.objects, {
        moveId,
        run,
      });
      return { phase: "objects" as const };
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
        return { phase: "rows" as const };
      }
      const progress = { rows: purge.rows + budget.rows, restarts: 0 };
      return done ? next("audit", { ...progress, auditCursor: null }) : next("rows", progress);
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
      return next("audit", {
        rows: purge.rows + deleted,
        auditCursor: page.continueCursor,
        restarts: 0,
      });
    }
    await ctx.db.delete(project._id);
    return toObjects({ rows: purge.rows + deleted + 1, restarts: 0 });
  },
});

/** Records why a link of `run` failed; the import stays `aborting` until it is restarted. */
export const recordError = internalMutation({
  args: { moveId: v.string(), run: v.string(), code: v.string() },
  handler: async (ctx, { moveId, run, code }) => {
    const row = await currentRun(ctx, moveId, run);
    if (row === null) return;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      purge: { ...row.purge!, error: { code, at: now }, updatedAt: now },
    });
  },
});

/** The prefixes `row`'s objects phase may delete now: the project's only while no project row holds the id. */
async function allowedPrefixes(ctx: { db: Reader }, row: ImportRow): Promise<string[]> {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_uuid", (q) => q.eq("id", row.projectId))
    .unique();
  const prefixes: string[] = [];
  if (project === null && row.purge?.objectsSkipped !== "project_id_taken") {
    prefixes.push(projectPrefix(row.projectId));
  }
  prefixes.push(migrationPrefix(row.id));
  return prefixes;
}

/**
 * What `run`'s objects phase may list, and from when; `null` when it may do
 * nothing (an older run, or the import is not `aborting` in that phase).
 */
export const objectsPlan = internalQuery({
  args: { moveId: v.string(), run: v.string() },
  handler: async (
    ctx,
    { moveId, run },
  ): Promise<{ prefixes: string[]; notBefore: number } | null> => {
    const row = await currentRun(ctx, moveId, run);
    if (row === null || row.purge!.phase !== "objects") return null;
    return { prefixes: await allowedPrefixes(ctx, row), notBefore: objectsNotBefore(row) };
  },
});

/**
 * Claims the next batch of deletes under `prefix` for `run`, and counts the
 * batch before it (`deleted`). Answers `false` (delete nothing) unless `run`
 * is still the purge's current run, in its objects phase, and `prefix` is
 * one it may delete now.
 */
export const claimObjectBatch = internalMutation({
  args: { moveId: v.string(), run: v.string(), prefix: v.string(), deleted: v.number() },
  handler: async (ctx, { moveId, run, prefix, deleted }): Promise<boolean> => {
    const row = await currentRun(ctx, moveId, run);
    if (row === null || row.purge!.phase !== "objects") return false;
    const purge = row.purge!;
    await ctx.db.patch(row._id, {
      purge: {
        ...purge,
        objects: purge.objects + deleted,
        restarts: deleted > 0 ? 0 : purge.restarts,
        updatedAt: Date.now(),
      },
    });
    return (await allowedPrefixes(ctx, row)).includes(prefix);
  },
});

/** A listed key a purge may delete: under its prefix, every segment a real one (`.`/`..`/empty never). */
function deletable(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix) || key.length === prefix.length) return false;
  return key
    .slice(prefix.length)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The objects phase: lists each prefix from its start and deletes what is
 * listed, one claimed batch at a time, until nothing is left; then
 * {@link finish}. Every listed key must be a real key under the prefix it
 * was listed for.
 */
export const objects = internalAction({
  args: { moveId: v.string(), run: v.string() },
  handler: async (ctx, { moveId, run }): Promise<void> => {
    let deleted = 0;
    try {
      const config = objectStoreConfig(process.env);
      if (config === null) {
        // Nothing could have been uploaded without a store (`presignPut` refuses).
        await ctx.runMutation(internal.projectImportPurge.finish, {
          moveId,
          run,
          deleted: 0,
          skipped: "storage_unconfigured",
        });
        return;
      }
      for (let pages = 0; pages < OBJECT_PAGES_PER_RUN; pages += 1) {
        const plan = await ctx.runQuery(internal.projectImportPurge.objectsPlan, { moveId, run });
        if (plan === null) return;
        if (Date.now() < plan.notBefore) {
          await ctx.scheduler.runAt(plan.notBefore, internal.projectImportPurge.objects, {
            moveId,
            run,
          });
          return;
        }
        let page: { prefix: string; keys: string[] } | null = null;
        for (const prefix of plan.prefixes) {
          const keys = await listObjectKeys(config, prefix, S3_LIST_MAX_KEYS).catch(
            (error: unknown) => {
              // A key the list cannot spell is not one a move wrote.
              throw error instanceof URIError ? new PurgeStop("unreadable_key") : error;
            },
          );
          if (keys.length > 0) {
            page = { prefix, keys };
            break;
          }
        }
        if (page === null) {
          await ctx.runMutation(internal.projectImportPurge.finish, {
            moveId,
            run,
            deleted,
            skipped: null,
          });
          return;
        }
        const { prefix, keys } = page;
        if (!keys.every((key) => deletable(key, prefix))) throw new PurgeStop("foreign_key");
        for (let i = 0; i < keys.length; i += DELETE_BATCH) {
          const claimed = await ctx.runMutation(internal.projectImportPurge.claimObjectBatch, {
            moveId,
            run,
            prefix,
            deleted,
          });
          deleted = 0;
          if (!claimed) return;
          const batch = keys.slice(i, i + DELETE_BATCH);
          await Promise.all(batch.map((key) => deleteObject(config, key)));
          deleted = batch.length;
        }
      }
      await ctx.runMutation(internal.projectImportPurge.claimObjectBatch, {
        moveId,
        run,
        prefix: migrationPrefix(moveId),
        deleted,
      });
      await ctx.scheduler.runAfter(0, internal.projectImportPurge.objects, { moveId, run });
    } catch (error) {
      await ctx.runMutation(internal.projectImportPurge.recordError, {
        moveId,
        run,
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
    run: v.string(),
    deleted: v.number(),
    skipped: v.union(v.null(), v.literal("storage_unconfigured")),
  },
  handler: async (ctx, { moveId, run, deleted, skipped }) => {
    const row = await currentRun(ctx, moveId, run);
    if (row === null || row.purge!.phase !== "objects") return;
    const now = Date.now();
    const purge: Purge = {
      ...row.purge!,
      objects: row.purge!.objects + deleted,
      objectsSkipped: row.purge!.objectsSkipped ?? skipped,
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

/** Restarts purges that stalled or failed (a cron); gives up on one that keeps making no progress. */
export const resume = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Few moves are ever cancelled at once; every aborting one is looked at.
    const aborting = await ctx.db
      .query("projectImports")
      .withIndex("by_status", (q) => q.eq("status", "aborting"))
      .collect();
    let restarted = 0;
    for (const row of aborting) {
      if (!purgeStalled(row, now)) continue;
      if (row.purge !== undefined && row.purge.restarts >= MAX_RESTARTS) {
        await ctx.db.patch(row._id, {
          purge: { ...row.purge, error: { code: `${STOPPED}stalled`, at: now }, updatedAt: now },
        });
        continue;
      }
      await schedulePurge(ctx, row, "cron");
      restarted += 1;
    }
    return { restarted };
  },
});
