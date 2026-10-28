/**
 * The second read of a verified bundle file: staging its rows and artifacts
 * into a new profile with bounded memory (VC-988).
 *
 * `restoreBackupBundle` hands the whole archive to `readBackupBundle`, which
 * holds `data.json` as one string. A 2.15-million-row profile's data document
 * is larger than V8's maximum string length, so that path cannot restore the
 * backups VC-972 now makes. This module is the staging half of the file
 * restore in `restore.ts`; the verification half is the bounded v1 verifier
 * (`openVerifiedBackupBundleFile`), unchanged.
 *
 * PINNED TO THE VERIFIED BYTES. The archive is read twice — verify, then
 * stage — and a file can change between two reads. Every entry this pass
 * reads is hashed as it streams and compared with the size and SHA-256 the
 * verifier recorded for the same path; the entry count, and every table's row
 * count, must match too. A mismatch throws {@link BundleChangedError}, and the
 * caller discards the staging directory, so what lands in a profile is only
 * ever the bundle that was verified. Rows are inserted before their entry's
 * hash is final; that is safe because nothing staged is live until the whole
 * staged profile has passed its own checks.
 *
 * WHAT IT HOLDS. One JSON token, one decoded row, one archive chunk, the
 * SQLite page cache of the staged database, and one transcript artifact (the
 * transcript store validates and compresses whole artifacts, exactly as the
 * app reads them). Blobs stream straight to disk. Row inserts commit every
 * {@link ROWS_PER_COMMIT} rows so the staged database's WAL stays small; the
 * staging database is disposable until activation, so an interrupted load is
 * discarded rather than resumed.
 *
 * SAME WRITES AS THE IN-MEMORY RESTORE. Column lists, schema-marker rows,
 * project paths substituted from the person's mapping, and the event-sequence
 * tables replacing the insert triggers' guesses all follow `writeRows` in
 * `restore.ts`; `restore-file.test.ts` compares the two restored profiles.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type Database from "better-sqlite3";

import { blobFilePath, blobsRoot } from "../blob-store";
import {
  createFileTranscriptArtifactStore,
  sessionTranscriptsRoot,
  transcriptReferenceForId,
} from "../session-runtime/transcript-artifacts";
import { ArchiveError, ArchiveStreamReader } from "./archive";
import { BLOB_PREFIX, DATA_PATH, MANIFEST_PATH, TRANSCRIPT_PREFIX } from "./bundle";
import { decodeValue, isBackupValue, isSchemaMarkerRow } from "./data-document";
import type { BackupValue } from "./data-document";
import {
  CheckpointCounter,
  JsonSyntaxError,
  JsonTokenizer,
  hashedChunks,
  readArrayItems,
  readGunzipped,
  readJsonValueFrom,
  readObjectEntries,
  skipJsonValueFrom,
} from "./streaming";
import type { VerifiedBundleInventory } from "./streaming";

/** Inserts between `COMMIT`/`BEGIN` pairs while loading the staged database. */
const ROWS_PER_COMMIT = 4_096;

/**
 * The tables an insert trigger on another included table writes to.
 *
 * The bundle carries their real rows (durable cursors), so the restore clears
 * the triggers' guesses when it reaches them. That needs the event table's
 * rows to be in first, which is the order both Volli writers emit.
 */
export const TRIGGER_FILLED_TABLES: Readonly<Record<string, string>> = {
  ticket_event_sequence: "ticket_events",
  session_event_sequence: "session_events",
};

/** The bundle file stopped matching what was verified, or cannot be staged as verified. */
export class BundleChangedError extends Error {}

export interface StageBundleFileOptions {
  filePath: string;
  /** The staged database, migrated to the bundle's schema, foreign keys off. */
  db: Database.Database;
  /** The staged profile root the artifacts land under. */
  staging: string;
  inventory: VerifiedBundleInventory;
  projectPaths: Record<string, string>;
  checkpoint?: (() => Promise<void>) | undefined;
}

export interface StagedBundleFile {
  /** Rows written per table, schema-marker rows excluded (as `writeRows` counts). */
  counts: Record<string, number>;
}

