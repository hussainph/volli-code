/**
 * The migration exporter: a consistent snapshot of `volli.db`, streamed
 * out as Volli Cloud records into a directory of NDJSON chunks and a manifest,
 * resumable after a crash or a cancel and atomic on completion.
 *
 * It is the source side of the SQLite → Volli Cloud migration (VC-903): it
 * uploads nothing and calls no backend. What the importer receives is a
 * directory whose `manifest.json` names every chunk with its record count,
 * size and sha256 (`verify.ts` re-checks them), and every table of the source
 * with what the migration does with it (`tables.ts`).
 *
 * **Consistent.** The first step is `VACUUM INTO` from a read-only connection:
 * one statement, so one read transaction, so a copy of exactly one committed
 * state of the database, taken while the app keeps writing. Every later read
 * is from that copy, which is also what makes a resume see the same rows.
 * The live database is never opened for writing.
 *
 * **Off the interactive path.** Run it through `worker.ts`, which hosts this
 * function in a worker thread with progress and cancellation over messages.
 * Called directly it still yields to the event loop every few hundred rows,
 * but a single SQLite statement (the snapshot, the integrity check, a
 * source's first sorted row) cannot yield or be interrupted.
 *
 * **Resumable.** Each source checkpoints whenever its buffered output reaches
 * a chunk's size; a resumed run verifies every journaled chunk, deletes
 * whatever no journal line names, and continues each source from its last
 * checkpoint (`staging.ts`). A staging area from another source path, build
 * or mapper version is not resumed: it is snapshotted again. One run at a
 * time holds `<outDir>.lock`.
 *
 * **Atomic.** Work happens under `<outDir>.partial`. Before anything is
 * published, every source must have checkpointed all its rows and the staged
 * chunks must verify against the manifest; then the snapshot and journal are
 * removed and the directory renamed to `outDir` in one step. A cancelled, failed or interrupted export never sits
 * at `outDir`.
 */
import { createHash, randomUUID } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { withProfileMaintenance } from "../backup/profile-maintenance";
import { MIGRATION_DISK_HEADROOM_BYTES, nodeDiskProbe, type DiskProbe } from "../db/disk-preflight";
import { SCHEMA_HEAD } from "../db/migrations";
import { MigrationExportError, isDiskFullError } from "./errors";
import { MIGRATION_EXPORT_FORMAT, MIGRATION_PLACEHOLDERS } from "./records";
import {
  EXPORT_SOURCES,
  STREAM_DESTINATIONS,
  SourceCorruptError,
  buildLookups,
  type Emit,
  type ExportSource,
  type StreamDestination,
  type StreamName,
} from "./sources";
import {
  JOURNAL_FILE,
  MANIFEST_FILE,
  MAPPER_VERSION,
  SNAPSHOT_FILE,
  STATE_FILE,
  acquireExportLock,
  appendLineDurably,
  chunkFileName,
  chunkIntact,
  readJournal,
  removeUnjournaledFiles,
  rewriteJournal,
  stagingDirOf,
  syncDirectory,
  writeFileDurably,
  type Checkpoint,
  type ChunkEntry,
  type StagingState,
} from "./staging";
import { MIGRATION_TABLE_DECISIONS, type MigrationTableDecision } from "./tables";
import { verifyMigrationExport } from "./verify";

/** The oldest schema the sources are written against. */
export const MIGRATION_EXPORT_MIN_SCHEMA = 64;

/** Default chunk bounds: whichever is reached first closes a checkpoint. */
export const DEFAULT_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_CHUNK_MAX_RECORDS = 50_000;

/** How often the export yields to the event loop, in source rows. */
const YIELD_EVERY_ROWS = 256;
/** The least time between two progress reports inside one phase. */
const PROGRESS_INTERVAL_MS = 200;

export type MigrationExportPhase = "snapshot" | "verifying" | "exporting" | "finalizing" | "done";

