/**
 * The bounded-memory backup writer and verifier.
 *
 * The original bundle path (`createBackupBundle` / `readBackupBundle`) holds a
 * whole profile in memory, which is fine for a fixture and impossible for the
 * profile VC-972 must protect: 1.59 GB, 2.15 million rows. A daily background
 * backup cannot reserve that much RSS beside a running app, and a worker with
 * a 192 MB old-generation limit cannot come close. So this module writes the
 * SAME version-1 bundle — same tables, columns, redactions, row order, archive
 * entries, manifest and data document bytes — while holding one row, one
 * artifact chunk and one scratch-page at a time.
 *
 * It reuses the in-memory path rather than re-implementing the format:
 * `planBackupTables`, `backupDocumentHeader`, `iterateBackupRows`,
 * `encodeBackupRow`, `backupDataDocumentChunks`, `backupManifestChunks` and
 * every manifest/problem rule come from `data-document.ts` and `bundle.ts`.
 * The streaming writer's bytes are compared with the in-memory writer's in
 * `streaming.test.ts`, entry for entry.
 *
 * THE SNAPSHOT IS THE CALLER'S. `writeBackupBundleFile` reads `db` only; the
 * production worker hands it a `db.backup()` snapshot opened readonly in its
 * own work directory, so nothing here opens a write transaction on the live
 * profile, and a pause for memory pressure cannot let the data move under the
 * two-pass write. Artifacts (blobs, transcripts) are not snapshotable, so each
 * one is hashed in the first pass and re-hashed as it is written in the second;
 * a file that changed in between aborts the bundle instead of shipping bytes
 * that disagree with the manifest.
 *
 * MEMORY, PRECISELY. The writer keeps: one encoded row, the current JSON
 * chunk (64 KB), the current artifact chunk, and a small SQLite page cache for
 * its scratch inventory (2 MB). The manifest and the transcript-reference set
 * live on disk in that scratch database because both grow with the profile.
 * The verifier keeps: one JSON token, one row, one decoded payload, one
 * archive chunk, and a 2 MB page cache; its inventory, link index and artifact
 * coverage checks are SQL against a scratch database. Neither path builds a
 * `BackupDataDocument` or a `ReadBackupBundle`.
 *
 * DISK. The writer's only staging is inside a unique directory under
 * `workDir`: a scratch SQLite file (manifest inventory + transcript ids) and
 * the gzip archive that is renamed to `outputPath` and verified there (kept
 * on failure as evidence). It never writes an uncompressed data document,
 * which would be several gigabytes for a profile this size. Peak extra disk is
 * therefore roughly the bundle size plus the scratch databases — the ticket
 * report carries the measured estimates.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, rmSync } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import Database from "better-sqlite3";

import { blobFilePath } from "../blob-store";
import {
  createFileTranscriptArtifactStore,
  transcriptReferenceForId,
} from "../session-runtime/transcript-artifacts";
import {
  ArchiveError,
  ArchiveStreamReader,
  buildTarHeader,
  tarEndBlocks,
  tarPadding,
} from "./archive";
import type { ArchivePathRegistry, ArchiveStreamEntry } from "./archive";
import {
  BACKUP_BUNDLE_FORMAT,
  BACKUP_BUNDLE_VERSION,
  BLOB_PREFIX,
  DATA_PATH,
  MANIFEST_PATH,
  TRANSCRIPT_PREFIX,
  BackupBundleError,
  artifactHashProblem,
  artifactSizeProblem,
  backupManifestChunks,
  blobArtifactPath,
  duplicateManifestEntryProblem,
  expectedPathProblem,
  manifestEntryProblems,
  manifestFieldProblems,
  manifestFormatProblems,
  manifestMissesDataProblem,
  manifestSchemaProblem,
  misplacedManifestEntryProblem,
  missingBlobArtifactProblem,
  missingBundleFileProblem,
  missingManifestProblem,
  missingTranscriptArtifactProblem,
  strayBlobArtifactProblem,
  strayTranscriptArtifactProblem,
  transcriptArtifactPath,
  unlistedBundleFileProblem,
} from "./bundle";
import type { BackupEntryKind, BackupManifestEntry } from "./bundle";
import {
  BACKUP_DATA_FORMAT,
  BACKUP_DATA_VERSION,
  backupDataDocumentChunks,
  backupDocumentHeader,
  isBackupValue,
  iterateBackupRows,
  planBackupTables,
  recordKeyOf,
  referenceSchema,
  tablesAtVersion,
  walkTranscriptReferences,
} from "./data-document";
import type {
  BackupDocumentHeader,
  BackupProblem,
  BackupTablePlan,
  BackupValue,
} from "./data-document";
import { BACKUP_INCLUDED_TABLES } from "./decisions";

/** Rows between checkpoint calls while streaming a document. */
const CHECKPOINT_ROWS = 2_048;
/** Archive or artifact bytes between checkpoint calls. */
const CHECKPOINT_BYTES = 8 * 1024 * 1024;
/** Artifacts between checkpoint calls. */
const CHECKPOINT_ARTIFACTS = 32;
/** Read chunks between checkpoint calls while hashing/writing one artifact. */
const CHECKPOINT_CHUNKS = 128;
/** Problems of one kind reported before the rest are summarized. */
const MAX_REPORTED_PROBLEMS = 100;

/**
 * Scratch writes between `COMMIT`/`BEGIN` pairs.
 *
 * The scratch database is private and disposable, but leaving millions of
 * inserts in one transaction still makes SQLite spill dirty pages under a
 * deliberately tiny cache. Committing every few thousand rows bounds that
 * working set; `synchronous = OFF` means the commit itself is cheap, and a
 * crash loses only the in-progress verification.
 */
const SCRATCH_COMMIT_INTERVAL = 4_096;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const TRANSCRIPT_PREFIX_LENGTH = "sha256:".length;

/** The columns a transcript reference can hide in, per table. */
const TRANSCRIPT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session_events: ["payload"],
  session_commands: ["intent", "route"],
};

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

export interface WriteBackupBundleFileOptions {
  /**
   * An immutable snapshot of the profile database.
   *
   * The caller owns the snapshot (`db.backup()` to a file opened readonly);
   * this writer never writes to it, never opens a transaction on it, and never
   * assumes the live database is stable. Rows are read with `iterate()`.
   */
  db: Database.Database;
  blobsRoot: string;
  transcriptsRoot: string;
  appVersion: string;
  now: number;
  /** Where the finished archive is placed before verification (the caller's `.partial`). */
  outputPath: string;
  /** A caller-owned directory for scratch files; unique names are minted here. */
  workDir: string;
  /**
   * Awaited at bounded row/byte/artifact intervals. It may pause (memory
   * pressure, a profile migration or move) and may reject to cancel; the
   * staging directory is removed either way.
   */
  checkpoint?: () => Promise<void>;
}

export interface WrittenBackupBundleFile {
  /** The published archive's size, from the filesystem. */
  sizeBytes: number;
}

/**
 * Writes one verified version-1 bundle to `outputPath`.
 *
 * The archive is built under `workDir`, RENAMED to `outputPath`, and then
 * verified there by {@link verifyBackupBundleFile}'s implementation. That
 * order matters to the caller: `outputPath` is the automatic backup's
 * `.partial` file, and a backup that failed its own check is evidence worth
 * keeping — the production worker renames it to `.failed` and reports the
 * problems. So this function removes a partial archive only when it never
 * became a complete archive at all (a write, read or cancellation failure
 * during pass two). A rejection from verification leaves the archive exactly
 * at `outputPath`; a resolved promise is the only signal that its bytes are a
 * verified v1 bundle.
 *
 * The caller publishes it under its final name. `workDir` and `outputPath` are
 * assumed to share a filesystem (the worker puts both under the output
 * directory), which is what makes the staged-to-output move one atomic
 * `rename` and keeps a single copy on disk.
 *
 * Two passes over the snapshot are deliberate. The manifest must be the first
 * archive entry and must name the size and SHA-256 of the data document and of
 * every artifact, so the first pass measures and the second pass writes and
 * re-checks. It is CPU twice and read-once-per-pass, never memory twice.
 */
