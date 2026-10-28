/**
 * The move engine: "Move to Volli Cloud" for one project or every project of
 * the profile, as a durable queue of per-project moves run one after another
 * Each move is the unit of safety: its own freeze, export, upload,
 * import, verification, commit and roll back, so a project that fails rolls
 * back alone and the local copy is exactly as it was (it was never edited).
 *
 * The step machine (`states.ts`) is journaled in `cloud_moves`: a move's
 * state is the last step that completed, and resuming runs the step after
 * it. Every step is idempotent against the backend (`begin` by move id,
 * write-once object keys, `importRows` answering `unchanged`, `commit`
 * answering `committed`) and against this Mac (upserts by id), so a crash,
 * a quit or a lost network anywhere resumes by running the step again.
 *
 * What stops a move, and how:
 *
 * - **Waiting** (`paused`): a project with a live turn or shell (the queue
 *   moves on and comes back once), the network (retried with backoff, then
 *   paused), a full disk, nobody or someone else signed in, a previous move
 *   of the project still being purged. Nothing is undone; the move resumes.
 * - **A problem** (rolled back): a row the mapping or the backend refuses, a
 *   check that does not match, a project already in another Workspace. The
 *   cloud copy is aborted (and purged by the backend), the local project
 *   unfrozen, the failure recorded with codes and counts.
 * - **Moved again**: the move's runner replaced (`runner_unavailable`, or
 *   this Mac signed in as another runner), or this build's mapper changed
 *   after the reservation: the move rolls back and a fresh move of the same
 *   project joins the queue in its place (`supersedes`), waiting for the
 *   purge if it needs the project id.
 *
 * After the commit the project is visible in Volli Cloud and the move rests
 * at `committed`, read-only here, until the person rolls it back. The steps
 * after it (the handover, the real-path check, Finish move and Go back to
 * local) are composed on top of these (`README.md`).
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import {
  MIGRATION_IMPORT_STREAMS,
  jsonBytes,
  migrationKey,
  type MigrationTarget,
} from "@volli/shared/cloud";

import { blobFilePath } from "../blob-store";
import { prepared } from "../db/prepared";
import { MigrationExportError, isDiskFullError } from "../migration-export/errors";
import type { MigrationExportManifest } from "../migration-export/exporter";
import { MAPPER_VERSION, MANIFEST_FILE } from "../migration-export/staging";
import { verifyMigrationExport } from "../migration-export/verify";
import {
  MoveBackendError,
  MoveNetworkError,
  importCalls,
  refusalOf,
  withRetry,
  type ImportCalls,
} from "./backend";
import {
  MoveStateConflictError,
  sqliteMoveJournal,
  type MoveFailure,
  type MoveJournalStore,
  type MovePause,
  type MoveRow,
  type QueueRow,
} from "./journal";
import {
  MovePlanError,
  fileSha256,
  importRecords,
  moveManifest,
  movePlan,
  type MovePlan,
  type RecordContext,
} from "./plan";
import type { MoveEnginePorts, MoveObject, MoveObjectStore } from "./ports";
import { COMMITTED_STATES, SETTLED_STATES, reached, type MoveState } from "./states";
import { pool, verifyHiddenImport, type VerifyReport } from "./verify";

type Row = Record<string, unknown>;

/** Per-batch bounds, well inside a mutation's argument, write and time limits. */
const BATCH_MAX_ROWS = 200;
const BATCH_MAX_BYTES = 3 * 1024 * 1024;
const OBJECT_CONCURRENCY = 4;
const ZSTD_LEVEL = { params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } };
/** Retries of one call the network lost before the move pauses. */
const RETRY = { attempts: 6, baseMs: 1_000, maxMs: 30_000 };

/**
 * Where a move waits for the person, not for the engine: shown in Volli
 * Cloud (`committed`, `checked`), finished (`confirmed`), or going back to
 * local (`returning`, which only the person's own call drives).
 */
const RESTING_STATES: ReadonlySet<MoveState> = new Set<MoveState>([
  "committed",
  "checked",
  "confirmed",
  "returning",
]);

/**
 * Waits that are this project's alone: the queue goes on with the next
 * project and comes back once at its end (a live turn, a purge of the
 * project's previous move), so one project never holds up the others.
 */
const WAITS_FOR_OTHERS: ReadonlySet<MovePause | null> = new Set<MovePause | null>([
  "not_idle",
  "waiting_for_purge",
]);

/** A file of this Mac's own the move reads is gone or unreadable: a problem, never the network. */
const LOCAL_FILE_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EISDIR",
  "ENOTDIR",
  "EIO",
]);
function isLocalFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && LOCAL_FILE_CODES.has(code);
}

/** A step that must wait, not fail. */
class MovePausedError extends Error {
  constructor(readonly reason: MovePause) {
    super(reason);
    this.name = "MovePausedError";
  }
}

