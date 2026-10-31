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
 * After the commit the project is visible in Volli Cloud: the handover
 * hands the folder and the Sessions to this runner, the real-path check
 * reads it back through the window's own reads, and the move waits for the
 * person (`checked`): Finish move ({@link MoveEngine.confirm}, the local copy
 * archived read-only), Roll back, or later Go back to local.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { derivedId } from "../migration-export/transform";
import { verifyMigrationExport } from "../migration-export/verify";
import { OBJECT_UPLOAD_TIMEOUT_MS } from "../transcript-spool/object-store";
import { saveCloudChanges } from "./cloud-changes";
import { handOver, plannedHandover, releaseHandover, releaseProjectCursors } from "./handover";
import {
  MoveBackendError,
  MOVE_RETRY,
  MoveNetworkError,
  importCalls,
  type ImportRowsAnswer,
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
  exportRecords,
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
const RETRY = MOVE_RETRY;
/**
 * How long after an upload URL is issued it can still write: the store
 * checks a URL's expiry (the backend's `PRESIGN_EXPIRES_SECONDS`, five
 * minutes) when a request starts, and a request this Mac started is
 * abandoned after the spool's upload timeout. Both, plus a minute's margin.
 */
const UPLOAD_URL_LIFETIME_MS = 5 * 60_000 + OBJECT_UPLOAD_TIMEOUT_MS + 60_000;

/**
 * Where a move waits for the person, not for the engine: the checks ran
 * (`checked`), the move is finished (`confirmed`), or going back to local
 * (`returning`, which only the person's own call drives).
 */
const RESTING_STATES: ReadonlySet<MoveState> = new Set<MoveState>([
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

/** A dry run's measuring export carries no history (`historyMeasured`): it is never a move's. */
export function refuseDryRunExport(
  manifest: Pick<MigrationExportManifest, "historyMeasured">,
): void {
  if (manifest.historyMeasured !== undefined)
    throw new MoveProblemError("export_integrity", "A dry run's export cannot be moved.");
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
  /** Finish move: the local copy stays, archived read-only. */
  confirm(moveId: string): Promise<MoveRow>;
  /** Runs the real-path check of a moved project again (its folds may have caught up). */
  recheck(moveId: string): void;
  /**
   * Go back to local, any time after the commit: the cloud's
   * changes since the move are saved to a readable export, this runner's
   * handover is taken back and the local copy is unlocked. Volli Cloud keeps
   * its copy; nothing there is changed.
   */
  goBackToLocal(moveId: string, signal?: AbortSignal): Promise<MoveRow>;
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
  /** Tells a running drain; its failure never fails the move (the drain drops them itself later). */
  const cursorsReleased = (sessionIds: readonly string[]) => {
    if (sessionIds.length === 0) return;
    try {
      ports.cursorsReleased?.(sessionIds);
    } catch {
      // The drain's own check (`held`) drops the streams when it next looks.
    }
  };
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
      const read = await withNetworkRetry(
        () => ports.objects.digest(move.moveId, object.key),
        signal,
      );
      same = read !== null && read.sha256 === object.sha256;
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
      // A call already retried on its own (`MoveNetworkError`) is not retried again around it.
      passThrough: (error) =>
        error instanceof MoveProblemError ||
        error instanceof MoveNetworkError ||
        isDiskFullError(error) ||
        isLocalFileError(error),
      onRetry: (attempt, error) => log.warn("a move upload will be retried", { attempt, error }),
    });

  /** The object store as the verification reads it: HEADs and GETs retried like every call. */
  const retriedObjects: MoveObjectStore = {
    put: (moveId, object, body) => ports.objects.put(moveId, object, body),
    head: (moveId, key) =>
      withNetworkRetry(() => ports.objects.head(moveId, key), new AbortController().signal),
    digest: (moveId, key) =>
      withNetworkRetry(() => ports.objects.digest(moveId, key), new AbortController().signal),
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

  // ── the history objects' upload URLs ──────────────────────────────────────

  const signedFile = (move: MoveRow) => join(workDir(move), "history-signed.ndjson");

  /** Journals one upload URL as it is issued: the key, what it was signed for, and when. */
  const lastSignedHere = new Map<string, number>();
  const recordSigned = (move: MoveRow, object: MoveObject): void => {
    lastSignedHere.set(move.moveId, performance.now());
    mkdirSync(workDir(move), { recursive: true });
    appendFileSync(signedFile(move), `${JSON.stringify({ ...object, at: now() })}\n`);
  };

  /** What was last signed for each history key, and when the last URL was issued. */
  const signedHistory = async (
    move: MoveRow,
  ): Promise<{ objects: MoveObject[]; lastAt: number }> => {
    let text = "";
    try {
      text = await readFile(signedFile(move), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const latest = new Map<string, MoveObject>();
    let lastAt = 0;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let entry: MoveObject & { at: number };
      try {
        entry = JSON.parse(line) as MoveObject & { at: number };
      } catch {
        // A line torn by a crash: that process is gone, and so is its URL.
        continue;
      }
      const { at, ...object } = entry;
      latest.set(object.key, object);
      lastAt = Math.max(lastAt, at);
    }
    return { objects: [...latest.values()], lastAt };
  };

  // ── steps ──────────────────────────────────────────────────────────────────

  type Step = (move: MoveRow, queue: QueueRow, signal: AbortSignal) => Promise<MoveRow>;

  /** The queue's verified backup, written once before anything else touches the profile. */
  const ensureBackup = async (queue: QueueRow, signal: AbortSignal): Promise<void> => {
    if (journal.queue(queue.queueId)!.backup !== null) return;
    const written = await ports.backup.write(signal);
    journal.setQueue(queue.queueId, { backup: { ...written, verifiedAt: now() } });
  };

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
    await ensureBackup(queue, signal);
    // A backup published as cancellation arrived is still a reusable safety
    // copy. Journal it first, but do not freeze until the person resumes.
    signal.throwIfAborted();
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
          throw new MoveProblemError(
            `export_${error.code}`,
            error.message,
            error.sessionId === undefined ? {} : { sessionId: error.sessionId },
          );
        }
        throw error;
      }
    }
    await fault("exported");
    const verified = await verifyMigrationExport(dir).catch((error: unknown) => {
      throw new MoveProblemError("export_integrity", (error as Error).message);
    });
    refuseDryRunExport(verified.manifest);
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
          ports.history.upload(
            { moveId: move.moveId, runnerId: move.runnerId },
            session,
            signal,
            (object) => recordSigned(move, object),
          ),
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
    // A Session's history objects are not write-once (an upload resumed
    // before its commit replaces its object), so a URL issued before the
    // commit could still write after it. Wait out the last one, then check
    // that the store holds what was last signed for every key: past this
    // point the move asks for no upload URL, so nothing can change them.
    const signed = await signedHistory(move);
    const wait = Math.max(
      // A URL this process holds: by its own monotonic clock.
      UPLOAD_URL_LIFETIME_MS - (performance.now() - (lastSignedHere.get(move.moveId) ?? -Infinity)),
      // One an earlier run issued, by the journal's wall clock, never longer
      // than a URL's whole life (a clock set back cannot hold the move).
      Math.min(signed.lastAt + UPLOAD_URL_LIFETIME_MS - now(), UPLOAD_URL_LIFETIME_MS),
    );
    if (signed.objects.length > 0 && wait > 0) await sleep(wait, signal);
    const report: VerifyReport = await verifyHiddenImport({
      calls,
      objects: retriedObjects,
      moveId: move.moveId,
      runnerId: move.runnerId,
      plan,
      historyObjects: signed.objects,
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

  const handover: Step = async (move, _queue, signal) => {
    // Journaled before anything is written: a roll back that interrupts the
    // handover takes back exactly what it may have written.
    const planned = await plannedHandover({
      exportDir: exportDir(move),
      manifest: await manifestOf(move),
      plan: await planOf(move, signal),
    });
    move = journal.patch(move.moveId, { journal: { handover: planned } });
    await fault("handing_over");
    const record = handOver({
      db: ports.db,
      history: ports.history,
      userId: move.userId,
      runnerId: move.runnerId,
      projectId: move.projectId,
      planned,
    });
    await fault("handed_over");
    return journal.advance(move.moveId, "committed", "handed_over", {
      journal: { handover: record },
    });
  };

  const checkRealPaths: Step = async (move, _queue, signal) => {
    const plan = await planOf(move, signal);
    const realPath = await ports.realPath.check(
      {
        moveId: move.moveId,
        projectId: move.projectId,
        workspaceId: move.workspaceId,
        exportDir: exportDir(move),
        sessions: plan.sessionList,
      },
      signal,
    );
    const collisions = move.journal.handover?.collisions ?? 0;
    return journal.advance(move.moveId, "handed_over", "checked", {
      report: {
        ...move.report,
        realPath,
        handover: { collisions },
        ok: realPath.ok && collisions === 0,
      },
    });
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
    committed: handover,
    handed_over: checkRealPaths,
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
    // `uncommitted` too: a roll back resumed after its uncommit no longer asks
    // the backend, so `shown` can read false there.
    const purged = shown || move.journal.uncommitted === true;
    // Its paths only. A handover is journaled in the `committed` step, so a
    // roll back that has one rolls back from a committed state: `shown`, and
    // the moved Sessions' cursors go with every other one just below.
    if (move.journal.handover !== undefined) {
      releaseHandover({ db: ports.db, runnerId: move.runnerId, record: move.journal.handover });
    }
    if (purged) {
      // The cloud copy is purged: no Session of the project is served from
      // here any more, the ones that moved on since and those born in Volli
      // Cloud included (whether or not the handover ran). Taken back and named
      // in one transaction, so a crash between cannot lose the names. A roll
      // back resumed after that adds to the names an earlier run kept.
      const failure = move.failure;
      let takenBack: string[] = [];
      move = ports.db.transaction(() => {
        takenBack = releaseProjectCursors(ports.db, move.userId, move.projectId);
        if (takenBack.length === 0 || failure === null) return move;
        const earlier = failure.detail?.["cursorsTakenBack"];
        const kept = Array.isArray(earlier)
          ? earlier.filter((id): id is string => typeof id === "string")
          : [];
        const named = new Set([...kept, ...takenBack]);
        return journal.patch(move.moveId, {
          failure: {
            ...failure,
            detail: { ...failure.detail, cursorsTakenBack: [...named].toSorted() },
          },
        });
      })();
      cursorsReleased(takenBack);
      await fault("rollback.cursors");
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
    // Another run (the person's roll back, a go back to local) took the move
    // on while this step ran: its outcome is theirs to write, not this step's.
    if (journal.move(move.moveId)!.state !== move.state && !(error instanceof MovePausedError)) {
      return { paused: "paused" };
    }
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

  // ── the profile step ───────────────────────────────────────────────────────

  /**
   * The person's own settings, once per queue before its first project:
   * personal `configEntries` exported alone (`projectIds: []`,
   * `profileStep: true`) and imported through `profileImports`. A setting the
   * person already holds with other content (changed since an earlier move)
   * keeps the stored one and is counted; a refused one is a problem. The
   * content-free report is `profile-<queueId>/report.json`. Null when the
   * queue goes on; otherwise how it ended.
   */
  const profileStep = async (
    queue: QueueRow,
    signal: AbortSignal,
  ): Promise<{ kind: "waiting"; reason: MovePause } | { kind: "stopped" } | null> => {
    const identity = await ports.identity.current();
    if (identity === null || identity.userId !== queue.userId) {
      return { kind: "waiting", reason: "signed_out" };
    }
    const dir = join(ports.workRoot, `profile-${queue.queueId}`);
    const out = join(dir, "export");
    const report = { inserted: 0, unchanged: 0, kept: 0, refused: {} as Record<string, number> };
    try {
      // Small and cheap: exported afresh every time, never a stale build's.
      await rm(out, { recursive: true, force: true, maxRetries: 3 });
      await ports.exportProject({
        sourcePath: ports.profilePath,
        outDir: out,
        appVersion: ports.appVersion,
        projectIds: [],
        profileStep: true,
        blobsDir: ports.stores.blobsDir,
        transcriptsDir: ports.stores.transcriptsDir,
        piLogsDir: ports.stores.piLogsDir,
        homeDir: ports.homeDir,
        signal,
      });
      const { manifest } = await verifyMigrationExport(out);
      let rows: Row[] = [];
      const flush = async () => {
        if (rows.length === 0) return;
        const answer = (await withRetry(
          () =>
            ports.backend.mutation("profileImports:importPersonalSettings", {
              workspaceId: queue.workspaceId,
              runnerId: queue.runnerId,
              rows,
            }),
          { ...RETRY, sleep, signal },
        )) as Pick<ImportRowsAnswer, "inserted" | "unchanged" | "conflicts" | "rejected">;
        report.inserted += answer.inserted;
        report.unchanged += answer.unchanged;
        report.kept += answer.conflicts.length;
        for (const refusal of answer.rejected) {
          report.refused[refusal.code] = (report.refused[refusal.code] ?? 0) + 1;
        }
        rows = [];
      };
      for await (const record of exportRecords(out, manifest, "configEntries")) {
        // A setting's exported id names its kind and name only; in Volli Cloud
        // it is the person's own, so it is derived for them (a stable name:
        // the same person moving again lands on the same row).
        rows.push({
          ...record,
          id: derivedId("personal-setting", queue.userId, record.id as string),
        });
        if (rows.length >= BATCH_MAX_ROWS) await flush();
      }
      await flush();
    } catch (error) {
      if (error instanceof MoveNetworkError) return { kind: "waiting", reason: "network" };
      if (
        isDiskFullError(error) ||
        (error instanceof MigrationExportError && error.code === "disk_full")
      ) {
        return { kind: "waiting", reason: "disk_full" };
      }
      if ((error as { name?: string } | null)?.name === "AbortError") {
        return { kind: "waiting", reason: "paused" };
      }
      const refusal = refusalOf(error);
      if (refusal === null) {
        // Not a refusal of the settings: the step waits and runs again.
        log.warn("the profile step will run again", { queueId: queue.queueId, error });
        return { kind: "waiting", reason: "paused" };
      }
      report.refused[refusal.code] = 1;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "report.json"), JSON.stringify(report));
    await rm(out, { recursive: true, force: true, maxRetries: 3 });
    const problem = Object.keys(report.refused).length > 0;
    journal.setQueue(queue.queueId, { profileStep: problem ? "skipped" : "done" });
    if (problem && queue.stopAtFirstProblem) {
      journal.setQueue(queue.queueId, { state: "stopped" });
      return { kind: "stopped" };
    }
    return null;
  };

  // ── queues ─────────────────────────────────────────────────────────────────

  const run = async (queueId: string, signal: AbortSignal = new AbortController().signal) =>
    maintenance(async (): Promise<QueueOutcome> => {
      const retried = new Set<string>();
      for (;;) {
        const queue = journal.queue(queueId);
        if (queue === null) throw new Error(`Move queue ${queueId} does not exist.`);
        const moves = journal.moves(queueId);
        if (queue.profileStep === "pending" && queue.state === "running") {
          // The backup comes first, before the profile step reads anything.
          const first = moves.find((move) => !SETTLED_STATES.has(move.state));
          if (first !== undefined) {
            try {
              await ensureBackup(queue, signal);
            } catch (error) {
              const outcome = pauseFor(first, error);
              return {
                kind: "waiting",
                moveId: first.moveId,
                reason: typeof outcome === "object" ? outcome.paused : "paused",
              };
            }
          }
          // A backup published as cancellation arrived is kept; nothing else runs.
          if (signal.aborted) {
            return { kind: "waiting", moveId: first?.moveId ?? queueId, reason: "paused" };
          }
          const outcome = await profileStep(queue, signal);
          if (outcome !== null) return { ...outcome, moveId: moves[0]?.moveId ?? queueId };
          continue;
        }
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
      // Whatever a crash interrupted outside a running queue: a roll back, a go back to local.
      for (const move of journal.movesIn(["rolling_back"])) await run(move.queueId, signal);
      for (const move of journal.movesIn(["returning"])) {
        await this.goBackToLocal(move.moveId, signal).catch((error: unknown) => {
          log.warn("a go back to local will resume at the next launch", {
            moveId: move.moveId,
            error,
          });
        });
      }
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

    async confirm(moveId) {
      const move = journal.move(moveId);
      if (move === null || move.state !== "checked") {
        throw new Error("Only a moved project whose checks ran can be finished.");
      }
      const confirmed = journal.advance(moveId, "checked", "confirmed", { confirmedAt: now() });
      // The export and the legacy archives are plaintext copies of what moved:
      // not kept past the move. The plan (counts and digests) stays.
      await rm(exportDir(move), { recursive: true, force: true, maxRetries: 3 });
      await rm(join(workDir(move), "legacy"), { recursive: true, force: true, maxRetries: 3 });
      return confirmed;
    },

    recheck(moveId) {
      const move = journal.move(moveId);
      if (move === null || move.state !== "checked") {
        throw new Error("Only a moved project whose checks ran can be checked again.");
      }
      // The handover runs again too (each write is an upsert): a folder freed since is taken.
      journal.advance(moveId, "checked", "committed", { paused: null });
      if (journal.queue(move.queueId)!.state === "done") {
        journal.setQueue(move.queueId, { state: "running" });
      }
    },

    async goBackToLocal(moveId, signal = new AbortController().signal) {
      let move = journal.move(moveId);
      if (move === null) throw new Error(`Move ${moveId} does not exist.`);
      if (move.state === "returned") return move;
      if (move.state !== "returning") {
        if (!COMMITTED_STATES.has(move.state)) {
          throw new Error("Only a moved project goes back to local; roll this move back instead.");
        }
        move = journal.advance(moveId, move.state, "returning", {
          paused: null,
          journal: { rollbackFrom: move.state },
        });
      }
      if (move.journal.returnedExport === undefined) {
        const plan = JSON.parse(
          await readFile(join(workDir(move), "plan.json"), "utf8"),
        ) as MovePlan;
        const saved = await saveCloudChanges({
          backend: ports.backend,
          sleep,
          projectId: move.projectId,
          committedAt: move.committedAt ?? 0,
          plan,
          dir: join(workDir(move), `returned-${now()}`),
          now: now(),
          signal,
        });
        move = journal.patch(moveId, {
          journal: { returnedExport: saved.dir },
          report: { ...move.report, returned: saved },
        });
        await fault("returning.saved");
      }
      if (move.journal.handover !== undefined) {
        releaseHandover({ db: ports.db, runnerId: move.runnerId, record: move.journal.handover });
      }
      // Every cursor on the project, whether or not the handover ran: the
      // moved Sessions and those born in Volli Cloud since the commit.
      cursorsReleased(releaseProjectCursors(ports.db, move.userId, move.projectId));
      await rm(exportDir(move), { recursive: true, force: true, maxRetries: 3 });
      return journal.advance(moveId, "returning", "returned", { returnedAt: now() });
    },

    queue(queueId) {
      const queue = journal.queue(queueId);
      return queue === null ? null : { queue, moves: journal.moves(queueId) };
    },
  };
}