export async function writeBackupBundleFile(
  options: WriteBackupBundleFileOptions,
): Promise<WrittenBackupBundleFile> {
  await mkdir(options.workDir, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(options.workDir, "backup-stream-"));
  const archivePath = join(staging, "bundle.tar.gz.partial");
  let movedToOutput = false;
  try {
    await options.checkpoint?.();
    await writeBundleArchive(options, staging, archivePath);
    await rename(archivePath, options.outputPath);
    movedToOutput = true;
    await options.checkpoint?.();
    const verified = await verifyBackupBundleFile(options.outputPath, staging, options.checkpoint);
    if (!verified.ok) throw verificationError(verified.problems);
    return { sizeBytes: (await stat(options.outputPath)).size };
  } finally {
    if (!movedToOutput) await rm(archivePath, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * What a verified bundle tells its caller without holding the bundle.
 *
 * Deliberately a summary: the manifest's entry inventory and the data
 * document's rows are not returned, because a caller that needs them needs a
 * restore, and a restore reads them from the archive. Counts and the manifest
 * digest are enough for a backup listing and a sidecar record.
 */
export interface VerifiedBackupBundleFile {
  /** SHA-256 of the manifest bytes, for a sidecar that pins one bundle. */
  manifestSha256: string;
  manifest: {
    format: typeof BACKUP_BUNDLE_FORMAT;
    bundleVersion: number;
    appVersion: string;
    schemaVersion: number;
    createdAt: string;
    entries: { data: number; blob: number; transcript: number };
  };
  document: {
    schemaVersion: number;
    appVersion: string;
    createdAt: string;
    usageCoverage: { meteredFrom: number };
    /** Rows carried per included table, in the document's order. */
    tables: Record<string, number>;
  };
}

export type VerifyBackupBundleFileResult =
  | { ok: true; bundle: VerifiedBackupBundleFile }
  | { ok: false; problems: BackupProblem[] };

/**
 * Verifies a bundle FILE with bounded memory: container, manifest, inventory
 * hashes, data-document shape, record links and artifact coverage.
 *
 * The checks and their sentences are the ones `readBackupBundle` applies; the
 * difference is that the archive is read as a stream and the data document is
 * parsed as JSON tokens into disk-backed indexes, so a 2.15-million-row
 * profile verifies without materializing its document. `workDir` receives a
 * unique scratch directory, removed before return.
 */
export async function verifyBackupBundleFile(
  filePath: string,
  workDir: string,
  checkpoint?: () => Promise<void>,
): Promise<VerifyBackupBundleFileResult> {
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(workDir, "backup-verify-"));
  try {
    return await verifyBundleFile(filePath, staging, checkpoint);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------- */
/* Writer                                                                    */
/* ------------------------------------------------------------------------- */

interface WriterContext {
  db: Database.Database;
  blobsRoot: string;
  transcriptsRoot: string;
  header: BackupDocumentHeader;
  plans: readonly BackupTablePlan[];
  checkpoint?: (() => Promise<void>) | undefined;
  scratch: ScratchDatabase;
}

async function writeBundleArchive(
  options: WriteBackupBundleFileOptions,
  staging: string,
  archivePath: string,
): Promise<void> {
  const db = options.db;
  const plans = planBackupTables(db);
  const header = backupDocumentHeader(db, { appVersion: options.appVersion, now: options.now });
  const scratch = new ScratchDatabase(join(staging, "write-inventory.db"));
  const context: WriterContext = {
    db,
    blobsRoot: options.blobsRoot,
    transcriptsRoot: options.transcriptsRoot,
    header,
    plans,
    checkpoint: options.checkpoint,
    scratch,
  };
  try {
    scratch.exec(WRITER_INVENTORY_SCHEMA);
    scratch.exec("BEGIN");
    const data = await measureDataDocument(context);
    scratch.insertManifestEntry({ path: DATA_PATH, kind: "data", ...data });
    await measureBlobArtifacts(context);
    await measureTranscriptArtifacts(context);
    const manifestSize = measureManifest(context).size;
    const manifestSha256 = measureManifest(context).sha256;
    await options.checkpoint?.();
    await writeGzipArchive(context, archivePath, {
      manifestSize,
      dataSize: data.sizeBytes,
      dataSha256: data.sha256,
      manifestSha256,
    });
  } finally {
    scratch.close();
  }
}

/**
 * Pass one, data: serialize the document into a hash and a byte count.
 *
 * The same chunk generator the write pass uses, so the measurement is of the
 * exact bytes that will be emitted. Observed rows also feed the scratch
 * transcript-reference table — the writer cannot hold hundreds of thousands of
 * `sha256:…` ids in memory either.
 */
async function measureDataDocument(
  context: WriterContext,
): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of backupDataDocumentChunks(
    context.header,
    dataSources(context, (plan, row) => observeTranscriptReferences(context, plan, row)),
    { checkpoint: context.checkpoint },
  )) {
    sizeBytes += Buffer.byteLength(chunk, "utf8");
    hash.update(chunk, "utf8");
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

function dataSources(
  context: WriterContext,
  onRow?: (plan: BackupTablePlan, row: readonly BackupValue[]) => void,
): { name: string; columns: readonly string[]; rows: Iterable<readonly BackupValue[]> }[] {
  return context.plans.map((plan) => ({
    name: plan.table,
    columns: plan.columns,
    rows: (function* () {
      for (const row of iterateBackupRows(context.db, plan)) {
        onRow?.(plan, row);
        yield row;
      }
    })(),
  }));
}

function observeTranscriptReferences(
  context: WriterContext,
  plan: BackupTablePlan,
  row: readonly BackupValue[],
): void {
  const columns = TRANSCRIPT_COLUMNS[plan.table];
  if (columns === undefined) return;
  for (const column of columns) {
    const index = plan.columns.indexOf(column);
    const value = row[index];
    if (typeof value !== "string") continue;
    const found = new Set<string>();
    try {
      walkTranscriptReferences(JSON.parse(value), found);
    } catch {
      // A row whose JSON no longer parses cannot name a transcript; the same
      // tolerance `collectTranscriptReferences` shows a bundle reader.
      continue;
    }
    for (const id of found) context.scratch.insertTranscriptReference(id);
  }
}

/**
 * Pass one, attachments: hash every blob the data document references.
 *
 * Read from the same `blobs` table, in the same order `collectBlobHashes`
 * produces (sorted by hash), so the manifest order is unchanged. The file is
 * streamed; a single large attachment never lands in memory.
 */
async function measureBlobArtifacts(context: WriterContext): Promise<void> {
  const plan = context.plans.find((candidate) => candidate.table === "blobs");
  if (plan === undefined || !plan.columns.includes("hash")) return;
  const rows = context.db
    .prepare('SELECT "hash" FROM "blobs" ORDER BY "hash" COLLATE BINARY')
    .raw()
    .iterate() as IterableIterator<unknown[]>;
  try {
    for (const row of rows) {
      const hash = row[0];
      if (typeof hash !== "string") continue;
      const sizeBytes = await measureBlob(context, hash);
      context.scratch.insertManifestEntry({
        path: blobArtifactPath(hash),
        kind: "blob",
        sizeBytes,
        sha256: hash,
      });
    }
  } finally {
    rows.return?.();
  }
}

async function measureBlob(context: WriterContext, hash: string): Promise<number> {
  if (!SHA256_HEX.test(hash)) {
    throw new BackupBundleError(`Blob hash ${JSON.stringify(hash)} is not a SHA-256 digest.`);
  }
  const digest = createHash("sha256");
  let sizeBytes = 0;
  let chunks = 0;
  try {
    for await (const chunk of createReadStream(blobFilePath(context.blobsRoot, hash))) {
      digest.update(chunk);
      sizeBytes += chunk.length;
      chunks += 1;
      if (chunks % CHECKPOINT_CHUNKS === 0) await context.checkpoint?.();
    }
  } catch (error) {
    throw blobReadError(hash, error);
  }
  if (digest.digest("hex") !== hash) {
    throw new BackupBundleError(`Attachment bytes for ${hash} no longer match their own hash.`);
  }
  return sizeBytes;
}

function blobReadError(hash: string, error: unknown): BackupBundleError {
  if (isMissing(error)) {
    return new BackupBundleError(`Attachment bytes for ${hash} are missing from the blob store.`);
  }
  return new BackupBundleError(`Attachment bytes for ${hash} could not be read.`, { cause: error });
}

/**
 * Pass one, transcripts: hash the canonical bytes of every referenced
 * transcript, in sorted reference order.
 *
 * The references themselves came from pass one's rows into the scratch table.
 * The store verifies each digest on read; it is asked for one artifact at a
 * time, and the bytes are released before the next reference.
 */
async function measureTranscriptArtifacts(context: WriterContext): Promise<void> {
  const store = createFileTranscriptArtifactStore(context.transcriptsRoot);
  // Keyset batches, not an open cursor: the same scratch connection must be
  // able to insert the manifest entry for the transcript being measured, and
  // better-sqlite3 refuses a second statement while a cursor is open. One
  // batch is bounded (256 ids), so a million references cost 4 MB at a time.
  let after = "";
  let sinceCheckpoint = 0;
  for (;;) {
    const batch = context.scratch.db
      .prepare("SELECT id FROM transcript_refs WHERE id > ? ORDER BY id COLLATE BINARY LIMIT 256")
      .raw()
      .all(after) as string[][];
    if (batch.length === 0) break;
    for (const row of batch) {
      const id = row[0];
      if (typeof id !== "string") continue;
      after = id;
      let sizeBytes = 0;
      try {
        let chunks = 0;
        for await (const bytes of store.readCanonicalChunks(transcriptReferenceForId(id))) {
          sizeBytes += bytes.length;
          if (++chunks % CHECKPOINT_CHUNKS === 0) await context.checkpoint?.();
        }
      } catch (error) {
        throw transcriptReadError(id, error);
      }
      const digest = id.slice(TRANSCRIPT_PREFIX_LENGTH);
      context.scratch.insertManifestEntry({
        path: transcriptArtifactPath(id),
        kind: "transcript",
        sizeBytes,
        sha256: digest,
      });
      sinceCheckpoint += 1;
      if (sinceCheckpoint % CHECKPOINT_ARTIFACTS === 0) await context.checkpoint?.();
    }
  }
}

/**
 * The manifest's own byte length and digest, measured from the inventory.
 *
 * The manifest is not an entry in itself, but its tar header needs its size
 * before it can be written, and the writer checks the bytes it emits against
 * this measurement.
 */
function measureManifest(context: WriterContext): { size: number; sha256: string } {
  const hash = createHash("sha256");
  let size = 0;
  for (const chunk of backupManifestChunks(
    {
      format: BACKUP_BUNDLE_FORMAT,
      bundleVersion: BACKUP_BUNDLE_VERSION,
      appVersion: context.header.appVersion,
      schemaVersion: context.header.schemaVersion,
      createdAt: context.header.createdAt,
    },
    manifestEntries(context.scratch),
  )) {
    size += Buffer.byteLength(chunk, "utf8");
    hash.update(chunk, "utf8");
  }
  return { size, sha256: hash.digest("hex") };
}

interface ArchiveWritePlan {
  manifestSize: number;
  manifestSha256: string;
  dataSize: number;
  dataSha256: string;
}

/**
 * Pass two: emit the tar stream through gzip, checking every byte against the
 * inventory pass one measured.
 *
 * Entry order is the version-1 order — manifest, data, blobs sorted by hash,
 * transcripts sorted by id — and each body is either re-read from an artifact
 * or re-serialized from the snapshot. A hash or size that does not match the
 * manifest aborts rather than publishing a bundle whose inventory lies.
 */
async function writeGzipArchive(
  context: WriterContext,
  archivePath: string,
  plan: ArchiveWritePlan,
): Promise<void> {
  await pipeline(
    Readable.from(archiveChunks(context, plan), { objectMode: false }),
    createGzip({ level: 9 }),
    createWriteStream(archivePath, { mode: 0o600 }),
  );
  const handle = await open(archivePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function* archiveChunks(
  context: WriterContext,
  plan: ArchiveWritePlan,
): AsyncGenerator<string | Buffer> {
  const checkpoint = context.checkpoint;

  // The manifest first, exactly as the in-memory writer orders the archive.
  yield buildTarHeader(MANIFEST_PATH, plan.manifestSize);
  let manifestWritten = 0;
  const manifestHash = createHash("sha256");
  for (const chunk of backupManifestChunks(
    {
      format: BACKUP_BUNDLE_FORMAT,
      bundleVersion: BACKUP_BUNDLE_VERSION,
      appVersion: context.header.appVersion,
      schemaVersion: context.header.schemaVersion,
      createdAt: context.header.createdAt,
    },
    manifestEntries(context.scratch),
  )) {
    manifestWritten += Buffer.byteLength(chunk, "utf8");
    manifestHash.update(chunk, "utf8");
    yield chunk;
  }
  if (manifestWritten !== plan.manifestSize || manifestHash.digest("hex") !== plan.manifestSha256) {
    throw new BackupBundleError("The backup manifest changed while it was being written.");
  }
  if (tarPadding(plan.manifestSize) > 0) yield Buffer.alloc(tarPadding(plan.manifestSize));
  await checkpoint?.();

  // The data document.
  yield buildTarHeader(DATA_PATH, plan.dataSize);
  let dataWritten = 0;
  const dataHash = createHash("sha256");
  for await (const chunk of backupDataDocumentChunks(context.header, dataSources(context), {
    checkpoint,
  })) {
    dataWritten += Buffer.byteLength(chunk, "utf8");
    dataHash.update(chunk, "utf8");
    yield chunk;
  }
  if (dataWritten !== plan.dataSize || dataHash.digest("hex") !== plan.dataSha256) {
    throw new BackupBundleError("The backup data changed between measuring and writing it.");
  }
  if (tarPadding(plan.dataSize) > 0) yield Buffer.alloc(tarPadding(plan.dataSize));
  await checkpoint?.();

  // Every artifact, in manifest order, re-hashed as it is written.
  const store = createFileTranscriptArtifactStore(context.transcriptsRoot);
  let artifactsWritten = 0;
  for (const entry of manifestEntries(context.scratch)) {
    if (entry.kind === "data") continue;
    yield buildTarHeader(entry.path, entry.sizeBytes);
    const digest = createHash("sha256");
    let sizeBytes = 0;
    if (entry.kind === "blob") {
      const hash = entry.path.slice(BLOB_PREFIX.length);
      let chunks = 0;
      try {
        for await (const chunk of createReadStream(blobFilePath(context.blobsRoot, hash))) {
          sizeBytes += chunk.length;
          digest.update(chunk);
          yield chunk;
          chunks += 1;
          if (chunks % CHECKPOINT_CHUNKS === 0) await checkpoint?.();
        }
      } catch (error) {
        throw blobReadError(hash, error);
      }
      if (sizeBytes !== entry.sizeBytes || digest.digest("hex") !== hash) {
        throw new BackupBundleError(`Attachment bytes for ${hash} no longer match their own hash.`);
      }
    } else {
      const id = `sha256:${entry.path.slice(
        TRANSCRIPT_PREFIX.length,
        entry.path.length - ".json".length,
      )}`;
      try {
        let chunks = 0;
        for await (const bytes of store.readCanonicalChunks(transcriptReferenceForId(id))) {
          sizeBytes += bytes.length;
          digest.update(bytes);
          yield bytes;
          if (++chunks % CHECKPOINT_CHUNKS === 0) await checkpoint?.();
        }
      } catch (error) {
        throw transcriptReadError(id, error);
      }
      if (sizeBytes !== entry.sizeBytes || digest.digest("hex") !== entry.sha256) {
        throw new BackupBundleError(`Transcript ${id} no longer matches its own digest.`);
      }
    }
    if (tarPadding(entry.sizeBytes) > 0) yield Buffer.alloc(tarPadding(entry.sizeBytes));
    artifactsWritten += 1;
    if (artifactsWritten % CHECKPOINT_ARTIFACTS === 0) await checkpoint?.();
  }
  yield tarEndBlocks();
}

function transcriptReadError(id: string, error: unknown): BackupBundleError {
  return new BackupBundleError(
    isMissing(error)
      ? `Transcript ${id} is missing from the transcript store.`
      : `Transcript ${id} no longer matches its own digest.`,
    { cause: error },
  );
}

function verificationError(problems: readonly BackupProblem[]): BackupBundleError {
  const shown = problems
    .slice(0, 3)
    .map((problem) => problem.message)
    .join(" ");
  const rest = problems.length > 3 ? ` (and ${problems.length - 3} more problems)` : "";
  return new BackupBundleError(`The written backup failed verification: ${shown}${rest}`);
}

/* ------------------------------------------------------------------------- */
/* Scratch SQLite                                                            */
/* ------------------------------------------------------------------------- */

const WRITER_INVENTORY_SCHEMA = `
CREATE TABLE manifest_entries (
  seq        INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256     TEXT NOT NULL
);
CREATE TABLE transcript_refs (id TEXT PRIMARY KEY) WITHOUT ROWID;
`;

const VERIFIER_SCRATCH_SCHEMA = `
CREATE TABLE inventory (
  path       TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  sha256     TEXT NOT NULL
);
CREATE TABLE manifest_entries (
  seq        INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256     TEXT NOT NULL
);
CREATE TABLE archive_paths (path TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE blob_refs (hash TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE transcript_refs (id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE link_targets (
  fk  TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (fk, key)
) WITHOUT ROWID;
CREATE TABLE link_refs (
  fk        TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  key       TEXT NOT NULL
);
CREATE TABLE project_ids (seq INTEGER PRIMARY KEY, id TEXT NOT NULL);
`;

/**
 * A private, disposable SQLite database for bookkeeping that grows with the
 * profile.
 *
 * The page cache is deliberately tiny (2 MB): the point is that a million
 * transcript ids, a manifest of a hundred thousand entries and an index of
 * every archive path cost disk, not RSS. `journal_mode = OFF` and
 * `synchronous = OFF` are safe because nothing here needs durability — a crash
 * loses a backup attempt, not data.
 */
class ScratchDatabase {
  readonly db: Database.Database;
  readonly #path: string;
  readonly #statements = new Map<string, Database.Statement>();
  #writesSinceCommit = 0;

  constructor(path: string) {
    this.#path = path;
    this.db = new Database(path);
    this.db.pragma("journal_mode = OFF");
    this.db.pragma("synchronous = OFF");
    this.db.pragma("cache_size = -2048");
    this.db.pragma("temp_store = FILE");
  }

  #statement(sql: string): Database.Statement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * Runs one write and periodically restarts the transaction.
   *
   * Every caller is between cursors on THIS connection: inserts happen while
   * an archive or source-database cursor is open, never while a scratch
   * SELECT is being iterated, so a commit here cannot invalidate a reader.
   */
  #write<T>(run: () => T): T {
    const result = run();
    this.#writesSinceCommit += 1;
    if (this.#writesSinceCommit >= SCRATCH_COMMIT_INTERVAL) {
      this.#writesSinceCommit = 0;
      this.db.exec("COMMIT");
      this.db.exec("BEGIN");
    }
    return result;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Closing a scratch handle must never mask the failure being reported.
    }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try {
        rmSync(`${this.#path}${suffix}`, { force: true });
      } catch {
        // Best effort; the caller's work directory is removed as a whole.
      }
    }
  }

  /* Writer inventory. */

  insertManifestEntry(entry: BackupManifestEntry): void {
    this.#write(() =>
      this.#statement(
        "INSERT INTO manifest_entries (path, kind, size_bytes, sha256) VALUES (?, ?, ?, ?)",
      ).run(entry.path, entry.kind, entry.sizeBytes, entry.sha256),
    );
  }

  insertTranscriptReference(id: string): void {
    this.#write(() =>
      this.#statement("INSERT OR IGNORE INTO transcript_refs (id) VALUES (?)").run(id),
    );
  }

  /* Verifier inventory and indexes. */

  insertInventory(path: string, sizeBytes: number, sha256: string): void {
    this.#write(() =>
      this.#statement("INSERT INTO inventory (path, size_bytes, sha256) VALUES (?, ?, ?)").run(
        path,
        sizeBytes,
        sha256,
      ),
    );
  }

  /** Archive path de-duplication on disk, so a large entry count costs no heap. */
  archivePathRegistry(): ArchivePathRegistry {
    const statement = this.#statement("INSERT OR IGNORE INTO archive_paths (path) VALUES (?)");
    return {
      add: (path: string): boolean => this.#write(() => statement.run(path)).changes > 0,
    };
  }

  insertBlobRef(hash: string): void {
    this.#write(() =>
      this.#statement("INSERT OR IGNORE INTO blob_refs (hash) VALUES (?)").run(hash),
    );
  }

  insertTranscriptRef(id: string): void {
    this.#write(() =>
      this.#statement("INSERT OR IGNORE INTO transcript_refs (id) VALUES (?)").run(id),
    );
  }

  insertLinkRef(fk: string, rowIndex: number, key: string): void {
    this.#write(() =>
      this.#statement("INSERT INTO link_refs (fk, row_index, key) VALUES (?, ?, ?)").run(
        fk,
        rowIndex,
        key,
      ),
    );
  }

  insertLinkTarget(fk: string, key: string): void {
    this.#write(() =>
      this.#statement("INSERT OR IGNORE INTO link_targets (fk, key) VALUES (?, ?)").run(fk, key),
    );
  }

  /** A project id the data document carries, in document order, for a restore's mapping. */
  insertProjectId(id: string): void {
    this.#write(() => this.#statement("INSERT INTO project_ids (id) VALUES (?)").run(id));
  }

  /* A restore's reads of a finished verification. */

  /** Project ids in document order, in keyset batches so no cursor stays open. */
  *projectIds(): Generator<string> {
    let after = 0;
    for (;;) {
      const batch = this.#statement(
        "SELECT seq, id FROM project_ids WHERE seq > ? ORDER BY seq LIMIT 256",
      )
        .raw()
        .all(after) as [number, string][];
      if (batch.length === 0) return;
      for (const [seq, id] of batch) {
        after = seq;
        yield id;
      }
    }
  }

  hasProjectId(id: string): boolean {
    return this.#statement("SELECT 1 FROM project_ids WHERE id = ? LIMIT 1").get(id) !== undefined;
  }

  inventoryCount(): number {
    return (this.#statement("SELECT COUNT(*) AS n FROM inventory").get() as { n: number }).n;
  }

  /** Manifest entries in manifest order, in keyset batches so no cursor stays open. */
  *manifestEntriesInBatches(): Generator<BackupManifestEntry> {
    let after = 0;
    for (;;) {
      const batch = this.#statement(
        "SELECT seq, path, kind, size_bytes, sha256 FROM manifest_entries WHERE seq > ? ORDER BY seq LIMIT 256",
      )
        .raw()
        .all(after) as [number, string, BackupEntryKind, number, string][];
      if (batch.length === 0) return;
      for (const [seq, path, kind, sizeBytes, sha256] of batch) {
        after = seq;
        yield { path, kind, sizeBytes, sha256 };
      }
    }
  }

  /** A fresh disk-backed path registry for a second read of the same archive. */
  secondPassPathRegistry(): ArchivePathRegistry {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS second_pass_paths (path TEXT PRIMARY KEY) WITHOUT ROWID",
    );
    this.db.exec("DELETE FROM second_pass_paths");
    const statement = this.db.prepare("INSERT OR IGNORE INTO second_pass_paths (path) VALUES (?)");
    return {
      add: (path: string): boolean => this.#write(() => statement.run(path)).changes > 0,
    };
  }

  getInventory(path: string): { sizeBytes: number; sha256: string } | undefined {
    const row = this.#statement("SELECT size_bytes, sha256 FROM inventory WHERE path = ?").get(
      path,
    ) as { size_bytes: number; sha256: string } | undefined;
    return row === undefined ? undefined : { sizeBytes: row.size_bytes, sha256: row.sha256 };
  }

  getManifestEntry(path: string): BackupManifestEntry | undefined {
    const row = this.#statement(
      "SELECT path, kind, size_bytes, sha256 FROM manifest_entries WHERE path = ?",
    ).get(path) as
      | { path: string; kind: BackupEntryKind; size_bytes: number; sha256: string }
      | undefined;
    return row === undefined
      ? undefined
      : {
          path: row.path,
          kind: row.kind,
          sizeBytes: row.size_bytes,
          sha256: row.sha256,
        };
  }

  *unlistedEntries(): Generator<string> {
    const rows = this.#statement(
      `SELECT path FROM inventory
       WHERE path <> ?
         AND NOT EXISTS (SELECT 1 FROM manifest_entries m WHERE m.path = inventory.path)
       ORDER BY path`,
    )
      .raw()
      .iterate(MANIFEST_PATH) as IterableIterator<unknown[]>;
    try {
      for (const row of rows) yield row[0] as string;
    } finally {
      rows.return?.();
    }
  }

  *danglingReferences(fk: string, limit: number): Generator<{ rowIndex: number; key: string }> {
    const rows = this.#statement(
      `SELECT row_index, key FROM link_refs r
       WHERE r.fk = ?
         AND NOT EXISTS (SELECT 1 FROM link_targets t WHERE t.fk = r.fk AND t.key = r.key)
       ORDER BY row_index LIMIT ?`,
    )
      .raw()
      .iterate(fk, limit) as IterableIterator<unknown[]>;
    try {
      for (const row of rows) {
        yield { rowIndex: row[0] as number, key: row[1] as string };
      }
    } finally {
      rows.return?.();
    }
  }

  *missingBlobArtifacts(): Generator<string> {
    yield* this.#strings(
      `SELECT hash FROM blob_refs b
       WHERE NOT EXISTS (
         SELECT 1 FROM manifest_entries m WHERE m.kind = 'blob' AND m.path = ? || b.hash
       )
       ORDER BY hash`,
      BLOB_PREFIX,
    );
  }

  *strayBlobArtifacts(): Generator<string> {
    yield* this.#strings(
      `SELECT path FROM manifest_entries m
       WHERE m.kind = 'blob'
         AND NOT EXISTS (SELECT 1 FROM blob_refs b WHERE m.path = ? || b.hash)
       ORDER BY path`,
      BLOB_PREFIX,
    );
  }

  *missingTranscriptArtifacts(): Generator<string> {
    yield* this.#strings(
      `SELECT id FROM transcript_refs t
       WHERE NOT EXISTS (
         SELECT 1 FROM manifest_entries m
         WHERE m.kind = 'transcript' AND m.path = ? || substr(t.id, ?) || '.json'
       )
       ORDER BY id`,
      TRANSCRIPT_PREFIX,
      TRANSCRIPT_PREFIX_LENGTH + 1,
    );
  }

  *strayTranscriptArtifacts(): Generator<string> {
    yield* this.#strings(
      `SELECT path FROM manifest_entries m
       WHERE m.kind = 'transcript'
         AND NOT EXISTS (
           SELECT 1 FROM transcript_refs t WHERE m.path = ? || substr(t.id, ?) || '.json'
         )
       ORDER BY path`,
      TRANSCRIPT_PREFIX,
      TRANSCRIPT_PREFIX_LENGTH + 1,
    );
  }

  *#strings(sql: string, ...params: unknown[]): Generator<string> {
    const rows = this.#statement(sql)
      .raw()
      .iterate(...params) as IterableIterator<unknown[]>;
    try {
      for (const row of rows) yield row[0] as string;
    } finally {
      rows.return?.();
    }
  }
}