/** A step that found a problem: the move rolls back with this failure. */
export class MoveProblemError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "MoveProblemError";
    this.code = code;
    this.detail = detail;
  }
}

/** A step that found the move must start over under a new move id. */
class MoveAgainError extends Error {
  constructor(
    readonly code: "runner_replaced" | "app_updated" | "export_changed",
    message: string,
  ) {
    super(message);
    this.name = "MoveAgainError";
  }
}

export interface EnqueueInput {
  projectIds: readonly string[];
  target: MigrationTarget;
  /** Default: on for a single project and for the profile's first "Move all", off afterwards. */
  stopAtFirstProblem?: boolean;
  includeRemoved?: boolean;
  /** Projects that go last (the one the person works in). */
  lastProjectIds?: readonly string[];
}

/** How a run of a queue ended. */
export type QueueOutcome =
  | { kind: "done" }
  /** Stopped at a problem (stop at first problem). */
  | { kind: "stopped"; moveId: string }
  /** Waiting: the network, the disk, sign-in, a purge, or a project not idle. */
  | { kind: "waiting"; moveId: string; reason: MovePause };

export interface MoveEngine {
  enqueue(input: EnqueueInput): { queue: QueueRow; moves: MoveRow[] };
  /** Runs a queue until it is done, stopped or waiting. */
  run(queueId: string, signal?: AbortSignal): Promise<QueueOutcome>;
  /** Runs every queue a launch finds still running, oldest first. */
  resume(signal?: AbortSignal): Promise<void>;
  /** Lets a queue stopped at a problem go on with its next project. */
  proceed(queueId: string): void;
  /** Rolls a move back: before the commit, or after it (uncommit first). */
  rollBack(
    moveId: string,
    options?: { confirmChanged?: boolean; signal?: AbortSignal },
  ): Promise<MoveRow>;
  queue(queueId: string): { queue: QueueRow; moves: MoveRow[] } | null;
  journal: MoveJournalStore;
}

/** The exported project's size: what "smallest first" orders by. */
function projectWeight(db: MoveEnginePorts["db"], projectId: string): number {
  const row = prepared<[string, string, string], { weight: number }>(
    db,
    `SELECT (SELECT COUNT(*) FROM tickets WHERE project_id = ?)
          + (SELECT COUNT(*) FROM session_events e JOIN sessions s ON s.id = e.session_id
              WHERE s.project_id = ?)
          + (SELECT COUNT(*) FROM sessions WHERE project_id = ?) AS weight`,
  ).get(projectId, projectId, projectId);
  return row?.weight ?? 0;
}

/**
 * The queue's order: smallest first, a delegation's parent project
 * before its child's when both move, the named projects last.
 */
export function queueOrder(
  db: MoveEnginePorts["db"],
  projectIds: readonly string[],
  last: ReadonlySet<string>,
): string[] {
  const selected = new Set(projectIds);
  const weight = new Map(projectIds.map((id) => [id, projectWeight(db, id)]));
  const parents = new Map<string, Set<string>>();
  for (const row of prepared<[], { child: string; parent: string }>(
    db,
    `SELECT DISTINCT c.project_id AS child, p.project_id AS parent
       FROM session_delegations d
       JOIN sessions c ON c.id = d.session_id
       JOIN sessions p ON p.id = d.parent_session_id
      WHERE c.project_id <> p.project_id`,
  ).all()) {
    if (!selected.has(row.child) || !selected.has(row.parent)) continue;
    let set = parents.get(row.child);
    if (set === undefined) parents.set(row.child, (set = new Set()));
    set.add(row.parent);
  }
  const sorted = [...projectIds].toSorted(
    (a, b) =>
      Number(last.has(a)) - Number(last.has(b)) ||
      weight.get(a)! - weight.get(b)! ||
      (a < b ? -1 : 1),
  );
  const out: string[] = [];
  const placing = new Set<string>();
  const place = (id: string) => {
    if (out.includes(id) || placing.has(id)) return;
    placing.add(id);
    for (const parent of parents.get(id) ?? [])
      if (!last.has(parent) || last.has(id)) place(parent);
    out.push(id);
  };
  for (const id of sorted) place(id);
  return out;
}

function targetOf(move: MoveRow): MigrationTarget {
  return { userId: move.userId, workspaceId: move.workspaceId, runnerId: move.runnerId };
}