/** A progress report. JSON-safe, so it crosses the worker boundary unchanged. */
export interface MigrationExportProgress {
  phase: MigrationExportPhase;
  /** The source being exported, during `exporting`. */
  source: string | null;
  sourceIndex: number;
  sourceCount: number;
  /** Source rows handled so far, of `rowsTotal` across every source. */
  rowsDone: number;
  rowsTotal: number;
  /** Chunk bytes durably written, resumed chunks included. */
  bytesWritten: number;
  /** This run continued an earlier one. */
  resumed: boolean;
}

export interface MigrationExportOptions {
  /** The live `volli.db`. Opened read-only, only to snapshot it. */
  sourcePath: string;
  /** Where the complete export lands. Must not exist yet. */
  outDir: string;
  /** The running build's version, recorded in the manifest. */
  appVersion: string;
  /** Throw away any staged progress and start over. */
  fresh?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: MigrationExportProgress) => void;
  /** Runs SQLite's `quick_check` on the snapshot before reading it. Default true. */
  integrityCheck?: boolean;
  chunkMaxBytes?: number;
  chunkMaxRecords?: number;
  now?: () => number;
  diskProbe?: DiskProbe;
  /** Whether a Working copy directory exists here. Default `fs.existsSync`. */
  pathExists?: (path: string) => boolean;
  /** The home directory redacted from git output in board events. Default `os.homedir()`. */
  homeDir?: string;
}

/** Facts the importer's preflight reads. Counts, not a verdict. */
export interface MigrationPreflightFacts {
  /** Sessions with follow-ups still queued. */
  pendingFollowUps: number;
  /** Notices recorded and not yet delivered. */
  undeliveredNotices: number;
  /** Automation Run messages not yet delivered. */
  undeliveredRunMessages: number;
  /** Worktree cleanups with no receipt. */
  openCleanupCommands: number;
  /** Executor attachments with no close recorded: a turn may still be running. */
  openAttachments: number;
  /** Board commands inside their seven-day replay window. */
  recentBoardCommands: number;
}

export interface MigrationExportManifest {
  format: typeof MIGRATION_EXPORT_FORMAT;
  exportId: string;
  appVersion: string;
  snapshotAt: number;
  completedAt: number;
  source: {
    schemaVersion: number;
    /** `session_usage_coverage.metered_from`: Sessions before it never show a total as complete. */
    usageMeteredFrom: number | null;
    /** Rows in every table of the snapshot. */
    tableRows: Record<string, number>;
  };
  placeholders: typeof MIGRATION_PLACEHOLDERS;
  preflight: MigrationPreflightFacts;
  tables: readonly MigrationTableDecision[];
  sources: Array<{ id: string; rows: number }>;
  streams: Array<{
    name: StreamName;
    destination: StreamDestination;
    records: number;
    bytes: number;
    chunks: Array<Omit<ChunkEntry, "stream">>;
  }>;
}

export interface MigrationExportResult {
  outDir: string;
  manifest: MigrationExportManifest;
  /** This run continued an earlier one. */
  resumed: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MigrationExportError("cancelled", "The export was cancelled.");
}

const yieldToEventLoop = () => new Promise<void>((done) => setImmediate(done));

/** Maps any failure to the code that names its recovery. */
function classify(error: unknown): MigrationExportError {
  if (error instanceof MigrationExportError) return error;
  if (isDiskFullError(error)) {
    return new MigrationExportError("disk_full", "The disk is full.", { cause: error });
  }
  if (error instanceof SourceCorruptError) {
    return new MigrationExportError("source_corrupt", error.message, { cause: error });
  }
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === "string" && code.startsWith("SQLITE_")) {
    return new MigrationExportError("source_corrupt", message, { cause: error });
  }
  // A system call's errno (EACCES, EROFS, ENOTDIR, EISDIR, …).
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
    return new MigrationExportError("io_failed", message, { cause: error });
  }
  return new MigrationExportError("internal", message, { cause: error });
}

/**
 * Deletes an export's staging area: what a caller does when the person
 * abandons a cancelled or failed export instead of resuming it. A complete
 * export at `outDir` is never touched.
 */