function* manifestEntries(scratch: ScratchDatabase): Generator<BackupManifestEntry> {
  const rows = scratch.db
    .prepare("SELECT path, kind, size_bytes, sha256 FROM manifest_entries ORDER BY seq")
    .raw()
    .iterate() as IterableIterator<unknown[]>;
  try {
    for (const row of rows) {
      yield {
        path: row[0] as string,
        kind: row[1] as BackupEntryKind,
        sizeBytes: row[2] as number,
        sha256: row[3] as string,
      };
    }
  } finally {
    rows.return?.();
  }
}

/* ------------------------------------------------------------------------- */
/* Verifier                                                                  */
/* ------------------------------------------------------------------------- */

interface DataDocumentState {
  problems: BackupProblem[];
  problemsTruncated: boolean;
  tableRecords: Set<string>;
  tableColumns: Map<string, string[]>;
  rowCounts: Map<string, number>;
  schemaVersion: number | undefined;
  appVersion: string | undefined;
  createdAt: string | undefined;
  dataVersionSeen: boolean;
  dataVersionValue: unknown;
  formatValue: unknown;
  usageMeteredFrom: number | undefined;
  usageValid: boolean;
  tablesDeclared: boolean;
  tablesInvalid: boolean;
  exportMarked: boolean;
  tableNames: Set<string>;
  linkPlans: LinkPlanIndex | undefined;
  missingSchemaBeforeTablesReported: boolean;
}