export function createMoveEngine(ports: MoveEnginePorts): MoveEngine {
  const now = ports.now ?? Date.now;
  const newId = ports.newId ?? randomUUID;
  const sleep =
    ports.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", aborted);
          resolve();
        }, ms);
        signal.addEventListener("abort", aborted, { once: true });
      }));
  const fault = async (point: string) => {
    await ports.faults?.(point);
  };
  const log = ports.log ?? { info() {}, warn() {} };
  const journal = sqliteMoveJournal(ports.db, {
    now,
    appVersion: ports.appVersion,
    mapperVersion: MAPPER_VERSION,
  });
  const calls: ImportCalls = importCalls(ports.backend, {
    ...RETRY,
    sleep,
    onRetry: (attempt, error) => log.warn("a move call will be retried", { attempt, error }),
  });
  const maintenance = <T>(work: () => Promise<T>) =>
    ports.maintenance === undefined ? work() : ports.maintenance(work);

  const workDir = (move: MoveRow) => join(ports.workRoot, move.moveId);
  const exportDir = (move: MoveRow) => join(workDir(move), "export");

  const manifestOf = async (move: MoveRow): Promise<MigrationExportManifest> =>
    JSON.parse(
      await readFile(join(exportDir(move), MANIFEST_FILE), "utf8"),
    ) as MigrationExportManifest;

  const planOf = async (move: MoveRow, signal: AbortSignal): Promise<MovePlan> =>
    movePlan({
      workDir: workDir(move),
      exportDir: exportDir(move),
      manifest: await manifestOf(move),
      exportManifestSha256: move.journal.exportManifestSha256!,
      target: targetOf(move),
      eventRecord: (record) => ports.history.eventRecord(record),
      signal,
    });

  const recordContext = async (move: MoveRow, plan: MovePlan): Promise<RecordContext> => ({
    exportDir: exportDir(move),
    manifest: await manifestOf(move),
    eventRecord: (record) => ports.history.eventRecord(record),
    sessions: plan.sessionList,
    lastEventIds: plan.lastEventIds,
  });

  const busy = (projectId: string): boolean => {
    const live = ports.liveWork.busySessionIds();
    if (live.size === 0) return false;
    return prepared<[string], { id: string }>(
      ports.db,
      "SELECT id FROM sessions WHERE project_id = ?",
    )
      .all(projectId)
      .some((row) => live.has(row.id));
  };

  // ── objects ────────────────────────────────────────────────────────────────

  /** PUTs one object; an object already at a write-once key must be the same one. */
  const putObject = async (
    move: MoveRow,
    object: MoveObject,
    body: () => Promise<Uint8Array | NodeJS.ReadableStream>,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const outcome = await withNetworkRetry(
      () => ports.objects.put(move.moveId, object, body),
      signal,
    );
    if (outcome === "stored") return;
    const stored = await withNetworkRetry(
      () => ports.objects.head(move.moveId, object.key),
      signal,
    );
    let same =
      stored !== null &&
      stored.bytes === object.bytes &&
      (stored.sha256 === null || stored.sha256 === object.sha256);
    // A store that reports no checksum, on a key that does not name its content: read it.
    if (same && stored!.sha256 === null && !object.key.includes(object.sha256)) {
      const bytes = await withNetworkRetry(
        () => ports.objects.get(move.moveId, object.key),
        signal,
      );
      same = bytes !== null && createHash("sha256").update(bytes).digest("hex") === object.sha256;
    }
    if (!same) {
      throw new MoveProblemError(
        "object_conflict",
        "An object at a key this move writes differs.",
        {
          key: object.key,
        },
      );
    }
  };

  /** The network-retry rule for the object store and the history upload: the backend's. */
  const withNetworkRetry = <T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> =>
    withRetry(call, {
      ...RETRY,
      sleep,
      signal,
      passThrough: (error) =>
        error instanceof MoveProblemError || isDiskFullError(error) || isLocalFileError(error),
    });

  /** The object store as the verification reads it: HEADs and GETs retried like every call. */
  const retriedObjects: MoveObjectStore = {
    put: (moveId, object, body) => ports.objects.put(moveId, object, body),
    head: (moveId, key) =>
      withNetworkRetry(() => ports.objects.head(moveId, key), new AbortController().signal),
    get: (moveId, key) =>
      withNetworkRetry(() => ports.objects.get(moveId, key), new AbortController().signal),
  };

  /** The staged copy of what the move sends: its convex streams' chunks, compressed, by hash. */
  const stagedChunks = async (
    move: MoveRow,
  ): Promise<Array<MoveObject & { bytesOf: () => Promise<Buffer> }>> => {
    const manifest = await manifestOf(move);
    const staged: Array<MoveObject & { bytesOf: () => Promise<Buffer> }> = [];
    for (const stream of manifest.streams) {
      if (stream.destination !== "convex") continue;
      for (const chunk of stream.chunks) {
        const compress = async () =>
          zstdCompressSync(await readFile(join(exportDir(move), chunk.file)), ZSTD_LEVEL);
        const bytes = await compress();
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        staged.push({
          key: migrationKey(move.moveId, `chunk-${sha256}.ndjson.zst`),
          bytes: bytes.length,
          sha256,
          bytesOf: compress,
        });
      }
    }
    return staged;
  };

  // ── steps ──────────────────────────────────────────────────────────────────

  type Step = (move: MoveRow, queue: QueueRow, signal: AbortSignal) => Promise<MoveRow>;

  /** Pre-flight, the queue's backup, and the freeze. */
  const prepareAndFreeze: Step = async (move, queue, signal) => {
    const project = prepared<[string], { removed_at: number | null }>(
      ports.db,
      "SELECT removed_at FROM projects WHERE id = ?",
    ).get(move.projectId);
    if (project === undefined)
      throw new MoveProblemError("unknown_project", "The project is gone.");
    if (project.removed_at !== null && !queue.includeRemoved) {
      throw new MoveProblemError("project_removed", "The project was removed from the rail.");
    }
    if (busy(move.projectId)) throw new MovePausedError("not_idle");
    if (queue.backup === null) {
      const written = await ports.backup.write(signal);
      journal.setQueue(queue.queueId, {
        backup: { ...written, verifiedAt: now() },
      });
    }
    await fault("freeze");
    const frozen = journal.advance(move.moveId, "queued", "frozen", { paused: null });
    // A turn could have started between the check and the freeze: never export under it.
    if (busy(move.projectId)) {
      journal.advance(move.moveId, "frozen", "queued");
      throw new MovePausedError("not_idle");
    }
    return frozen;
  };

  const exportProject: Step = async (move, queue, signal) => {
    const dir = exportDir(move);
    if (!existsSync(join(dir, MANIFEST_FILE))) {
      try {
        await ports.exportProject({
          sourcePath: ports.profilePath,
          outDir: dir,
          appVersion: ports.appVersion,
          projectIds: [move.projectId],
          includeRemovedProjects: queue.includeRemoved,
          blobsDir: ports.stores.blobsDir,
          transcriptsDir: ports.stores.transcriptsDir,
          piLogsDir: ports.stores.piLogsDir,
          homeDir: ports.homeDir,
          signal,
        });
      } catch (error) {
        if (error instanceof MigrationExportError) {
          if (error.code === "disk_full") throw new MovePausedError("disk_full");
          if (error.code === "cancelled" || error.code === "in_progress") {
            throw new MovePausedError("paused");
          }
          throw new MoveProblemError(`export_${error.code}`, error.message);
        }
        throw error;
      }
    }
    await fault("exported");
    const verified = await verifyMigrationExport(dir).catch((error: unknown) => {
      throw new MoveProblemError("export_integrity", (error as Error).message);
    });
    const { sha256 } = await fileSha256(join(dir, MANIFEST_FILE));
    return journal.advance(move.moveId, "frozen", "exported", {
      journal: { exportId: verified.manifest.exportId, exportManifestSha256: sha256 },
    });
  };

  /** The plan, the staged chunks and the move manifest they make: the same on every run. */
  const manifestFor = async (move: MoveRow, signal: AbortSignal) => {
    const plan = await planOf(move, signal);
    const staged = await stagedChunks(move);
    const manifest = moveManifest({
      moveId: move.moveId,
      target: targetOf(move),
      exportManifestSha256: move.journal.exportManifestSha256!,
      appVersion: move.appVersion,
      mapperVersion: move.mapperVersion,
      plan,
      staged,
    });
    return { plan, staged, manifest };
  };

  const reserve: Step = async (move, _queue, signal) => {
    const { plan, manifest } = await manifestFor(move, signal);
    await fault("reserve");
    try {
      await calls.begin(signal, {
        moveId: move.moveId,
        projectId: move.projectId,
        workspaceId: move.workspaceId,
        runnerId: move.runnerId,
        manifestSha256: manifest.sha256,
        expected: plan.expected,
      });
    } catch (error) {
      if (error instanceof MoveBackendError && error.code === "import_in_progress") {
        throw new MovePausedError("waiting_for_purge");
      }
      if (error instanceof MoveBackendError && error.code === "move_conflict") {
        throw new MoveAgainError("export_changed", "The export changed since the move began.");
      }
      throw error;
    }
    await fault("reserved");
    return journal.advance(move.moveId, "exported", "reserved", {
      manifestSha256: manifest.sha256,
    });
  };

  const stage: Step = async (move, _queue, signal) => {
    const { staged, manifest } = await manifestFor(move, signal);
    if (manifest.sha256 !== move.manifestSha256) {
      throw new MoveAgainError("export_changed", "The export changed since the move began.");
    }
    await putObject(
      move,
      {
        key: migrationKey(move.moveId, "manifest.json"),
        bytes: manifest.bytes.length,
        sha256: manifest.sha256,
      },
      async () => manifest.bytes,
      signal,
    );
    for (const chunk of staged) {
      await putObject(move, chunk, chunk.bytesOf, signal);
      await fault("stage.chunk");
    }
    return journal.advance(move.moveId, "reserved", "staged");
  };

  const uploadObjects: Step = async (move, _queue, signal) => {
    const plan = await planOf(move, signal);
    let done = move.journal.objects ?? 0;
    const pending = plan.objects.slice(done);
    // In order, four at a time; the journal advances over the longest prefix that landed.
    for (let start = 0; start < pending.length; start += OBJECT_CONCURRENCY * 4) {
      const batch = pending.slice(start, start + OBJECT_CONCURRENCY * 4);
      await pool(batch, OBJECT_CONCURRENCY, async (object) => {
        const body =
          object.source === "blob"
            ? async () => createReadStream(blobFilePath(ports.stores.blobsDir, object.sha256))
            : async () => readFile(object.file);
        await putObject(move, object, body, signal);
      });
      done += batch.length;
      journal.patch(move.moveId, { journal: { objects: done } });
      await fault("objects.batch");
    }
    return journal.advance(move.moveId, "staged", "objects");
  };

  const importRows: Step = async (move, _queue, signal) => {
    const plan = await planOf(move, signal);
    const context = await recordContext(move, plan);
    const acknowledged: Record<string, number> = { ...move.journal.rows };
    for (const stream of MIGRATION_IMPORT_STREAMS) {
      const skip = acknowledged[stream] ?? 0;
      let index = 0;
      let rows: Row[] = [];
      let bytes = 0;
      const flush = async () => {
        if (rows.length === 0) return;
        const answer = await calls.importRows(signal, { moveId: move.moveId, stream, rows });
        if (
          answer.conflicts.length > 0 ||
          answer.rejected.length > 0 ||
          answer.inserted + answer.unchanged !== rows.length
        ) {
          const codes: Record<string, number> = {};
          for (const failure of [...answer.conflicts, ...answer.rejected]) {
            codes[failure.code] = (codes[failure.code] ?? 0) + 1;
          }
          throw new MoveProblemError("rows_refused", `Volli Cloud refused ${stream} rows.`, {
            stream,
            codes,
          });
        }
        acknowledged[stream] = (acknowledged[stream] ?? 0) + rows.length;
        rows = [];
        bytes = 0;
        journal.patch(move.moveId, { journal: { rows: { ...acknowledged } } });
        await fault(`rows.${stream}`);
      };
      for await (const record of importRecords(context, stream)) {
        signal.throwIfAborted();
        index += 1;
        if (index <= skip) continue;
        const size = jsonBytes(record);
        if (rows.length > 0 && (rows.length >= BATCH_MAX_ROWS || bytes + size > BATCH_MAX_BYTES)) {
          await flush();
        }
        rows.push(record);
        bytes += size;
      }
      await flush();
    }
    return journal.advance(move.moveId, "objects", "rows");
  };

  const uploadHistory: Step = async (move, _queue, signal) => {
    const plan = await planOf(move, signal);
    let done = move.journal.history ?? 0;
    for (const session of plan.sessionList.slice(done)) {
      const report = await withNetworkRetry(
        () =>
          ports.history.upload({ moveId: move.moveId, runnerId: move.runnerId }, session, signal),
        signal,
      );
      if (report.missing.length > 0 || report.piFilesLeftBehind > 0) {
        throw new MoveProblemError(
          "history_incomplete",
          "A Session's history could not be uploaded whole.",
          {
            sessionId: session.sessionId,
            missingBodies: report.missing.length,
            piFilesLeftBehind: report.piFilesLeftBehind,
          },
        );
      }
      done += 1;
      journal.patch(move.moveId, { journal: { history: done } });
      await fault("history.session");
    }
    return journal.advance(move.moveId, "rows", "history");
  };

  const verify: Step = async (move, _queue, signal) => {
    const plan = await planOf(move, signal);
    const report: VerifyReport = await verifyHiddenImport({
      calls,
      objects: retriedObjects,
      moveId: move.moveId,
      runnerId: move.runnerId,
      plan,
      signal,
    });
    if (!report.ok) {
      throw new MoveProblemError("verification_failed", "A check did not match.", {
        failures: report.failures,
        verify: report,
      });
    }
    // The content-free report, staged beside the manifest for audit.
    const bytes = Buffer.from(JSON.stringify({ moveId: move.moveId, verify: report }));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await putObject(
      move,
      { key: migrationKey(move.moveId, `report-${sha256}.json`), bytes: bytes.length, sha256 },
      async () => bytes,
      signal,
    );
    await fault("verified");
    return journal.advance(move.moveId, "history", "verified", { report: { verify: report } });
  };

  const commit: Step = async (move, _queue, signal) => {
    try {
      await calls.commit(signal, { moveId: move.moveId, manifestSha256: move.manifestSha256! });
    } catch (error) {
      if (error instanceof MoveBackendError && error.code === "verification_failed") {
        throw new MoveProblemError(
          "verification_failed",
          "Volli Cloud's own count did not match.",
          {
            streams: error.data.streams,
          },
        );
      }
      throw error;
    }
    await fault("committed");
    return journal.advance(move.moveId, "verified", "committed", { committedAt: now() });
  };

  const STEPS: Partial<Record<MoveState, Step>> = {
    queued: prepareAndFreeze,
    frozen: exportProject,
    exported: reserve,
    reserved: stage,
    staged: uploadObjects,
    objects: importRows,
    rows: uploadHistory,
    history: verify,
    verified: commit,
  };

  // ── roll back ──────────────────────────────────────────────────────────────

  /**
   * Takes a move to `rolled_back`: uncommit (when the backend showed it),
   * abort (so the backend purges what it holds), the handover taken back,
   * the export removed, the local project unfrozen. Journaled at each part,
   * so a roll back a crash interrupted finishes where it stopped.
   */
  const finishRollBack = async (
    move: MoveRow,
    signal: AbortSignal,
    options: { confirmChanged: boolean },
  ): Promise<MoveRow> => {
    const from = move.journal.rollbackFrom ?? "queued";
    const confirmChanged = options.confirmChanged || move.journal.rollbackConfirmed === true;
    // The backend may have shown the project though this Mac never heard so
    // (a commit that landed before a crash): ask it before deciding.
    let shown = COMMITTED_STATES.has(from);
    if (!shown && reached(from, "verified") && move.journal.uncommitted !== true) {
      try {
        shown = (await calls.status(signal, move.moveId)).status === "committed";
      } catch (error) {
        if (!(error instanceof MoveBackendError && error.code === "not_found")) throw error;
      }
    }
    if (shown && move.journal.uncommitted !== true) {
      await calls.uncommit(signal, { moveId: move.moveId, confirmChanged });
      move = journal.patch(move.moveId, { journal: { uncommitted: true } });
      await fault("rollback.uncommitted");
    }
    if (reached(from, "exported") && move.journal.aborted !== true) {
      try {
        await calls.abort(signal, move.moveId);
      } catch (error) {
        // A move the backend never reserved has nothing to abort.
        if (!(error instanceof MoveBackendError && error.code === "not_found")) throw error;
      }
      move = journal.patch(move.moveId, { journal: { aborted: true } });
      await fault("rollback.aborted");
    }
    await rm(workDir(move), { recursive: true, force: true, maxRetries: 3 });
    const again = move.journal.againOnRunner;
    if (again === undefined) {
      return journal.advance(move.moveId, "rolling_back", "rolled_back", { paused: null });
    }
    // Moved again: the old move gives the project up and a fresh one takes
    // its place, in one transaction, so a crash never leaves the project
    // without its next move.
    return ports.db.transaction(() => {
      const superseded = journal.advance(move.moveId, "rolling_back", "superseded", {
        paused: null,
      });
      if (journal.queue(move.queueId)!.runnerId !== again) {
        journal.setQueue(move.queueId, { runnerId: again });
      }
      journal.addMove(move.queueId, {
        moveId: newId(),
        projectId: move.projectId,
        position: move.position,
        supersedes: move.moveId,
      });
      return superseded;
    })();
  };

  const startRollBack = (move: MoveRow, failure: MoveFailure | null): MoveRow =>
    journal.advance(move.moveId, move.state, "rolling_back", {
      paused: null,
      failure,
      journal: { rollbackFrom: move.state },
    });

  const failureOf = (move: MoveRow, code: string, message: string, detail?: Row): MoveFailure => ({
    code,
    message,
    step: move.state,
    at: now(),
    ...(detail === undefined ? {} : { detail }),
  });

  // ── one move ───────────────────────────────────────────────────────────────

  type MoveOutcome = "moved" | "rolled_back" | "superseded" | { paused: MovePause };

  const advanceMove = async (moveId: string, signal: AbortSignal): Promise<MoveOutcome> => {
    for (;;) {
      let move = journal.move(moveId)!;
      if (move.state === "rolling_back") {
        try {
          await finishRollBack(move, signal, { confirmChanged: false });
        } catch (error) {
          return pauseFor(move, error);
        }
        return journal.move(moveId)!.state === "superseded" ? "superseded" : "rolled_back";
      }
      if (SETTLED_STATES.has(move.state))
        return move.state === "superseded" ? "superseded" : "rolled_back";
      if (RESTING_STATES.has(move.state)) return "moved";

      const queue = journal.queue(move.queueId)!;
      const identity = await ports.identity.current();
      if (identity === null || identity.userId !== move.userId) {
        journal.patch(moveId, { paused: "signed_out" });
        return { paused: "signed_out" };
      }
      const step = STEPS[move.state];
      if (step === undefined) return "moved";
      try {
        if (identity.runnerId !== move.runnerId) {
          throw new MoveAgainError("runner_replaced", "This Mac's runner was replaced.");
        }
        if (move.mapperVersion !== MAPPER_VERSION && reached(move.state, "exported")) {
          throw new MoveAgainError("app_updated", "This build exports differently.");
        }
        if (move.paused !== null) move = journal.patch(moveId, { paused: null });
        await step(move, queue, signal);
      } catch (error) {
        const outcome = await settle(move, identity.runnerId, error, signal);
        if (outcome !== null) return outcome;
      }
    }
  };

  /** What a failed step does to its move; null when the loop goes on (it starts over). */
  const settle = async (
    move: MoveRow,
    runnerId: string,
    error: unknown,
    signal: AbortSignal,
  ): Promise<MoveOutcome | null> => {
    if (error instanceof MovePausedError) {
      journal.patch(move.moveId, { paused: error.reason });
      return { paused: error.reason };
    }
    const refusal = refusalOf(error);
    const again =
      error instanceof MoveAgainError
        ? error
        : refusal?.code === "runner_unavailable" && runnerId !== move.runnerId
          ? new MoveAgainError("runner_replaced", refusal.message)
          : null;
    if (again !== null) {
      log.info("a move starts over", { moveId: move.moveId, code: again.code });
      const rolling = journal.advance(move.moveId, move.state, "rolling_back", {
        paused: null,
        failure: failureOf(move, again.code, again.message),
        journal: { rollbackFrom: move.state, againOnRunner: runnerId },
      });
      try {
        await finishRollBack(rolling, signal, { confirmChanged: true });
      } catch (rollbackError) {
        return pauseFor(journal.move(move.moveId)!, rollbackError);
      }
      return null;
    }
    const problem =
      error instanceof MoveProblemError || error instanceof MovePlanError
        ? { code: error.code, message: error.message, detail: error.detail }
        : refusal !== null
          ? { code: refusal.code, message: refusal.message, detail: {} }
          : isLocalFileError(error)
            ? {
                code: "local_file_unreadable",
                message: "A file this move reads on this Mac is gone or unreadable.",
                detail: { errno: (error as { code: string }).code },
              }
            : null;
    if (problem === null) return pauseFor(move, error);
    const failure = failureOf(move, problem.code, problem.message, problem.detail);
    if (COMMITTED_STATES.has(move.state)) {
      // Shown already: the person decides (Roll back stays offered).
      journal.patch(move.moveId, { failure, paused: "paused" });
      return { paused: "paused" };
    }
    log.warn("a move rolls back", { moveId: move.moveId, code: problem.code });
    try {
      await finishRollBack(startRollBack(move, failure), signal, { confirmChanged: false });
    } catch (rollbackError) {
      return pauseFor(journal.move(move.moveId)!, rollbackError);
    }
    return "rolled_back";
  };

  /**
   * A failure that is not a problem with the data: the move waits and
   * resumes. An unexpected error is recorded (`internal`) so the person sees
   * it and can resume or cancel; the local copy is untouched either way.
   */
  const pauseFor = (move: MoveRow, error: unknown): MoveOutcome => {
    if (error instanceof MoveNetworkError) {
      journal.patch(move.moveId, { paused: "network" });
      return { paused: "network" };
    }
    if (isDiskFullError(error)) {
      journal.patch(move.moveId, { paused: "disk_full" });
      return { paused: "disk_full" };
    }
    // Cancelled, or another run of the engine took the step first: nothing failed.
    const aborted =
      (error as { name?: string } | null)?.name === "AbortError" ||
      error instanceof MoveStateConflictError;
    if (!aborted) log.warn("a move stopped on an unexpected error", { moveId: move.moveId, error });
    journal.patch(move.moveId, {
      paused: "paused",
      ...(aborted
        ? {}
        : {
            failure: failureOf(
              move,
              "internal",
              (error instanceof Error ? error.message : String(error)).slice(0, 200),
            ),
          }),
    });
    return { paused: "paused" };
  };

  // ── queues ─────────────────────────────────────────────────────────────────

  const run = async (queueId: string, signal: AbortSignal = new AbortController().signal) =>
    maintenance(async (): Promise<QueueOutcome> => {
      const retried = new Set<string>();
      for (;;) {
        const queue = journal.queue(queueId);
        if (queue === null) throw new Error(`Move queue ${queueId} does not exist.`);
        const moves = journal.moves(queueId);
        // A done queue may still hold a roll back a crash interrupted.
        const open = moves.filter(
          (move) => !SETTLED_STATES.has(move.state) && !RESTING_STATES.has(move.state),
        );
        // A project that waits on itself goes after the rest of the queue, then gets one more try.
        const next =
          open.find((move) => !WAITS_FOR_OTHERS.has(move.paused)) ??
          open.find((move) => !retried.has(move.moveId));
        if (next === undefined) {
          const waiting = open[0];
          if (waiting !== undefined) {
            return {
              kind: "waiting",
              moveId: waiting.moveId,
              reason: waiting.paused ?? "not_idle",
            };
          }
          journal.setQueue(queueId, { state: "done" });
          return { kind: "done" };
        }
        if (WAITS_FOR_OTHERS.has(next.paused)) retried.add(next.moveId);
        // A stopped queue still finishes a roll back a crash interrupted.
        if (queue.state === "stopped" && next.state !== "rolling_back") {
          const rolling = open.find((move) => move.state === "rolling_back");
          if (rolling === undefined) return { kind: "stopped", moveId: next.moveId };
          await advanceMove(rolling.moveId, signal);
          continue;
        }
        const outcome = await advanceMove(next.moveId, signal);
        if (typeof outcome === "object") {
          if (WAITS_FOR_OTHERS.has(outcome.paused)) continue;
          return { kind: "waiting", moveId: next.moveId, reason: outcome.paused };
        }
        const settled = journal.move(next.moveId)!;
        const problem =
          outcome === "rolled_back" || (outcome === "moved" && settled.report?.ok === false);
        if (problem && queue.stopAtFirstProblem) {
          journal.setQueue(queueId, { state: "stopped" });
          return { kind: "stopped", moveId: next.moveId };
        }
      }
    });

  return {
    journal,

    enqueue(input) {
      if (input.projectIds.length === 0) throw new Error("Choose at least one project to move.");
      for (const projectId of input.projectIds) {
        const live = journal.liveMove(projectId);
        if (live !== null)
          throw new Error(`Project ${projectId} is already moving (${live.state}).`);
      }
      const order = queueOrder(ports.db, input.projectIds, new Set(input.lastProjectIds ?? []));
      // Stop at the first problem: on for the profile's first "Move all" (a
      // queue of several projects), however many single moves came before it.
      const firstQueue =
        input.projectIds.length === 1 ||
        prepared<[], { n: number }>(
          ports.db,
          `SELECT COUNT(*) AS n FROM (SELECT queue_id FROM cloud_moves
             GROUP BY queue_id HAVING COUNT(DISTINCT project_id) > 1)`,
        ).get()!.n === 0;
      const queueId = newId();
      journal.createQueue(
        {
          queueId,
          userId: input.target.userId,
          workspaceId: input.target.workspaceId,
          runnerId: input.target.runnerId,
          stopAtFirstProblem: input.stopAtFirstProblem ?? firstQueue,
          includeRemoved: input.includeRemoved ?? false,
          // The profile step (personal settings) runs with the first queue.
          profileStep: "pending",
          backup: null,
          state: "running",
        },
        order.map((projectId, position) => ({ moveId: newId(), projectId, position })),
      );
      return this.queue(queueId)!;
    },

    run,

    async resume(signal) {
      for (const queue of journal.runningQueues()) await run(queue.queueId, signal);
      // A roll back a crash interrupted outside a running queue.
      for (const move of journal.movesIn(["rolling_back"])) await run(move.queueId, signal);
    },

    proceed(queueId) {
      const queue = journal.queue(queueId);
      if (queue === null) throw new Error(`Move queue ${queueId} does not exist.`);
      if (queue.state === "stopped") journal.setQueue(queueId, { state: "running" });
    },

    async rollBack(moveId, options = {}) {
      const signal = options.signal ?? new AbortController().signal;
      let move = journal.move(moveId);
      if (move === null) throw new Error(`Move ${moveId} does not exist.`);
      if (SETTLED_STATES.has(move.state)) return move;
      if (move.state === "confirmed" || move.state === "returning") {
        throw new Error("A finished move goes back to local; it does not roll back.");
      }
      if (move.state !== "rolling_back") {
        move = startRollBack(move, failureOf(move, "cancelled", "Rolled back by the person."));
      }
      // Kept, so a roll back a crash interrupts finishes as the person confirmed it.
      if (options.confirmChanged === true && move.journal.rollbackConfirmed !== true) {
        move = journal.patch(moveId, { journal: { rollbackConfirmed: true } });
      }
      try {
        return await finishRollBack(move, signal, {
          confirmChanged: options.confirmChanged === true,
        });
      } catch (error) {
        // The cloud copy changed since the commit: the person confirms losing it, or keeps it.
        if (error instanceof MoveBackendError && error.code === "changed_since_commit") {
          const from = move.journal.rollbackFrom!;
          journal.advance(moveId, "rolling_back", from, { failure: null });
        }
        throw error;
      }
    },

    queue(queueId) {
      const queue = journal.queue(queueId);
      return queue === null ? null : { queue, moves: journal.moves(queueId) };
    },
  };
}