export async function discardPartialMigrationExport(outDir: string): Promise<void> {
  await rm(stagingDirOf(outDir), { recursive: true, force: true });
}

/** Runs the export to completion, resuming any staged progress. */
export async function exportMigrationSnapshot(
  options: MigrationExportOptions,
): Promise<MigrationExportResult> {
  try {
    // A worker pause is held by runMigrationExportInWorker in its parent,
    // which can release it even after Worker.terminate(). Direct callers own theirs.
    return await (isMainThread
      ? withProfileMaintenance(dirname(options.sourcePath), () => runExport(options))
      : runExport(options));
  } catch (error) {
    throw classify(error);
  }
}

async function runExport(options: MigrationExportOptions): Promise<MigrationExportResult> {
  if (existsSync(options.outDir)) {
    throw new MigrationExportError(
      "output_exists",
      `Something already exists at ${options.outDir}; an export never overwrites it.`,
    );
  }
  const release = await acquireExportLock(options.outDir);
  try {
    return await runLocked(options);
  } finally {
    await release();
  }
}

async function runLocked(options: MigrationExportOptions): Promise<MigrationExportResult> {
  const now = options.now ?? Date.now;
  const staging = stagingDirOf(options.outDir);
  if (options.fresh === true) await rm(staging, { recursive: true, force: true });
  throwIfAborted(options.signal);

  const reporter = progressReporter(options.onProgress);
  if (existsSync(join(staging, MANIFEST_FILE))) {
    // A previous run wrote the manifest and stopped before the rename.
    const { manifest } = await verifyMigrationExport(staging);
    await publish(staging, options.outDir);
    reporter.report({ phase: "done", resumed: true }, true);
    return { outDir: options.outDir, manifest, resumed: true };
  }

  let state = await readState(staging, options);
  const resumed = state !== null;
  reporter.set({ resumed });
  if (state === null) {
    reporter.report({ phase: "snapshot" }, true);
    state = await takeSnapshot(options, staging, now);
  }
  throwIfAborted(options.signal);

  const snapshot = new Database(join(staging, SNAPSHOT_FILE), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    reporter.report({ phase: "verifying" }, true);
    const checkpoints = await recoverJournal(staging);
    const onCheckpoint = (checkpoint: Checkpoint) => checkpoints.push(checkpoint);
    throwIfAborted(options.signal);
    const lookups = buildLookups(snapshot, {
      snapshotAt: state.snapshotAt,
      pathExists: options.pathExists,
      homeDir: options.homeDir,
    });
    const counts = EXPORT_SOURCES.map((source) => countRows(snapshot, source));
    reporter.set({
      sourceCount: EXPORT_SOURCES.length,
      rowsTotal: counts.reduce((sum, count) => sum + count, 0),
      bytesWritten: checkpoints.reduce(
        (sum, checkpoint) => sum + checkpoint.chunks.reduce((total, c) => total + c.bytes, 0),
        0,
      ),
    });
    const nextChunk = new Map<StreamName, number>();
    for (const chunk of checkpoints.flatMap((checkpoint) => checkpoint.chunks)) {
      nextChunk.set(
        chunk.stream,
        Math.max(nextChunk.get(chunk.stream) ?? 1, chunkIndex(chunk) + 1),
      );
    }

    let rowsBefore = 0;
    for (const [index, source] of EXPORT_SOURCES.entries()) {
      const own = checkpoints.filter((checkpoint) => checkpoint.source === source.id);
      const last = own.at(-1);
      throwIfAborted(options.signal);
      reporter.report(
        { phase: "exporting", source: source.id, sourceIndex: index, rowsDone: rowsBefore },
        true,
      );
      if (last?.done === true) {
        rowsBefore += counts[index]!;
        continue;
      }
      await exportSource(snapshot, source, {
        staging,
        lookups,
        startAfter: last?.rowsThrough ?? 0,
        nextChunk,
        maxBytes: options.chunkMaxBytes ?? DEFAULT_CHUNK_MAX_BYTES,
        maxRecords: options.chunkMaxRecords ?? DEFAULT_CHUNK_MAX_RECORDS,
        signal: options.signal,
        onCheckpoint,
        onRows: (rows) => reporter.report({ phase: "exporting", rowsDone: rowsBefore + rows }),
        onChunk: (bytes) => {
          reporter.add({ bytesWritten: bytes });
          reporter.report({ phase: "exporting" }, true);
        },
      });
      rowsBefore += counts[index]!;
    }

    reporter.report({ phase: "finalizing", source: null }, true);
    assertComplete(checkpoints, counts);
    const manifest = buildManifest(snapshot, state, checkpoints, counts, now());
    snapshot.close();
    await writeFileDurably(join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    await verifyMigrationExport(staging);
    await publish(staging, options.outDir);
    reporter.report({ phase: "done" }, true);
    return { outDir: options.outDir, manifest, resumed };
  } finally {
    if (snapshot.open) snapshot.close();
  }
}

// ---- snapshot ---------------------------------------------------------------

/**
 * The staged snapshot's state, when it is this export's to resume: the same
 * format, mapper, build and source, with its snapshot on disk. Anything else is
 * snapshotted again, so chunks from two mappings or two databases never mix.
 */
async function readState(
  staging: string,
  options: MigrationExportOptions,
): Promise<StagingState | null> {
  try {
    const state = JSON.parse(await readFile(join(staging, STATE_FILE), "utf8")) as StagingState;
    const ours =
      state.format === MIGRATION_EXPORT_FORMAT &&
      state.mapperVersion === MAPPER_VERSION &&
      state.appVersion === options.appVersion &&
      state.sourcePath === resolve(options.sourcePath) &&
      state.schemaVersion <= SCHEMA_HEAD;
    if (!ours || !existsSync(join(staging, SNAPSHOT_FILE))) return null;
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function databaseBytes(path: string, probe: DiskProbe): number {
  return probe.fileSize(path) + probe.fileSize(`${path}-wal`);
}

/**
 * Room for the snapshot (at most the database and its WAL) plus the chunks
 * (NDJSON runs about one and a half times the database; budgeted at two),
 * plus fixed headroom. Fails open, as `disk-preflight.ts` does: a probe that
 * cannot measure is not evidence of a full disk.
 */
export function migrationExportDiskRequirement(databaseSize: number): number {
  return 3 * databaseSize + MIGRATION_DISK_HEADROOM_BYTES;
}

function assertDiskSpace(sourcePath: string, staging: string, probe: DiskProbe): void {
  let required: number;
  let free: number;
  try {
    required = migrationExportDiskRequirement(databaseBytes(sourcePath, probe));
    free = probe.freeBytes(staging);
  } catch {
    return;
  }
  if (free < required) {
    throw new MigrationExportError(
      "disk_full",
      `The export needs ${required} bytes free next to ${staging}; ${free} are free.`,
    );
  }
}

async function takeSnapshot(
  options: MigrationExportOptions,
  staging: string,
  now: () => number,
): Promise<StagingState> {
  if (!existsSync(options.sourcePath)) {
    throw new MigrationExportError("source_unreadable", `No database at ${options.sourcePath}.`);
  }
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  assertDiskSpace(options.sourcePath, staging, options.diskProbe ?? nodeDiskProbe);
  throwIfAborted(options.signal);

  const target = join(staging, `${SNAPSHOT_FILE}.tmp`);
  let source: Database.Database;
  try {
    source = new Database(options.sourcePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new MigrationExportError("source_unreadable", `Cannot open ${options.sourcePath}.`, {
      cause: error,
    });
  }
  const snapshotAt = now();
  try {
    // Refuse a schema this build cannot read before copying a large file for nothing.
    assertSchema(source.pragma("user_version", { simple: true }) as number);
    source.prepare("VACUUM INTO ?").run(target);
  } catch (error) {
    /* v8 ignore next -- SQLITE_FULL from VACUUM INTO needs a full volume; the mapping itself is covered by the chunk-write test. */
    if (isDiskFullError(error) || error instanceof MigrationExportError) throw error;
    throw new MigrationExportError("source_unreadable", `Cannot snapshot ${options.sourcePath}.`, {
      cause: error,
    });
  } finally {
    source.close();
  }

  const copy = new Database(target, { readonly: true, fileMustExist: true });
  let schemaVersion: number;
  try {
    schemaVersion = copy.pragma("user_version", { simple: true }) as number;
    if (options.integrityCheck !== false) {
      const result = copy.pragma("quick_check", { simple: true });
      /* v8 ignore next 6 -- a fresh VACUUM INTO output fails this only when the disk corrupted what was just written; a malformed source fails the VACUUM itself. */
      if (result !== "ok") {
        throw new MigrationExportError(
          "source_corrupt",
          `The snapshot failed its integrity check: ${String(result)}`,
        );
      }
    }
  } finally {
    copy.close();
  }
  // SQLite does not fsync what VACUUM INTO writes; a durable state.json must
  // never point at a snapshot a power loss could tear.
  const handle = await open(target, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(target, join(staging, SNAPSHOT_FILE));
  const state: StagingState = {
    format: MIGRATION_EXPORT_FORMAT,
    mapperVersion: MAPPER_VERSION,
    exportId: randomUUID(),
    sourcePath: resolve(options.sourcePath),
    appVersion: options.appVersion,
    snapshotAt,
    schemaVersion,
  };
  await writeFileDurably(join(staging, STATE_FILE), `${JSON.stringify(state)}\n`);
  await syncDirectory(staging);
  return state;
}

function assertSchema(version: number): void {
  if (version < MIGRATION_EXPORT_MIN_SCHEMA || version > SCHEMA_HEAD) {
    throw new MigrationExportError(
      "schema_unsupported",
      `The database is at schema ${version}; this build exports ${MIGRATION_EXPORT_MIN_SCHEMA}–${SCHEMA_HEAD}.`,
    );
  }
}

// ---- journal recovery -------------------------------------------------------

function chunkIndex(chunk: ChunkEntry): number {
  return Number(basename(chunk.file, ".ndjson"));
}

/**
 * Keeps the longest prefix of the journal whose chunks are all intact, writes
 * the journal back as exactly that prefix, then deletes every stream file the
 * prefix does not name. A source whose checkpoints were cut is redone from its
 * last surviving one.
 *
 * The rewrite is unconditional: a torn final line (a crash or a full disk
 * mid-append) must not stay in the file, or the next append would be glued to
 * it and every later checkpoint would become unreadable.
 */
async function recoverJournal(staging: string): Promise<Checkpoint[]> {
  const journal = await readJournal(staging);
  const kept: Checkpoint[] = [];
  for (const checkpoint of journal) {
    const intact = await Promise.all(checkpoint.chunks.map((chunk) => chunkIntact(staging, chunk)));
    if (!intact.every(Boolean)) break;
    kept.push(checkpoint);
  }
  await rewriteJournal(staging, kept);
  await removeUnjournaledFiles(staging, kept);
  return kept;
}

/** Refuses to publish unless every source checkpointed all of its rows. */
function assertComplete(checkpoints: readonly Checkpoint[], counts: readonly number[]): void {
  for (const [index, source] of EXPORT_SOURCES.entries()) {
    const last = checkpoints.findLast((checkpoint) => checkpoint.source === source.id);
    /* v8 ignore next 6 -- the loop above finishes every source; this guards the publish against a future change that does not. */
    if (last?.done !== true || last.rowsThrough !== counts[index]) {
      throw new MigrationExportError(
        "integrity_failed",
        `Source ${source.id} is incomplete; the export was not published.`,
      );
    }
  }
}

// ---- one source -------------------------------------------------------------

function countRows(db: Database.Database, source: ExportSource): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM (${source.sql})`).get() as { n: number }).n;
}

interface SourceRun {
  staging: string;
  lookups: ReturnType<typeof buildLookups>;
  startAfter: number;
  nextChunk: Map<StreamName, number>;
  maxBytes: number;
  maxRecords: number;
  signal: AbortSignal | undefined;
  onCheckpoint(checkpoint: Checkpoint): void;
  onRows(rows: number): void;
  onChunk(bytes: number): void;
}

async function exportSource(
  db: Database.Database,
  source: ExportSource,
  run: SourceRun,
): Promise<void> {
  const prepared = source.prepare(db, run.lookups);
  const buffers = new Map<StreamName, string[]>();
  let bufferedBytes = 0;
  let bufferedRecords = 0;
  const emit: Emit = (stream, record) => {
    /* v8 ignore next 3 -- a programming error: the export tests drive every emit, and this turns a stream a source forgot to declare into a failure there. */
    if (!source.streams.includes(stream)) {
      throw new Error(`Source ${source.id} wrote to undeclared stream ${stream}`);
    }
    const line = `${JSON.stringify(record)}\n`;
    const list = buffers.get(stream) ?? [];
    list.push(line);
    buffers.set(stream, list);
    bufferedBytes += Buffer.byteLength(line);
    bufferedRecords += 1;
  };

  const checkpoint = async (rowsThrough: number, done: boolean) => {
    const chunks: ChunkEntry[] = [];
    for (const [stream, lines] of buffers) {
      const index = run.nextChunk.get(stream) ?? 1;
      const file = chunkFileName(stream, index);
      const bytes = Buffer.from(lines.join(""), "utf8");
      await writeFileDurably(join(run.staging, file), bytes);
      run.nextChunk.set(stream, index + 1);
      chunks.push({
        stream,
        file,
        records: lines.length,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      run.onChunk(bytes.length);
    }
    const entry: Checkpoint = { source: source.id, rowsThrough, done, chunks };
    await appendLineDurably(join(run.staging, JOURNAL_FILE), JSON.stringify(entry));
    run.onCheckpoint(entry);
    buffers.clear();
    bufferedBytes = 0;
    bufferedRecords = 0;
  };

  // A resumed source starts past the rows already written. The snapshot is
  // immutable and the query totally ordered, so OFFSET names the same rows on
  // every run, and SQLite skips them without handing each one to JavaScript.
  const rows = db.prepare(`${source.sql} LIMIT -1 OFFSET ?`).iterate(run.startAfter);
  const iterator = rows[Symbol.iterator]();
  let row = run.startAfter;
  try {
    for (let next = iterator.next(); next.done !== true; next = iterator.next()) {
      row += 1;
      source.map(next.value, prepared, run.lookups, emit);
      if (bufferedBytes >= run.maxBytes || bufferedRecords >= run.maxRecords) {
        await checkpoint(row, false);
        throwIfAborted(run.signal);
      }
      if (row % YIELD_EVERY_ROWS === 0) {
        run.onRows(row);
        await yieldToEventLoop();
        throwIfAborted(run.signal);
      }
    }
  } finally {
    iterator.return?.();
  }
  run.onRows(row);
  await checkpoint(row, true);
}

// ---- manifest and publish ---------------------------------------------------

/** The board command replay window (seven days), as receipts are kept. */
const BOARD_RECEIPT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function preflightFacts(db: Database.Database, snapshotAt: number): MigrationPreflightFacts {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    pendingFollowUps: count(
      "SELECT COUNT(*) AS n FROM session_follow_up_queue WHERE pending_count > 0",
    ),
    undeliveredNotices: count("SELECT COUNT(*) AS n FROM host_notice_outbox WHERE receipt IS NULL"),
    undeliveredRunMessages: count(
      "SELECT COUNT(*) AS n FROM automation_run_deliveries WHERE delivered_at IS NULL",
    ),
    openCleanupCommands: count(
      `SELECT COUNT(*) AS n FROM worktree_cleanup_commands c
        WHERE NOT EXISTS (SELECT 1 FROM worktree_cleanup_receipts r WHERE r.command_id = c.id)`,
    ),
    openAttachments: count(
      "SELECT COUNT(*) AS n FROM session_attachments WHERE closed_sequence IS NULL",
    ),
    recentBoardCommands: (
      db
        .prepare("SELECT COUNT(*) AS n FROM board_command_receipts WHERE created_at > ?")
        .get(snapshotAt - BOARD_RECEIPT_WINDOW_MS) as { n: number }
    ).n,
  };
}

function buildManifest(
  db: Database.Database,
  state: StagingState,
  checkpoints: readonly Checkpoint[],
  counts: readonly number[],
  completedAt: number,
): MigrationExportManifest {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
  const tableRows: Record<string, number> = {};
  for (const table of tables) {
    tableRows[table] = (
      db.prepare(`SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`).get() as {
        n: number;
      }
    ).n;
  }
  const metered = db.prepare("SELECT metered_from FROM session_usage_coverage LIMIT 1").get() as
    | { metered_from: number }
    | undefined;
  const chunks = checkpoints.flatMap((checkpoint) => checkpoint.chunks);
  return {
    format: MIGRATION_EXPORT_FORMAT,
    exportId: state.exportId,
    appVersion: state.appVersion,
    snapshotAt: state.snapshotAt,
    completedAt,
    source: {
      schemaVersion: state.schemaVersion,
      usageMeteredFrom: metered?.metered_from ?? null,
      tableRows,
    },
    placeholders: MIGRATION_PLACEHOLDERS,
    preflight: preflightFacts(db, state.snapshotAt),
    tables: MIGRATION_TABLE_DECISIONS,
    sources: EXPORT_SOURCES.map((source, index) => ({ id: source.id, rows: counts[index]! })),
    streams: (Object.keys(STREAM_DESTINATIONS) as StreamName[]).map((name) => {
      const own = chunks
        .filter((chunk) => chunk.stream === name)
        .toSorted((a, b) => chunkIndex(a) - chunkIndex(b))
        .map(({ stream: _stream, ...rest }) => rest);
      return {
        name,
        destination: STREAM_DESTINATIONS[name],
        records: own.reduce((sum, chunk) => sum + chunk.records, 0),
        bytes: own.reduce((sum, chunk) => sum + chunk.bytes, 0),
        chunks: own,
      };
    }),
  };
}

/** Removes the working files and moves the staged export into place in one rename. */
async function publish(staging: string, outDir: string): Promise<void> {
  for (const file of [SNAPSHOT_FILE, STATE_FILE, JOURNAL_FILE]) {
    await rm(join(staging, `${file}.tmp`), { force: true });
    await rm(join(staging, file), { force: true });
  }
  await rm(join(staging, `${MANIFEST_FILE}.tmp`), { force: true });
  await syncDirectory(staging);
  await mkdir(dirname(outDir), { recursive: true });
  await rename(staging, outDir);
  await syncDirectory(dirname(outDir));
}

// ---- progress ---------------------------------------------------------------

function progressReporter(onProgress: MigrationExportOptions["onProgress"]) {
  const current: MigrationExportProgress = {
    phase: "snapshot",
    source: null,
    sourceIndex: 0,
    sourceCount: EXPORT_SOURCES.length,
    rowsDone: 0,
    rowsTotal: 0,
    bytesWritten: 0,
    resumed: false,
  };
  let lastAt = 0;
  return {
    set(patch: Partial<MigrationExportProgress>) {
      Object.assign(current, patch);
    },
    add(patch: { bytesWritten: number }) {
      current.bytesWritten += patch.bytesWritten;
    },
    /** Reports now when `force` or the phase changed, else at most once per interval. */
    report(patch: Partial<MigrationExportProgress>, force = false) {
      const phaseChanged = patch.phase !== undefined && patch.phase !== current.phase;
      Object.assign(current, patch);
      if (onProgress === undefined) return;
      const at = Date.now();
      if (!force && !phaseChanged && at - lastAt < PROGRESS_INTERVAL_MS) return;
      lastAt = at;
      onProgress({ ...current });
    },
  };
}