interface ForeignKeyPlan {
  id: string;
  source: string;
  target: string;
  from: readonly string[];
  to: readonly string[];
}

interface ScanOutcome {
  manifestSha256: string;
  manifestFields: Record<string, unknown>;
  manifestSyntaxProblem: BackupProblem | undefined;
  manifestFormatProblems: BackupProblem[];
  manifestFieldProblems: BackupProblem[];
  manifestEntryProblems: BackupProblem[];
  manifestProblemsTruncated: boolean;
  manifestEntries: { data: number; blob: number; transcript: number };
  dataSeen: boolean;
  dataSyntaxProblem: BackupProblem | undefined;
  data: DataDocumentState;
}

function newScanOutcome(): ScanOutcome {
  return {
    manifestSha256: "",
    manifestFields: {},
    manifestSyntaxProblem: undefined,
    manifestFormatProblems: [],
    manifestFieldProblems: [],
    manifestEntryProblems: [],
    manifestProblemsTruncated: false,
    manifestEntries: { data: 0, blob: 0, transcript: 0 },
    dataSeen: false,
    dataSyntaxProblem: undefined,
    data: {
      problems: [],
      problemsTruncated: false,
      tableRecords: new Set(),
      tableColumns: new Map(),
      rowCounts: new Map(),
      schemaVersion: undefined,
      appVersion: undefined,
      createdAt: undefined,
      dataVersionSeen: false,
      dataVersionValue: undefined,
      formatValue: undefined,
      usageMeteredFrom: undefined,
      usageValid: false,
      tablesDeclared: false,
      tablesInvalid: false,
      exportMarked: false,
      tableNames: new Set(),
      linkPlans: undefined,
      missingSchemaBeforeTablesReported: false,
    },
  };
}

/** Verifies one file, using (and creating) scratch files inside `staging`. */
async function verifyBundleFile(
  filePath: string,
  staging: string,
  checkpoint?: () => Promise<void>,
): Promise<VerifyBackupBundleFileResult> {
  const scanned = await scanBundleFile(filePath, staging, checkpoint, "report-all");
  scanned.scratch.close();
  return scanned.result;
}

/**
 * The verification itself, leaving its scratch database open for a caller
 * that reads the same archive again (a file restore). The caller closes it.
 */
async function scanBundleFile(
  filePath: string,
  staging: string,
  checkpoint: (() => Promise<void>) | undefined,
  errors: "report-all" | "report-archive",
): Promise<{
  result: VerifyBackupBundleFileResult;
  scratch: ScratchDatabase;
  outcome: ScanOutcome;
}> {
  const scratch = new ScratchDatabase(join(staging, `verify-${randomUUID()}.db`));
  const outcome = newScanOutcome();
  try {
    scratch.exec(VERIFIER_SCRATCH_SCHEMA);
    scratch.exec("BEGIN");
    try {
      await scanArchive(filePath, scratch, outcome, new CheckpointCounter(checkpoint));
    } catch (error) {
      // The verifier has always named every failure of its read as an archive
      // problem. A restore must not: a rejected checkpoint is the person
      // cancelling, and a full scratch disk is not a damaged bundle.
      if (errors === "report-archive" && !isArchiveReadError(error)) throw error;
      return { result: { ok: false, problems: [archiveProblem(error)] }, scratch, outcome };
    }
    return { result: await concludeVerification(outcome, scratch), scratch, outcome };
  } catch (error) {
    scratch.close();
    throw error;
  }
}

/**
 * A bundle file that passed {@link verifyBackupBundleFile}, with the
 * verifier's disk-backed inventory still open.
 *
 * A file restore reads the archive twice — once to verify it, once to stage
 * it — and a file can change between two reads. This handle is what pins the
 * second read to the first: the size and SHA-256 the verifier recorded for
 * every entry, the manifest it accepted, and the project ids the data
 * document carries (for the directory mapping, checked before anything is
 * staged). Every read is SQL against the scratch database, so a bundle with a
 * hundred thousand artifacts costs disk, not heap.
 */
export interface VerifiedBundleInventory {
  readonly bundle: VerifiedBackupBundleFile;
  /** False when the data document carries no projects table with an id column. */
  readonly projectsMappable: boolean;
  /** Project ids in document order, read the way `restoreBackupBundle` reads them. */
  projectIds(): Iterable<string>;
  carriesProject(id: string): boolean;
  /** The column list the verifier accepted for one table, in document order. */
  verifiedColumns(table: string): readonly string[] | undefined;
  /** The size and SHA-256 the verifier read for one archive entry. */
  verifiedEntry(path: string): { sizeBytes: number; sha256: string } | undefined;
  /** How many archive entries the verifier read. */
  verifiedEntryCount(): number;
  /** The verified manifest's entries, in manifest order. */
  manifestEntries(): Iterable<BackupManifestEntry>;
  /** A fresh, disk-backed duplicate-path registry for the second read. */
  secondPassPathRegistry(): ArchivePathRegistry;
  /** Closes the scratch database and removes its directory. Idempotent. */
  close(): void;
}