/**
 * Streams the verified archive into the staged profile: rows into `db`, blobs
 * and transcripts into the staged stores.
 *
 * Throws {@link BundleChangedError} when the file no longer reads as the bundle
 * that was verified; any other error is an I/O or SQLite failure. Either way
 * the caller owns cleanup of `staging`.
 */
export async function stageBundleFile(options: StageBundleFileOptions): Promise<StagedBundleFile> {
  const { inventory } = options;
  const gate = new CheckpointCounter(options.checkpoint);
  const reader = new ArchiveStreamReader(
    readGunzipped(options.filePath),
    inventory.secondPassPathRegistry(),
  );
  let loaded: TableLoad | undefined;
  let entries = 0;
  try {
    for (;;) {
      const entry = await reader.nextEntry();
      if (entry === null) break;
      const pinned = inventory.verifiedEntry(entry.path);
      if (pinned === undefined) {
        throw changed(`it now holds ${entry.path}, which was not there when it was verified`);
      }
      entries += 1;
      const hash = createHash("sha256");
      let size = 0;
      const chunks = hashedChunks(entry, hash, gate, (bytes) => {
        size += bytes;
      });
      if (entry.path === DATA_PATH) {
        loaded = await loadDataDocument(chunks, options, gate);
      } else if (entry.path.startsWith(BLOB_PREFIX)) {
        await writeBlobArtifact(options.staging, entry.path.slice(BLOB_PREFIX.length), chunks);
      } else if (entry.path.startsWith(TRANSCRIPT_PREFIX)) {
        await writeTranscriptArtifact(options.staging, entry.path, chunks);
      } else if (entry.path !== MANIFEST_PATH) {
        throw changed(`${entry.path} is not an entry this restore can place`);
      }
      // Drain anything a writer stopped short of, so the hash covers the body.
      for (;;) {
        const next = await chunks.next();
        if (next.done === true) break;
      }
      if (size !== pinned.sizeBytes || hash.digest("hex") !== pinned.sha256) {
        throw changed(`${entry.path} no longer matches the bytes that were verified`);
      }
      await gate.entry();
    }
  } catch (error) {
    if (error instanceof JsonSyntaxError) throw changed(`${DATA_PATH} is no longer valid JSON`);
    if (error instanceof BundleChangedError) throw error;
    // An archive or gzip failure on the second read of a file that verified
    // is a file that changed (or a disk that failed) under the restore.
    if (isArchiveFailure(error)) {
      throw changed(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
  if (entries !== inventory.verifiedEntryCount()) {
    throw changed("it holds a different number of entries than when it was verified");
  }
  if (loaded === undefined) throw changed(`it no longer holds ${DATA_PATH}`);
  // Every table, row for row, against the verifier's count of the same document.
  const verified = inventory.bundle.document.tables;
  const seen = new Set([...Object.keys(verified), ...Object.keys(loaded.read)]);
  for (const table of seen) {
    if (verified[table] !== loaded.read[table]) {
      throw changed(
        `table ${table} now reads ${loaded.read[table] ?? 0} rows; ${verified[table] ?? 0} were verified`,
      );
    }
  }
  return { counts: loaded.counts };
}

function changed(detail: string): BundleChangedError {
  return new BundleChangedError(`The backup file changed after it was verified: ${detail}.`);
}

function isArchiveFailure(error: unknown): boolean {
  if (error instanceof ArchiveError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code.startsWith("Z_");
}

/* ------------------------------------------------------------------------- */
/* Rows                                                                      */
/* ------------------------------------------------------------------------- */

interface TableLoad {
  /** Rows written per table, schema markers excluded. */
  counts: Record<string, number>;
  /** Rows read per table, schema markers included — the verifier's count. */
  read: Record<string, number>;
}

/**
 * Loads the data document's tables into the staged database, in document
 * order, the way `writeRows` loads a parsed one.
 *
 * The verifier has already accepted this document's shape, so the reader is
 * strict rather than diagnostic: anything other than what was verified is
 * {@link BundleChangedError}.
 */
async function loadDataDocument(
  chunks: AsyncIterable<Uint8Array>,
  options: StageBundleFileOptions,
  gate: CheckpointCounter,
): Promise<TableLoad> {
  const { db } = options;
  const tokenizer = new JsonTokenizer(chunks);
  const load: TableLoad = { counts: {}, read: {} };
  let tablesSeen = false;
  const batch = new CommitBatch(db);
  try {
    const opening = await tokenizer.next();
    if (opening.kind !== "object-start") throw changed(`${DATA_PATH} is no longer an object`);
    await readObjectEntries(tokenizer, async (key, value) => {
      if (key !== "tables") {
        await skipJsonValueFrom(tokenizer, value, 1);
        return;
      }
      if (tablesSeen || value.kind !== "object-start") {
        throw changed(`${DATA_PATH} no longer has one tables object`);
      }
      tablesSeen = true;
      await readObjectEntries(tokenizer, async (table, tableValue) => {
        if (tableValue.kind !== "object-start") {
          // Accepted by the verifier only for a table this schema does not owe.
          await skipJsonValueFrom(tokenizer, tableValue, 2);
          return;
        }
        if (options.inventory.verifiedColumns(table) === undefined || table in load.read) {
          throw changed(`${DATA_PATH} now carries table ${table} differently`);
        }
        await loadTable(table, tokenizer, load, options, batch, gate);
      });
    });
    await tokenizer.expectEnd();
    batch.finish();
  } catch (error) {
    batch.abandon();
    throw error;
  }
  if (!tablesSeen) throw changed(`${DATA_PATH} no longer has a tables object`);
  return load;
}

async function loadTable(
  table: string,
  tokenizer: JsonTokenizer,
  load: TableLoad,
  options: StageBundleFileOptions,
  batch: CommitBatch,
  gate: CheckpointCounter,
): Promise<void> {
  const { db, projectPaths } = options;
  let columns: string[] | undefined;
  let insert: Database.Statement | undefined;
  await readObjectEntries(tokenizer, async (key, value) => {
    if (key === "columns") {
      if (columns !== undefined || value.kind !== "array-start") {
        throw changed(`table ${table} no longer has one column list`);
      }
      const names: string[] = [];
      await readArrayItems(tokenizer, async (item) => {
        if (item.kind !== "string") throw changed(`table ${table} has a column that is not a name`);
        names.push(item.value);
      });
      // Only the exact columns that were verified — checked against this
      // build's schema — are ever named in SQL.
      const verified = options.inventory.verifiedColumns(table) ?? [];
      if (names.length !== verified.length || names.some((name, i) => name !== verified[i])) {
        throw changed(`table ${table} now lists different columns`);
      }
      columns = names;
      load.counts[table] = 0;
      load.read[table] = 0;
      // The `ticket_events` and `session_events` insert triggers have written
      // their guesses already; the bundle carries the real sequence numbers.
      if (TRIGGER_FILLED_TABLES[table] !== undefined) {
        batch.write(() => db.exec(`DELETE FROM "${table}"`));
      }
      return;
    }
    if (key !== "rows") {
      await skipJsonValueFrom(tokenizer, value, 3);
      return;
    }
    const tableColumns = columns;
    if (tableColumns === undefined || value.kind !== "array-start") {
      throw changed(`table ${table} no longer lists its columns before its rows`);
    }
    // Where `writeRows` substitutes the person's directory for the blank one.
    const pathIndex = table === "projects" ? tableColumns.indexOf("path") : -1;
    const idIndex = table === "projects" ? tableColumns.indexOf("id") : -1;
    await readArrayItems(tokenizer, async (rowToken) => {
      if (rowToken.kind !== "array-start") throw changed(`a ${table} row is no longer an array`);
      const row: unknown[] = [];
      await readArrayItems(tokenizer, async (item) => {
        row.push(await readJsonValueFrom(tokenizer, item, 5));
      });
      if (row.length !== tableColumns.length || !row.every(isBackupValue)) {
        throw changed(`a ${table} row no longer matches its columns`);
      }
      load.read[table] = (load.read[table] ?? 0) + 1;
      // A hand-built or foreign bundle's schema marker is never written back:
      // the migrations this restore runs own the restored file's floor.
      if (isSchemaMarkerRow(table, tableColumns, row)) {
        await gate.row();
        return;
      }
      insert ??= db.prepare(
        `INSERT INTO "${table}" (${tableColumns.map((column) => `"${column}"`).join(", ")})
         VALUES (${tableColumns.map(() => "?").join(", ")})`,
      );
      const statement = insert;
      const values = (row as BackupValue[]).map((cell, index) => {
        if (index === pathIndex) {
          const id = String(decodeValue(row[idIndex] as BackupValue));
          return projectPaths[id] ?? "";
        }
        return decodeValue(cell);
      });
      batch.write(() => statement.run(...(values as never[])));
      load.counts[table] = (load.counts[table] ?? 0) + 1;
      await gate.row();
    });
  });
  if (columns === undefined) throw changed(`table ${table} no longer has a column list`);
}

/**
 * Bounded transactions over the staged database.
 *
 * The in-memory restore loads every row in one transaction, which for a
 * gigabyte-scale profile is a gigabyte-scale WAL. The staging database is not
 * live and is deleted on any failure, so committing every few thousand rows
 * loses no guarantee and lets SQLite checkpoint as it goes.
 */
class CommitBatch {
  readonly #db: Database.Database;
  #open = false;
  #writes = 0;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  write(run: () => unknown): void {
    if (!this.#open) {
      this.#db.exec("BEGIN");
      this.#open = true;
    }
    run();
    this.#writes += 1;
    if (this.#writes >= ROWS_PER_COMMIT) {
      this.#writes = 0;
      this.#db.exec("COMMIT");
      this.#open = false;
    }
  }

  finish(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#db.exec("COMMIT");
  }

  abandon(): void {
    if (!this.#open) return;
    this.#open = false;
    try {
      this.#db.exec("ROLLBACK");
    } catch {
      // The staged database is discarded whole; a failed rollback changes nothing.
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Artifacts                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Streams one blob into the staged store, published under its name only after
 * its bytes hash to it.
 *
 * The staged store is a fresh, private directory, so this is the blob store's
 * layout (`blobFilePath`) without its concurrent-writer and torn-file repair:
 * nothing else writes here, and a duplicate path was refused by the archive
 * reader. Bytes are fsynced, as `writeBlob` does, before the rename.
 */
async function writeBlobArtifact(
  staging: string,
  hash: string,
  chunks: AsyncIterable<Uint8Array>,
): Promise<void> {
  const destination = blobFilePath(blobsRoot(staging), hash);
  const shard = dirname(destination);
  await mkdir(shard, { recursive: true });
  const temporary = `${shard}/.blob-restore-${randomUUID()}`;
  const digest = createHash("sha256");
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o666,
  );
  try {
    try {
      for await (const chunk of chunks) {
        digest.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (digest.digest("hex") !== hash) {
      throw changed(`${BLOB_PREFIX}${hash} no longer hashes to its name`);
    }
    await rename(temporary, destination);
    await syncDirectory(shard);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * One transcript, through the transcript store's own verified writer.
 *
 * The store validates the canonical JSON and compresses the artifact whole, so
 * this holds one transcript's bytes — the same unit the app reads.
 */
async function writeTranscriptArtifact(
  staging: string,
  path: string,
  chunks: AsyncIterable<Uint8Array>,
): Promise<void> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(Buffer.from(chunk));
  const hex = path.slice(TRANSCRIPT_PREFIX.length, -".json".length);
  const store = createFileTranscriptArtifactStore(sessionTranscriptsRoot(staging));
  // The store checks the digest and the artifact's JSON, as it does for the
  // in-memory restore; a failure surfaces as that restore's would.
  await store.writeCanonicalBytes(transcriptReferenceForId(`sha256:${hex}`), Buffer.concat(parts));
}