export type OpenVerifiedBundleResult =
  | { ok: true; inventory: VerifiedBundleInventory }
  | { ok: false; problems: BackupProblem[] };

/**
 * {@link verifyBackupBundleFile}, keeping what it learned for a second read.
 *
 * The same scan, the same problems and the same conclusion — this is the
 * bounded v1 verifier, not a second one. On failure nothing stays open; on
 * success the caller owns the returned inventory and must `close()` it.
 */
export async function openVerifiedBackupBundleFile(
  filePath: string,
  workDir: string,
  checkpoint?: () => Promise<void>,
): Promise<OpenVerifiedBundleResult> {
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(workDir, "backup-verify-"));
  let scanned: Awaited<ReturnType<typeof scanBundleFile>>;
  try {
    scanned = await scanBundleFile(filePath, staging, checkpoint, "report-archive");
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  const { result, scratch, outcome } = scanned;
  if (!result.ok) {
    scratch.close();
    await rm(staging, { recursive: true, force: true });
    return result;
  }
  // The scan's write transaction is still open; reads below share it, and a
  // second-pass registry writes into it like any other scratch insert. The
  // mapping looks projects up by id, once per mapped directory.
  scratch.exec("CREATE INDEX IF NOT EXISTS project_ids_id ON project_ids (id)");
  let closed = false;
  const projectColumns = outcome.data.tableColumns.get("projects");
  return {
    ok: true,
    inventory: {
      bundle: result.bundle,
      projectsMappable: projectColumns?.includes("id") ?? false,
      projectIds: () => scratch.projectIds(),
      carriesProject: (id) => scratch.hasProjectId(id),
      verifiedColumns: (table) => outcome.data.tableColumns.get(table),
      verifiedEntry: (path) => scratch.getInventory(path),
      verifiedEntryCount: () => scratch.inventoryCount(),
      manifestEntries: () => scratch.manifestEntriesInBatches(),
      secondPassPathRegistry: () => scratch.secondPassPathRegistry(),
      close: () => {
        if (closed) return;
        closed = true;
        scratch.close();
        rmSync(staging, { recursive: true, force: true });
      },
    },
  };
}

/** An error of the archive's bytes: a damaged tar stream or gzip stream. */
export function isArchiveFormatError(error: unknown): boolean {
  if (error instanceof ArchiveError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code.startsWith("Z_");
}

/** An error {@link archiveProblem} names precisely: the archive's bytes or reading the file. */
function isArchiveReadError(error: unknown): boolean {
  if (isArchiveFormatError(error)) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code);
}

function archiveProblem(error: unknown): BackupProblem {
  if (error instanceof ArchiveError) return { kind: "archive", message: error.message };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code.startsWith("Z_")) {
    return { kind: "archive", message: "Bundle is not a gzip archive" };
  }
  if (isMissing(error) || (typeof code === "string" && /^E[A-Z]+$/.test(code))) {
    return {
      kind: "archive",
      message: `Bundle file could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { kind: "archive", message: "Bundle is not a gzip archive" };
}

/**
 * Reads the stream once, in archive order, hashing every entry and parsing the
 * two entries whose content is part of the format.
 *
 * Nothing is compared against the manifest until the whole stream has been
 * read, because a v1 reader never required the manifest to be the first entry,
 * and checking it afterwards keeps entry order a writer preference rather than
 * a reader requirement.
 */
async function scanArchive(
  filePath: string,
  scratch: ScratchDatabase,
  outcome: ScanOutcome,
  gate: CheckpointCounter,
): Promise<void> {
  const source = readGunzipped(filePath);
  try {
    await scanEntries(
      new ArchiveStreamReader(source, scratch.archivePathRegistry()),
      scratch,
      outcome,
      gate,
    );
  } finally {
    // An early stop (a cancel, a refused entry) must not leave the file open:
    // ending the generator ends its pipeline, which closes the descriptor.
    await source.return(undefined);
  }
}

async function scanEntries(
  reader: ArchiveStreamReader,
  scratch: ScratchDatabase,
  outcome: ScanOutcome,
  gate: CheckpointCounter,
): Promise<void> {
  for (;;) {
    const entry = await reader.nextEntry();
    if (entry === null) return;
    const hash = createHash("sha256");
    let size = 0;
    const chunks = hashedChunks(entry, hash, gate, (bytes) => {
      size += bytes;
    });
    if (entry.path === MANIFEST_PATH) {
      await readManifestStream(chunks, outcome, scratch, gate);
    } else if (entry.path === DATA_PATH) {
      await readDataStream(chunks, outcome, scratch, gate);
    }
    // Drain whatever a parser did not need (or stopped at after a syntax
    // error) so the inventory hash covers the entry's whole body.
    for (;;) {
      // Draining by hand: the generator hashes and counts as it is pulled,
      // and an unconsumed remainder would leave the inventory hash short.
      const next = await chunks.next();
      if (next.done === true) break;
    }
    const digest = hash.digest("hex");
    if (entry.path === MANIFEST_PATH) outcome.manifestSha256 = digest;
    scratch.insertInventory(entry.path, size, digest);
    await gate.entry();
  }
}

export async function* hashedChunks(
  entry: ArchiveStreamEntry,
  hash: ReturnType<typeof createHash>,
  gate: CheckpointCounter,
  count: (bytes: number) => void,
): AsyncGenerator<Buffer> {
  for (;;) {
    const chunk = await entry.read();
    if (chunk === null) return;
    hash.update(chunk);
    count(chunk.length);
    await gate.bytes(chunk.length);
    yield chunk;
  }
}

/**
 * A byte stream decompressed from the bundle file.
 *
 * `pipeline` owns both ends, so a read error, a corrupt deflate stream and a
 * destination that is never drained all surface here as one rejected
 * iteration rather than a hang.
 */
export async function* readGunzipped(filePath: string): AsyncGenerator<Buffer> {
  const gunzip = createGunzip();
  const completion = pipeline(createReadStream(filePath), gunzip);
  // Handled below; this only closes the window in which an early pipe error
  // could be reported as an unhandled rejection while the loop is starting.
  completion.catch(() => undefined);
  try {
    for await (const chunk of gunzip) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    }
    await completion;
  } catch (error) {
    await completion.catch(() => {});
    throw error;
  }
}

export class CheckpointCounter {
  #bytes = 0;
  #entries = 0;
  #rows = 0;
  readonly #checkpoint: (() => Promise<void>) | undefined;

  constructor(checkpoint: (() => Promise<void>) | undefined) {
    this.#checkpoint = checkpoint;
  }

  async bytes(count: number): Promise<void> {
    if (this.#checkpoint === undefined) return;
    this.#bytes += count;
    if (this.#bytes < CHECKPOINT_BYTES) return;
    this.#bytes = 0;
    await this.#checkpoint();
  }

  async entry(): Promise<void> {
    if (this.#checkpoint === undefined) return;
    this.#entries += 1;
    if (this.#entries < CHECKPOINT_ARTIFACTS) return;
    this.#entries = 0;
    await this.#checkpoint();
  }

  async row(): Promise<void> {
    if (this.#checkpoint === undefined) return;
    this.#rows += 1;
    if (this.#rows < CHECKPOINT_ROWS) return;
    this.#rows = 0;
    await this.#checkpoint();
  }
}

/* ------------------------------------------------------------------------- */
/* Streaming JSON                                                            */
/* ------------------------------------------------------------------------- */

type JsonToken =
  | { kind: "object-start" }
  | { kind: "object-end" }
  | { kind: "array-start" }
  | { kind: "array-end" }
  | { kind: "comma" }
  | { kind: "colon" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "end" };

/** A JSON document (or a UTF-8 stream) this reader cannot accept. */
export class JsonSyntaxError extends Error {}

const JSON_VALUE_DEPTH = 32;
const COLUMN_COUNT_LIMIT = 4_096;

/**
 * A pull-based JSON tokenizer over a byte stream.
 *
 * Hand-rolled rather than a dependency or `JSON.parse`, because the data
 * document of a real profile does not fit in memory and no general parser
 * here may. It is strict where JSON is strict (escapes, commas, control
 * characters, trailing data) and never holds more than the token it is
 * reading; a consumed prefix is dropped, so a gigabyte document costs a few
 * kilobytes of text at a time. Multi-byte UTF-8 is decoded with a streaming
 * `TextDecoder`, so a character split across archive chunks is not a failure.
 */
export class JsonTokenizer {
  readonly #bytes: AsyncIterator<Uint8Array>;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  #buffer = "";
  #index = 0;
  #sourceDone = false;

  constructor(bytes: AsyncIterable<Uint8Array>) {
    this.#bytes = bytes[Symbol.asyncIterator]();
  }

  async next(): Promise<JsonToken> {
    return this.#readToken();
  }

  /** Requires the document to end here, with nothing but whitespace after it. */
  async expectEnd(): Promise<void> {
    const token = await this.next();
    if (token.kind !== "end") {
      throw new JsonSyntaxError("Unexpected data after the JSON document");
    }
  }

  async #pull(): Promise<boolean> {
    if (this.#sourceDone) return false;
    const next = await this.#bytes.next();
    if (next.done) {
      this.#sourceDone = true;
      let tail: string;
      try {
        tail = this.#decoder.decode();
      } catch {
        throw new JsonSyntaxError("The document is not valid UTF-8");
      }
      if (tail.length > 0) this.#buffer += tail;
      return false;
    }
    let text: string;
    try {
      text = this.#decoder.decode(next.value, { stream: true });
    } catch {
      throw new JsonSyntaxError("The document is not valid UTF-8");
    }
    if (text.length > 0) this.#buffer += text;
    return true;
  }

  #trim(): void {
    // A megabyte of consumed prefix is enough slack to keep a token that
    // straddles chunk boundaries cheap, without retaining the whole document.
    if (this.#index < 1_048_576) return;
    this.#buffer = this.#buffer.slice(this.#index);
    this.#index = 0;
  }

  async #skipWhitespace(): Promise<void> {
    for (;;) {
      while (this.#index < this.#buffer.length) {
        const code = this.#buffer.charCodeAt(this.#index);
        if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
          this.#index += 1;
          continue;
        }
        return;
      }
      if (!(await this.#pull())) return;
    }
  }

  async #readToken(): Promise<JsonToken> {
    await this.#skipWhitespace();
    if (this.#index >= this.#buffer.length) return { kind: "end" };
    const code = this.#buffer.charCodeAt(this.#index);
    switch (code) {
      case 0x7b:
        this.#index += 1;
        this.#trim();
        return { kind: "object-start" };
      case 0x7d:
        this.#index += 1;
        this.#trim();
        return { kind: "object-end" };
      case 0x5b:
        this.#index += 1;
        this.#trim();
        return { kind: "array-start" };
      case 0x5d:
        this.#index += 1;
        this.#trim();
        return { kind: "array-end" };
      case 0x2c:
        this.#index += 1;
        this.#trim();
        return { kind: "comma" };
      case 0x3a:
        this.#index += 1;
        this.#trim();
        return { kind: "colon" };
      case 0x22:
        return this.#readString();
      default:
        return this.#readLiteral();
    }
  }

  async #readString(): Promise<JsonToken> {
    const start = this.#index;
    let cursor = start + 1;
    let escaped = false;
    for (;;) {
      if (cursor >= this.#buffer.length) {
        if (!(await this.#pull())) throw new JsonSyntaxError("Unterminated string");
        continue;
      }
      const code = this.#buffer.charCodeAt(cursor);
      if (escaped) {
        escaped = false;
        cursor += 1;
        continue;
      }
      if (code === 0x5c) {
        escaped = true;
        cursor += 1;
        continue;
      }
      if (code === 0x22) break;
      cursor += 1;
    }
    let value: string;
    try {
      value = JSON.parse(this.#buffer.slice(start, cursor + 1)) as string;
    } catch {
      throw new JsonSyntaxError("Invalid string escape");
    }
    this.#index = cursor + 1;
    this.#trim();
    return { kind: "string", value };
  }

  async #readLiteral(): Promise<JsonToken> {
    for (const [text, token] of [
      ["true", { kind: "boolean", value: true }],
      ["false", { kind: "boolean", value: false }],
      ["null", { kind: "null" }],
    ] as const) {
      while (this.#buffer.length - this.#index < text.length && !this.#sourceDone) {
        await this.#pull();
      }
      if (this.#buffer.startsWith(text, this.#index)) {
        this.#index += text.length;
        this.#trim();
        return token;
      }
    }
    for (;;) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
        this.#buffer.slice(this.#index),
      );
      if (match === null) {
        if (!this.#sourceDone) {
          await this.#pull();
          continue;
        }
        throw new JsonSyntaxError("Invalid JSON token");
      }
      const end = this.#index + match[0].length;
      if (end < this.#buffer.length || this.#sourceDone) {
        this.#index = end;
        this.#trim();
        return { kind: "number", value: Number(match[0]) };
      }
      await this.#pull();
    }
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function expectColon(tokenizer: JsonTokenizer): Promise<void> {
  const token = await tokenizer.next();
  if (token.kind !== "colon") throw new JsonSyntaxError("Expected : after a property name");
}

export async function readJsonValueFrom(
  tokenizer: JsonTokenizer,
  token: JsonToken,
  depth: number,
): Promise<unknown> {
  if (depth > JSON_VALUE_DEPTH) throw new JsonSyntaxError("JSON value is nested too deeply");
  switch (token.kind) {
    case "string":
    case "number":
    case "boolean":
      return token.value;
    case "null":
      return null;
    case "array-start": {
      const values: unknown[] = [];
      await readArrayItems(tokenizer, async (item) => {
        values.push(await readJsonValueFrom(tokenizer, item, depth + 1));
      });
      return values;
    }
    case "object-start": {
      const value: Record<string, unknown> = {};
      await readObjectEntries(tokenizer, async (key, field) => {
        value[key] = await readJsonValueFrom(tokenizer, field, depth + 1);
      });
      return value;
    }
    default:
      throw new JsonSyntaxError("Unexpected token in JSON value");
  }
}

export async function skipJsonValueFrom(
  tokenizer: JsonTokenizer,
  token: JsonToken,
  depth: number,
): Promise<void> {
  if (depth > JSON_VALUE_DEPTH) throw new JsonSyntaxError("JSON value is nested too deeply");
  if (token.kind === "array-start") {
    await readArrayItems(tokenizer, (item) => skipJsonValueFrom(tokenizer, item, depth + 1));
    return;
  }
  if (token.kind === "object-start") {
    await readObjectEntries(tokenizer, (_key, field) =>
      skipJsonValueFrom(tokenizer, field, depth + 1),
    );
    return;
  }
  if (
    token.kind === "string" ||
    token.kind === "number" ||
    token.kind === "boolean" ||
    token.kind === "null"
  ) {
    return;
  }
  throw new JsonSyntaxError("Unexpected token in JSON value");
}

export async function readArrayItems(
  tokenizer: JsonTokenizer,
  onItem: (token: JsonToken) => Promise<void>,
): Promise<void> {
  for (;;) {
    const token = await tokenizer.next();
    if (token.kind === "array-end") return;
    await onItem(token);
    const separator = await tokenizer.next();
    if (separator.kind === "array-end") return;
    if (separator.kind !== "comma") throw new JsonSyntaxError("Expected , or ] in an array");
  }
}

export async function readObjectEntries(
  tokenizer: JsonTokenizer,
  onField: (key: string, value: JsonToken) => Promise<void>,
): Promise<void> {
  for (;;) {
    const key = await tokenizer.next();
    if (key.kind === "object-end") return;
    if (key.kind !== "string") throw new JsonSyntaxError("Expected a property name");
    await expectColon(tokenizer);
    await onField(key.value, await tokenizer.next());
    const separator = await tokenizer.next();
    if (separator.kind === "object-end") return;
    if (separator.kind !== "comma") throw new JsonSyntaxError("Expected , or } in an object");
  }
}

/* ------------------------------------------------------------------------- */
/* Manifest parsing                                                          */
/* ------------------------------------------------------------------------- */

/** Records manifest entry problems, up to the same bounded report size. */
function addManifestProblems(outcome: ScanOutcome, problems: readonly BackupProblem[]): void {
  for (const problem of problems) {
    if (outcome.manifestEntryProblems.length >= MAX_REPORTED_PROBLEMS) {
      outcome.manifestProblemsTruncated = true;
      return;
    }
    outcome.manifestEntryProblems.push(problem);
  }
}

async function readManifestStream(
  chunks: AsyncIterable<Uint8Array>,
  outcome: ScanOutcome,
  scratch: ScratchDatabase,
  gate: CheckpointCounter,
): Promise<void> {
  const fields: Record<string, unknown> = {};
  const tokenizer = new JsonTokenizer(chunks);
  let entriesSeen = false;
  let entriesInvalid = false;
  try {
    const opening = await tokenizer.next();
    if (opening.kind !== "object-start") throw new JsonSyntaxError("Manifest is not an object");
    await readObjectEntries(tokenizer, async (key, value) => {
      if (key !== "entries") {
        fields[key] = await readJsonValueFrom(tokenizer, value, 1);
        return;
      }
      if (entriesSeen) {
        addManifestProblems(outcome, [
          {
            kind: "manifest",
            message: "Bundle manifest lists its entry inventory twice.",
          },
        ]);
        await skipJsonValueFrom(tokenizer, value, 1);
        return;
      }
      entriesSeen = true;
      if (value.kind !== "array-start") {
        entriesInvalid = true;
        await skipJsonValueFrom(tokenizer, value, 1);
        return;
      }
      await readManifestEntries(tokenizer, outcome, scratch, gate);
    });
    await tokenizer.expectEnd();
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    outcome.manifestSyntaxProblem = {
      kind: "manifest",
      message: "Bundle manifest is not valid JSON.",
    };
    return;
  }

  const formatProblems = manifestFormatProblems(fields);
  outcome.manifestFormatProblems = formatProblems;
  if (formatProblems.length > 0) return;
  const fieldProblems = manifestFieldProblems(fields);
  if (!entriesSeen || entriesInvalid) {
    fieldProblems.push({ kind: "manifest", message: "Bundle manifest has no entry inventory." });
  }
  outcome.manifestFieldProblems = fieldProblems;
  outcome.manifestFields = fields;
}

async function readManifestEntries(
  tokenizer: JsonTokenizer,
  outcome: ScanOutcome,
  scratch: ScratchDatabase,
  gate: CheckpointCounter,
): Promise<void> {
  let index = 0;
  await readArrayItems(tokenizer, async (token) => {
    const value = await readJsonValueFrom(tokenizer, token, 1);
    const problems = manifestEntryProblems(index, value);
    if (problems.length > 0) {
      addManifestProblems(outcome, problems);
    } else {
      const entry = value as BackupManifestEntry;
      try {
        scratch.insertManifestEntry(entry);
        outcome.manifestEntries[entry.kind] += 1;
      } catch (error) {
        if (isUniqueViolation(error)) {
          addManifestProblems(outcome, [duplicateManifestEntryProblem(entry.path)]);
        } else {
          throw error;
        }
      }
    }
    index += 1;
    await gate.entry();
  });
}

/* ------------------------------------------------------------------------- */
/* Data document parsing                                                     */
/* ------------------------------------------------------------------------- */

interface LinkPlanIndex {
  bySource: Map<string, ForeignKeyPlan[]>;
  byTarget: Map<string, ForeignKeyPlan[]>;
}

function foreignKeyPlans(schemaVersion: number): LinkPlanIndex {
  const { foreignKeys } = referenceSchema(schemaVersion);
  const bySource = new Map<string, ForeignKeyPlan[]>();
  const byTarget = new Map<string, ForeignKeyPlan[]>();
  for (const [source, keys] of foreignKeys) {
    keys.forEach((key, index) => {
      const plan: ForeignKeyPlan = {
        id: `${source}#${index}`,
        source,
        target: key.table,
        from: key.from,
        to: key.to,
      };
      bySource.set(source, [...(bySource.get(source) ?? []), plan]);
      byTarget.set(plan.target, [...(byTarget.get(plan.target) ?? []), plan]);
    });
  }
  return { bySource, byTarget };
}

async function readDataStream(
  chunks: AsyncIterable<Uint8Array>,
  outcome: ScanOutcome,
  scratch: ScratchDatabase,
  gate: CheckpointCounter,
): Promise<void> {
  outcome.dataSeen = true;
  const state = outcome.data;
  const tokenizer = new JsonTokenizer(chunks);
  try {
    const opening = await tokenizer.next();
    if (opening.kind !== "object-start") {
      throw new JsonSyntaxError("Data document is not an object");
    }
    await readObjectEntries(tokenizer, async (key, value) => {
      switch (key) {
        case "format":
          state.formatValue = await readJsonValueFrom(tokenizer, value, 1);
          if (state.formatValue === "volli-export") state.exportMarked = true;
          return;
        case "dataVersion":
          state.dataVersionSeen = true;
          state.dataVersionValue = await readJsonValueFrom(tokenizer, value, 1);
          return;
        case "schemaVersion": {
          const raw = await readJsonValueFrom(tokenizer, value, 1);
          state.schemaVersion = typeof raw === "number" && Number.isInteger(raw) ? raw : undefined;
          return;
        }
        case "appVersion": {
          const raw = await readJsonValueFrom(tokenizer, value, 1);
          state.appVersion = typeof raw === "string" ? raw : undefined;
          return;
        }
        case "createdAt": {
          const raw = await readJsonValueFrom(tokenizer, value, 1);
          state.createdAt = typeof raw === "string" ? raw : undefined;
          return;
        }
        case "usageCoverage": {
          const raw = await readJsonValueFrom(tokenizer, value, 1);
          const meteredFrom = isRecordValue(raw) ? raw.meteredFrom : undefined;
          state.usageValid = typeof meteredFrom === "number";
          state.usageMeteredFrom = typeof meteredFrom === "number" ? meteredFrom : undefined;
          return;
        }
        case "tables": {
          if (state.tablesDeclared) {
            addShapeProblem(state, "Data document lists its tables twice.");
            await skipJsonValueFrom(tokenizer, value, 1);
            return;
          }
          state.tablesDeclared = true;
          if (value.kind !== "object-start") {
            state.tablesInvalid = true;
            await skipJsonValueFrom(tokenizer, value, 1);
            return;
          }
          await readTablesObject(tokenizer, state, scratch, gate);
          return;
        }
        default:
          await skipJsonValueFrom(tokenizer, value, 1);
      }
    });
    await tokenizer.expectEnd();
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    outcome.dataSyntaxProblem = { kind: "shape", message: "Bundle data is not valid JSON." };
  }
}

function shapeProblem(message: string): BackupProblem {
  return { kind: "shape", message };
}

/**
 * Records a shape problem, up to a bounded number.
 *
 * A damaged bundle can have a problem on every one of millions of rows; a
 * report that holds them all is an unbounded array in a worker budgeted for
 * one. The first hundred named problems are enough to know what is wrong, and
 * the conclusion says when the list was cut.
 */
function addShapeProblem(state: DataDocumentState, message: string): void {
  if (state.problems.length >= MAX_REPORTED_PROBLEMS) {
    state.problemsTruncated = true;
    return;
  }
  state.problems.push(shapeProblem(message));
}

async function readTablesObject(
  tokenizer: JsonTokenizer,
  state: DataDocumentState,
  scratch: ScratchDatabase,
  gate: CheckpointCounter,
): Promise<void> {
  await readObjectEntries(tokenizer, async (name, value) => {
    if (state.tableNames.has(name)) {
      addShapeProblem(state, `Data document carries table ${name} twice.`);
      await skipJsonValueFrom(tokenizer, value, 2);
      return;
    }
    state.tableNames.add(name);
    if (!BACKUP_INCLUDED_TABLES.includes(name)) {
      addShapeProblem(state, `Data document carries ${name}, which no backup decision includes.`);
      await skipJsonValueFrom(tokenizer, value, 2);
      return;
    }
    if (value.kind !== "object-start") {
      // A non-object table is "missing" if the bundle's schema owes it; the
      // end check decides that from `tableRecords`.
      await skipJsonValueFrom(tokenizer, value, 2);
      return;
    }
    state.tableRecords.add(name);
    await readTableObject(name, tokenizer, state, scratch, gate);
  });
}

async function readTableObject(
  name: string,
  tokenizer: JsonTokenizer,
  state: DataDocumentState,
  scratch: ScratchDatabase,
  gate: CheckpointCounter,
): Promise<void> {
  let columns: string[] | undefined;
  let columnsUsable = false;
  let columnsProblem = false;
  let rowsSeen = false;

  await readObjectEntries(tokenizer, async (key, value) => {
    if (key === "columns") {
      if (columns !== undefined || columnsProblem) {
        addShapeProblem(state, `Table ${name} lists its columns twice.`);
      }
      if (value.kind !== "array-start") {
        columnsProblem = true;
        addShapeProblem(state, `Table ${name} has no column list.`);
        await skipJsonValueFrom(tokenizer, value, 3);
        return;
      }
      const raw = await readColumnList(tokenizer);
      if (raw.length > COLUMN_COUNT_LIMIT || !raw.every((entry) => typeof entry === "string")) {
        columnsProblem = true;
        addShapeProblem(state, `Table ${name} has no column list.`);
        return;
      }
      columns = raw as string[];
      columnsUsable = true;
      if (rowsSeen) {
        addShapeProblem(
          state,
          `Table ${name} lists its columns after its rows, which this reader requires.`,
        );
      }
      state.tableColumns.set(name, columns);
      if (!state.rowCounts.has(name)) state.rowCounts.set(name, 0);
      ensureLinkPlans(state);
      return;
    }
    if (key === "rows") {
      if (rowsSeen) {
        addShapeProblem(state, `Table ${name} lists its rows twice.`);
        await skipJsonValueFrom(tokenizer, value, 3);
        return;
      }
      rowsSeen = true;
      if (!columnsUsable) {
        if (!columnsProblem) {
          addShapeProblem(
            state,
            `Table ${name} lists its rows before its columns, which this reader requires.`,
          );
        }
        await skipJsonValueFrom(tokenizer, value, 3);
        return;
      }
      if (value.kind !== "array-start") {
        addShapeProblem(state, `Table ${name} has no rows array.`);
        await skipJsonValueFrom(tokenizer, value, 3);
        return;
      }
      await readRowList(name, columns as string[], tokenizer, state, scratch, gate);
      return;
    }
    await skipJsonValueFrom(tokenizer, value, 3);
  });

  if (!columnsUsable) {
    if (!columnsProblem) {
      addShapeProblem(state, `Table ${name} has no column list.`);
    }
    return;
  }
  if (!rowsSeen) {
    addShapeProblem(state, `Table ${name} has no rows array.`);
  }
}

async function readColumnList(tokenizer: JsonTokenizer): Promise<unknown[]> {
  const values: unknown[] = [];
  await readArrayItems(tokenizer, async (token) => {
    const value = await readJsonValueFrom(tokenizer, token, 4);
    if (values.length <= COLUMN_COUNT_LIMIT) values.push(value);
  });
  return values;
}

async function readRowList(
  table: string,
  columns: readonly string[],
  tokenizer: JsonTokenizer,
  state: DataDocumentState,
  scratch: ScratchDatabase,
  gate: CheckpointCounter,
): Promise<void> {
  let rowIndex = 0;
  await readArrayItems(tokenizer, async (token) => {
    const index = rowIndex;
    rowIndex += 1;
    if (token.kind !== "array-start") {
      await skipJsonValueFrom(tokenizer, token, 4);
      addShapeProblem(
        state,
        `Table ${table} row ${index} does not match its ${columns.length} columns.`,
      );
      await gate.row();
      return;
    }
    const row: unknown[] = [];
    await readArrayItems(tokenizer, async (item) => {
      row.push(await readJsonValueFrom(tokenizer, item, 5));
    });
    if (row.length !== columns.length) {
      addShapeProblem(
        state,
        `Table ${table} row ${index} does not match its ${columns.length} columns.`,
      );
      await gate.row();
      return;
    }
    if (!row.every(isBackupValue)) {
      addShapeProblem(state, `Table ${table} row ${index} has an unreadable value.`);
      await gate.row();
      return;
    }
    state.rowCounts.set(table, (state.rowCounts.get(table) ?? 0) + 1);
    observeRow(table, columns, index, row as readonly BackupValue[], state, scratch);
    await gate.row();
  });
}

function observeRow(
  table: string,
  columns: readonly string[],
  rowIndex: number,
  row: readonly BackupValue[],
  state: DataDocumentState,
  scratch: ScratchDatabase,
): void {
  if (table === "blobs") {
    const index = columns.indexOf("hash");
    const hash = index === -1 ? undefined : row[index];
    if (typeof hash === "string") scratch.insertBlobRef(hash);
  }
  if (table === "projects") {
    // What a file restore maps to local directories, read the way the
    // in-memory restore reads it: `String` of the raw id value.
    const index = columns.indexOf("id");
    if (index !== -1) scratch.insertProjectId(String(row[index]));
  }
  const transcriptColumns = TRANSCRIPT_COLUMNS[table];
  if (transcriptColumns !== undefined) {
    for (const column of transcriptColumns) {
      const index = columns.indexOf(column);
      const value = index === -1 ? undefined : row[index];
      if (typeof value !== "string") continue;
      const found = new Set<string>();
      try {
        walkTranscriptReferences(JSON.parse(value), found);
      } catch {
        continue;
      }
      for (const id of found) scratch.insertTranscriptRef(id);
    }
  }
  const plans = state.linkPlans;
  if (plans === undefined) return;
  for (const plan of plans.bySource.get(table) ?? []) {
    const indexes = plan.from.map((column) => columns.indexOf(column));
    if (indexes.includes(-1)) continue;
    const values = indexes.map((index) => row[index] ?? null);
    if (values.some((value) => value === null)) continue;
    scratch.insertLinkRef(plan.id, rowIndex, recordKeyOf(values));
  }
  for (const plan of plans.byTarget.get(table) ?? []) {
    const indexes = plan.to.map((column) => columns.indexOf(column));
    if (indexes.includes(-1)) continue;
    const values = indexes.map((index) => row[index] ?? null);
    scratch.insertLinkTarget(plan.id, recordKeyOf(values));
  }
}

function ensureLinkPlans(state: DataDocumentState): void {
  if (state.linkPlans !== undefined) return;
  if (state.schemaVersion === undefined) {
    if (!state.missingSchemaBeforeTablesReported) {
      state.missingSchemaBeforeTablesReported = true;
      addShapeProblem(
        state,
        "Data document lists its tables before schemaVersion, so record links cannot be checked.",
      );
    }
    return;
  }
  state.linkPlans = foreignKeyPlans(state.schemaVersion);
}

/* ------------------------------------------------------------------------- */
/* Verifier conclusion                                                       */
/* ------------------------------------------------------------------------- */

function failureResult(problems: BackupProblem[]): VerifyBackupBundleFileResult {
  return { ok: false, problems };
}

async function concludeVerification(
  outcome: ScanOutcome,
  scratch: ScratchDatabase,
): Promise<VerifyBackupBundleFileResult> {
  const fail = failureResult;
  const manifestInventory = scratch.getInventory(MANIFEST_PATH);
  if (manifestInventory === undefined) return fail([missingManifestProblem()]);
  if (outcome.manifestSyntaxProblem !== undefined) {
    return fail([outcome.manifestSyntaxProblem]);
  }
  if (outcome.manifestFormatProblems.length > 0) return fail(outcome.manifestFormatProblems);
  const manifestProblems = [...outcome.manifestFieldProblems, ...outcome.manifestEntryProblems];
  if (outcome.manifestProblemsTruncated) {
    manifestProblems.push({
      kind: "manifest",
      message: `Bundle manifest has more problems than this report lists; the first ${MAX_REPORTED_PROBLEMS} are shown.`,
    });
  }
  if (manifestProblems.length > 0) return fail(manifestProblems);

  const inventoryProblems = checkInventory(scratch);
  if (inventoryProblems.length > 0) return fail(inventoryProblems);

  if (outcome.dataSyntaxProblem !== undefined) return fail([outcome.dataSyntaxProblem]);
  if (!outcome.dataSeen) {
    return fail([{ kind: "shape", message: `Bundle has no ${DATA_PATH}.` }]);
  }
  const shapeProblems = dataShapeProblems(outcome.data);
  if (shapeProblems.length > 0) return fail(shapeProblems);

  const state = outcome.data;
  if (state.schemaVersion === undefined) {
    // dataShapeProblems already refused this; kept for the type narrowing.
    return fail([shapeProblem("Data document has no integer schemaVersion.")]);
  }
  // The link index is built once, after every row has been inserted: an index
  // maintained during millions of inserts costs more than one pass over the
  // finished table.
  scratch.exec("CREATE INDEX IF NOT EXISTS link_refs_fk ON link_refs (fk, row_index)");
  const fields = outcome.manifestFields;
  const problems: BackupProblem[] = [];
  if (state.schemaVersion !== fields.schemaVersion) {
    problems.push(manifestSchemaProblem(fields.schemaVersion as number, state.schemaVersion));
  }
  problems.push(...linkProblems(state, scratch));
  problems.push(...coverageProblems(scratch));
  if (problems.length > 0) return fail(problems);

  return {
    ok: true,
    bundle: {
      manifestSha256: outcome.manifestSha256,
      manifest: {
        format: BACKUP_BUNDLE_FORMAT,
        bundleVersion: fields.bundleVersion as number,
        appVersion: fields.appVersion as string,
        schemaVersion: fields.schemaVersion as number,
        createdAt: fields.createdAt as string,
        entries: outcome.manifestEntries,
      },
      document: {
        schemaVersion: state.schemaVersion,
        appVersion: state.appVersion as string,
        createdAt: state.createdAt as string,
        usageCoverage: { meteredFrom: state.usageMeteredFrom as number },
        tables: Object.fromEntries(state.rowCounts),
      },
    },
  };
}

interface ManifestInventoryRow {
  path: string;
  kind: BackupEntryKind;
  manifest_size: number;
  manifest_sha: string;
  inventory_size: number | null;
  inventory_sha: string | null;
}

function checkInventory(scratch: ScratchDatabase): BackupProblem[] {
  const problems: BackupProblem[] = [];
  // One joined cursor rather than an iterator plus per-entry lookups: the
  // scratch connection is busy for the life of a cursor, so every fact this
  // loop needs has to arrive in the same statement.
  const rows = scratch.db
    .prepare(
      `SELECT m.path, m.kind, m.size_bytes AS manifest_size, m.sha256 AS manifest_sha,
              i.size_bytes AS inventory_size, i.sha256 AS inventory_sha
       FROM manifest_entries m
       LEFT JOIN inventory i ON i.path = m.path
       ORDER BY m.seq`,
    )
    .raw()
    .iterate() as IterableIterator<unknown[]>;
  const entries = (function* (): Generator<ManifestInventoryRow> {
    try {
      for (const row of rows) {
        yield {
          path: row[0] as string,
          kind: row[1] as BackupEntryKind,
          manifest_size: row[2] as number,
          manifest_sha: row[3] as string,
          inventory_size: row[4] as number | null,
          inventory_sha: row[5] as string | null,
        };
      }
    } finally {
      rows.return?.();
    }
  })();
  for (const row of entries) {
    const entry: BackupManifestEntry = {
      path: row.path,
      kind: row.kind,
      sizeBytes: row.manifest_size,
      sha256: row.manifest_sha,
    };
    const shape = expectedPathProblem(entry);
    if (shape !== null) {
      problems.push(misplacedManifestEntryProblem(entry.path, shape));
      continue;
    }
    if (row.inventory_size === null || row.inventory_sha === null) {
      problems.push(missingBundleFileProblem(entry.path));
      continue;
    }
    if (row.inventory_size !== entry.sizeBytes) {
      problems.push(artifactSizeProblem(entry.path, row.inventory_size, entry.sizeBytes));
      continue;
    }
    if (row.inventory_sha !== entry.sha256) problems.push(artifactHashProblem(entry.path));
  }
  for (const path of scratch.unlistedEntries()) {
    problems.push(unlistedBundleFileProblem(path));
  }
  if (scratch.getManifestEntry(DATA_PATH) === undefined) problems.push(manifestMissesDataProblem());
  return problems;
}

function dataShapeProblems(state: DataDocumentState): BackupProblem[] {
  if (state.exportMarked) {
    return [
      shapeProblem(
        "This is a volli-export JSON file, not a backup bundle. The JSON export is a limited data export and cannot be restored.",
      ),
    ];
  }
  const envelope: BackupProblem[] = [];
  if (state.formatValue !== BACKUP_DATA_FORMAT) {
    envelope.push(shapeProblem(`Data document format is not ${BACKUP_DATA_FORMAT}.`));
  }
  if (!state.dataVersionSeen || state.dataVersionValue !== BACKUP_DATA_VERSION) {
    envelope.push({
      kind: "unsupported-version",
      message: `Data document version ${String(state.dataVersionValue)} is not supported (expected ${BACKUP_DATA_VERSION}).`,
    });
  }
  if (state.schemaVersion === undefined) {
    envelope.push(shapeProblem("Data document has no integer schemaVersion."));
  }
  if (state.appVersion === undefined)
    envelope.push(shapeProblem("Data document has no appVersion."));
  if (state.createdAt === undefined) envelope.push(shapeProblem("Data document has no createdAt."));
  if (!state.usageValid) {
    envelope.push(shapeProblem("Data document has no usageCoverage.meteredFrom."));
  }
  if (!state.tablesDeclared || state.tablesInvalid) {
    envelope.push(shapeProblem("Data document has no tables object."));
    return envelope;
  }
  const problems = [...envelope, ...state.problems];
  if (state.problemsTruncated) {
    problems.push(
      shapeProblem(
        `Data document has more problems than this report lists; the first ${MAX_REPORTED_PROBLEMS} are shown.`,
      ),
    );
  }
  if (state.schemaVersion === undefined) return problems;
  if (state.linkPlans === undefined) {
    // A document that listed tables before schemaVersion; already named above.
    return problems;
  }
  const expected = tablesAtVersion(state.schemaVersion);
  for (const name of BACKUP_INCLUDED_TABLES) {
    if (expected.has(name) && !state.tableRecords.has(name)) {
      problems.push(shapeProblem(`Data document is missing table ${name}.`));
    }
  }
  return problems;
}

function linkProblems(state: DataDocumentState, scratch: ScratchDatabase): BackupProblem[] {
  if (state.schemaVersion === undefined) return [];
  const plans = state.linkPlans;
  if (plans === undefined) return [];
  const { columns: liveColumns } = referenceSchema(state.schemaVersion);
  const problems: BackupProblem[] = [];
  for (const table of BACKUP_INCLUDED_TABLES) {
    const columns = state.tableColumns.get(table);
    if (columns === undefined) continue;
    for (const column of columns) {
      if (!(liveColumns.get(table) ?? []).includes(column)) {
        problems.push(
          shapeProblem(
            `Table ${table} carries column ${column}, which this build's schema does not have.`,
          ),
        );
      }
    }
    for (const plan of plans.bySource.get(table) ?? []) {
      if (!plan.from.every((column) => columns.includes(column))) continue;
      const targetColumns = state.tableColumns.get(plan.target);
      if (targetColumns === undefined) continue;
      if (!plan.to.every((column) => targetColumns.includes(column))) continue;
      const dangling = [...scratch.danglingReferences(plan.id, MAX_REPORTED_PROBLEMS + 1)];
      for (const reference of dangling.slice(0, MAX_REPORTED_PROBLEMS)) {
        problems.push({
          kind: "link",
          message: `${table} row ${reference.rowIndex} references ${plan.target}(${plan.to.join(", ")}) = ${describeKey(reference.key)}, which the bundle does not carry.`,
        });
      }
      if (dangling.length > MAX_REPORTED_PROBLEMS) {
        problems.push({
          kind: "link",
          message: `Bundle has more broken references from ${table} than this report lists; ${MAX_REPORTED_PROBLEMS} are shown.`,
        });
      }
    }
  }
  return problems;
}

function describeKey(key: string): string {
  try {
    const values = JSON.parse(key) as BackupValue[];
    return values.map((value) => JSON.stringify(value)).join(", ");
  } catch {
    return key;
  }
}

function coverageProblems(scratch: ScratchDatabase): BackupProblem[] {
  const problems: BackupProblem[] = [];
  for (const hash of scratch.missingBlobArtifacts())
    problems.push(missingBlobArtifactProblem(hash));
  for (const path of scratch.strayBlobArtifacts()) problems.push(strayBlobArtifactProblem(path));
  for (const digest of scratch.missingTranscriptArtifacts()) {
    problems.push(missingTranscriptArtifactProblem(digest));
  }
  for (const path of scratch.strayTranscriptArtifacts()) {
    problems.push(strayTranscriptArtifactProblem(path));
  }
  return problems;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
    return true;
  }
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
