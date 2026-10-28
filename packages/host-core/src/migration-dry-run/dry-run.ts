/**
 * The migration dry run: a non-destructive, end-to-end rehearsal of moving
 * one local profile into Volli Cloud, against a throwaway local backend.
 *
 *  1. **Snapshot.** The profile's `volli.db` is opened READ-ONLY and copied
 *     with SQLite's online backup into a fresh temporary directory. The live
 *     database is never opened for writing and never copied as raw files
 *     (that would race the WAL). Everything after reads the copy.
 *  2. **Export.** The real migration exporter runs on the copy.
 *  3. **Import.** Every importer stream is sent, in the importer's order, to the
 *     backend's `migration:importRows`. Session history is split by an
 *     activity window: a Session active within `hotDays` goes to
 *     `sessionEvents` (standing in for the drain until it exists); an older
 *     one is written as `ev/` archives with `eventArchives` index rows. Bulk
 *     objects (archives, oversize event payloads, blob bytes, legacy rows) are
 *     written in the object-storage key layout under a local directory, the
 *     stand-in for R2. Runner-local records go to a local runner directory.
 *  4. **Verify.** Each table is paged back and reconciled with what the
 *     shared mapping says it must hold (count + order-independent digest),
 *     and the invariants are spot-checked: ticket keys, column positions,
 *     contiguous Session sequences, archives and blob bytes in the stand-in,
 *     no machine paths or placeholders in a backend row. The import is then
 *     run a second time and must change nothing.
 *  5. **Report and clean up.** The report holds counts, digests and timings,
 *     never content. The temporary directory (the copy, its sidecars, the
 *     export and the stand-ins) is removed on success and failure alike.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import Database from "better-sqlite3";
import { UnknownSessionEventKindError, decodeSessionEventPayload } from "@volli/shared";
import {
  MIGRATION_DEFERRED_STREAMS,
  MIGRATION_IMPORT_STREAMS,
  MIGRATION_PLACEHOLDERS,
  MigrationDigest,
  MigrationRowError,
  SESSION_EVENT_ARCHIVE_FORMAT,
  SESSION_EVENT_INLINE_MAX_BYTES,
  canonicalJson,
  eventArchiveKey,
  eventSpillKey,
  jsonBytes,
  legacyArchiveKey,
  migrationDocument,
  migrationKey,
  migrationRowDigest,
  projectBlobKey,
  reportableProblem,
  storageProblem,
  type MigrationImportStream,
  type MigrationTarget,
} from "@volli/shared/cloud";
import { blobFilePath } from "../blob-store";
import {
  exportMigrationSnapshot,
  type MigrationExportManifest,
} from "../migration-export/exporter";
import type { StreamName } from "../migration-export/sources";
import { derivedId } from "../migration-export/transform";
import { legacyArchiveName } from "../migration-export/legacy-archives";
import { verifyMigrationExport } from "../migration-export/verify";
import type { ConvexAdmin } from "./convex-admin";
import { selectLocalProduct } from "../migration-export/scope";

/** A Session active within this many days is imported live; older ones are archived. */
export const DEFAULT_HOT_DAYS = 30;
const DAY_MS = 86_400_000;
/** Per-batch bounds, well inside a mutation's argument, write and time limits. */
const BATCH_MAX_ROWS = 200;
const BATCH_MAX_BYTES = 3 * 1024 * 1024;
/** One archive object holds at most this many events. */
const ARCHIVE_MAX_EVENTS = 5000;
const READ_PAGE_ROWS = 256;
const READ_PAGE_BYTES = 4 * 1024 * 1024;
const SESSION_EVENT_READ_ROWS = 128;
const ZSTD_LEVEL = { params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } };

const PLACEHOLDER_VALUES = new Set<string>(Object.values(MIGRATION_PLACEHOLDERS));

/** Fields whose values are a person's content, not structure: allowed to mention a path. */
const CONTENT_FIELDS: Readonly<Partial<Record<MigrationImportStream, readonly string[]>>> = {
  tickets: ["title"],
  ticketBodies: ["body"],
  ticketComments: ["body"],
  ticketSignals: ["detail"],
  sessions: ["title"],
  sessionEvents: ["payload", "provenance"],
  automations: ["instructions"],
  automationRuns: ["error"],
};

export interface MigrationDryRunOptions {
  /** The profile database to rehearse. Opened read-only. */
  profilePath: string;
  projectIds?: readonly string[];
  /** Where the profile's attachment bytes live. Default: `blobs/` beside the database. */
  blobsDir?: string;
  backend: ConvexAdmin;
  /** The build doing the export, recorded in the manifest. */
  appVersion: string;
  hotDays?: number;
  /** Import projects removed from the rail too (the migration offers it; off by default). */
  includeRemovedProjects?: boolean;
  /** Run the whole import a second time and require it to change nothing. Default true. */
  rerun?: boolean;
  /** The home directory treated as a machine path. Default `os.homedir()`. */
  homeDir?: string;

  onProgress?: (line: string) => void;
  /** Told the temporary workspace's path as soon as it exists, so a signal handler can remove it. */
  onWorkspace?: (path: string) => void;
}

interface StreamTally {
  exported: number;
  skippedRemoved: number;
  sent: number;

  inserted: number;
  unchanged: number;
  conflicts: number;
  rejected: Record<string, number>;
  expected: MigrationDigest;
}

export interface StreamReport {
  exported: number;
  skippedRemoved: number;
  sent: number;
  inserted: number;
  unchanged: number;
  conflicts: number;
  rejected: Record<string, number>;
  expectedRows: number;
  storedRows: number;
  expectedDigest: string;
  storedDigest: string;
  match: boolean;
  rerun?: { inserted: number; unchanged: number; conflicts: number; rejectedTotal: number };
}

export interface MigrationDryRunReport {
  ok: boolean;
  failures: string[];
  source: {
    schemaVersion: number;
    databaseBytes: number;
    quickCheck: string;
    foreignKeyViolations: number;
    tableRows: number;
    preflight: MigrationExportManifest["preflight"];
  };
  timingsMs: Record<string, number>;
  exported: { records: number; bytes: number; streams: Record<string, number> };
  /** Verified bulk source streams staged/read back locally; tx/pi commit is MOVE-4. */
  history: { transcriptArtifacts: number; piLogSlices: number; bytes: number };
  streams: Record<string, StreamReport>;
  deferred: Record<string, { records: number; reason: string }>;
  sessions: {
    hotDays: number;
    hot: number;
    archived: number;
    hotEvents: number;
    archivedEvents: number;
    archives: number;
    archiveBytes: number;
    kindUnknown: number;
    quarantined: number;
    spilled: Record<string, number>;
    sequenceGaps: number;
  };
  objects: {
    blobs: { copied: number; missing: number; shaMismatch: number; bytes: number };
    legacyArchives: number;
    legacyRows: number;
    runnerRecords: Record<string, number>;
  };
  invariants: Record<string, number>;
  cleanedUp: boolean;
}

type Row = Record<string, unknown>;

function emptyTally(): StreamTally {
  return {
    exported: 0,
    skippedRemoved: 0,
    sent: 0,

    inserted: 0,
    unchanged: 0,
    conflicts: 0,
    rejected: {},
    expected: new MigrationDigest(),
  };
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A rejection message safe for a report: no quoted values. */
function scrub(message: string): string {
  return message
    .split("\n")[0]!
    .replaceAll(/"[^"]*"/g, '"…"')
    .slice(0, 160);
}

/** Reads every record of one export stream, chunk by chunk. */
async function* streamRecords(
  exportDir: string,
  manifest: MigrationExportManifest,
  name: StreamName,
): AsyncGenerator<Row> {
  const stream = manifest.streams.find((entry) => entry.name === name);
  if (stream === undefined) return;
  for (const chunk of stream.chunks) {
    const text = await readFile(join(exportDir, chunk.file), "utf8");
    for (const line of text.split("\n")) if (line !== "") yield JSON.parse(line) as Row;
  }
}

async function writeObject(root: string, key: string, bytes: Uint8Array): Promise<void> {
  const path = join(root, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

/** SQLite's online backup of `source` into `dest`, from a read-only connection. */
async function snapshotProfile(source: string, dest: string): Promise<void> {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
}

/** Whether `doc` holds a placeholder or a machine path outside its content fields. */
function scanRow(
  stream: MigrationImportStream,
  doc: Row,
  needles: readonly string[],
  counts: Record<string, number>,
): void {
  const content = new Set(CONTENT_FIELDS[stream] ?? []);
  const walk = (value: unknown, top: string): void => {
    if (typeof value === "string") {
      if (PLACEHOLDER_VALUES.has(value)) {
        counts.placeholdersLeft = (counts.placeholdersLeft ?? 0) + 1;
      }
      if (needles.some((needle) => value.includes(needle))) {
        if (content.has(top)) {
          counts.contentPathMentions = (counts.contentPathMentions ?? 0) + 1;
        } else {
          // Named by table and top-level field (schema names, never content).
          const where = `structuralPathHits:${stream}.${top}`;
          counts[where] = (counts[where] ?? 0) + 1;
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, top);
    } else if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) walk(item, top);
    }
  };
  for (const [field, value] of Object.entries(doc)) walk(value, field);
}

/* eslint-disable max-lines-per-function -- one rehearsal, read top to bottom */
export async function runMigrationDryRun(
  options: MigrationDryRunOptions,
): Promise<MigrationDryRunReport> {
  const log = options.onProgress ?? (() => {});
  const timings: Record<string, number> = {};
  const failures: string[] = [];
  const time = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await run();
    } finally {
      timings[name] = Math.round(performance.now() - started);
    }
  };

  const workspace = await mkdtemp(join(tmpdir(), "volli-migration-dry-run-"));
  let report: MigrationDryRunReport;
  try {
    options.onWorkspace?.(workspace);
    const copyPath = join(workspace, "profile", "volli.db");
    const exportDir = join(workspace, "export");
    const r2Root = join(workspace, "r2");
    const runnerRoot = join(workspace, "runner");
    await mkdir(dirname(copyPath), { recursive: true });

    // ---- 1. snapshot --------------------------------------------------------
    log("snapshot: online backup from a read-only connection");
    await time("snapshot", () => snapshotProfile(options.profilePath, copyPath));
    const databaseBytes = (await stat(copyPath)).size;
    // The source's own column order, read from the snapshot: what the
    // migrated positions must reproduce (the export carries keys, not order).
    const ticketColumns = new Map<string, string[]>();
    const { quickCheck, foreignKeyViolations } = await time("sourceChecks", async () => {
      const db = new Database(copyPath, { readonly: true });
      try {
        const check = db.pragma("quick_check", { simple: true }) as string;
        const violations = (db.pragma("foreign_key_check") as unknown[]).length;
        selectLocalProduct(db, { projectIds: options.projectIds, includeRemovedProjects: true });
        const rows = db
          .prepare(
            "SELECT id, project_id, status FROM tickets ORDER BY project_id, status, position, created_at, id",
          )
          .all() as Array<{ id: string; project_id: string; status: string }>;
        for (const row of rows) {
          const column = `${row.project_id}\u0000${row.status}`;
          const list = ticketColumns.get(column) ?? [];
          list.push(row.id);
          ticketColumns.set(column, list);
        }
        return { quickCheck: check, foreignKeyViolations: violations };
      } finally {
        db.close();
      }
    });
    if (quickCheck !== "ok") failures.push("the snapshot failed quick_check");
    if (foreignKeyViolations > 0) {
      failures.push(`the snapshot has ${foreignKeyViolations} foreign key violations`);
    }

    // ---- 2. export ----------------------------------------------------------
    log("export: running the migration exporter on the copy");
    const homeDir = options.homeDir ?? homedir();
    const { manifest } = await time("export", () =>
      exportMigrationSnapshot({
        sourcePath: copyPath,
        outDir: exportDir,
        appVersion: options.appVersion,
        homeDir,
        includeRemovedProjects: true,
        projectIds: options.projectIds,
        transcriptsDir: join(dirname(options.profilePath), "session-transcripts"),
        piLogsDir: join(dirname(options.profilePath), "pi-sessions"),
        blobsDir: options.blobsDir ?? join(dirname(options.profilePath), "blobs"),
      }),
    );
    const verification = await time("exportVerify", () => verifyMigrationExport(exportDir));
    // The copy has done its job; nothing reads it again.
    await rm(dirname(copyPath), { recursive: true, force: true });

    const history = { transcriptArtifacts: 0, piLogSlices: 0, bytes: 0 };
    // Rehearse the bulk export's bytes through the object stand-in as well as
    // the chunk verifier. These are source streams, not committed tx/pi packs.
    for (const name of ["transcriptArtifacts", "piLogs"] as const) {
      const stream = manifest.streams.find((s) => s.name === name)!;
      history[name === "piLogs" ? "piLogSlices" : "transcriptArtifacts"] = stream.records;
      for (const [index, chunk] of stream.chunks.entries()) {
        const bytes = await readFile(join(exportDir, chunk.file));
        const key = migrationKey(manifest.exportId, `${name}-${index}.ndjson`);
        await writeObject(r2Root, key, bytes);
        const copied = await readFile(join(r2Root, key));
        if (sha256Hex(copied) !== chunk.sha256) failures.push(`${name} staged digest mismatch`);
        history.bytes += copied.length;
      }
    }

    // ---- 3. import ----------------------------------------------------------
    const target: MigrationTarget = {
      userId: randomUUID(),
      workspaceId: randomUUID(),
      runnerId: randomUUID(),
    };
    const migrationId = randomUUID();
    await options.backend.mutation("migration:begin", {
      target,
      createMissing: true,
      displayName: "Migration dry run",
      runnerName: "This Mac",
    });
    const importedAt = Date.now();
    const hotDays = options.hotDays ?? DEFAULT_HOT_DAYS;
    const hotSince = manifest.snapshotAt - hotDays * DAY_MS;
    const blobsDir = options.blobsDir ?? join(dirname(options.profilePath), "blobs");

    const invariants: Record<string, number> = {};
    const removedProjects = new Set<string>();
    const projectOfTicket = new Map<string, string>();
    const sessionInfo = new Map<
      string,
      { projectId: string; hot: boolean; lastSequence: number }
    >();
    const pathNeedles = new Set<string>(homeDir.length >= 4 ? [homeDir] : []);
    const objectsReport: MigrationDryRunReport["objects"] = {
      blobs: { copied: 0, missing: 0, shaMismatch: 0, bytes: 0 },
      legacyArchives: 0,
      legacyRows: 0,
      runnerRecords: {},
    };
    const sessionsReport: MigrationDryRunReport["sessions"] = {
      hotDays,
      hot: 0,
      archived: 0,
      hotEvents: 0,
      archivedEvents: 0,
      archives: 0,
      archiveBytes: 0,
      kindUnknown: 0,
      quarantined: 0,
      spilled: {},
      sequenceGaps: 0,
    };

    // Runner-local streams: never uploaded, kept beside the stand-in as the runner would.
    for (const name of ["projectCheckoutPaths", "workingCopyPaths", "mcpCatalogCache"] as const) {
      const lines: string[] = [];
      for await (const record of streamRecords(exportDir, manifest, name)) {
        if (typeof record.absPath === "string" && record.absPath.length >= 4) {
          pathNeedles.add(record.absPath);
        }
        lines.push(JSON.stringify(record));
      }
      objectsReport.runnerRecords[name] = lines.length;
      await writeObject(runnerRoot, `${name}.ndjson`, Buffer.from(lines.join("\n")));
    }

    /** The project a record belongs to, for the removed-project filter. */
    const projectOf = (stream: MigrationImportStream, record: Row): string | null => {
      if (typeof record.projectId === "string") return record.projectId;
      if (stream === "projects") return record.id as string;
      if (stream === "ticketBodies") return projectOfTicket.get(record.ticketId as string) ?? null;
      const sessionId = record.sessionId ?? record.childSessionId ?? record.parentSessionId;
      return typeof sessionId === "string" ? (sessionInfo.get(sessionId)?.projectId ?? null) : null;
    };

    const runImport = async (pass: 1 | 2) => {
      const tallies = new Map<MigrationImportStream, StreamTally>();
      const tally = (stream: MigrationImportStream) => {
        let entry = tallies.get(stream);
        if (entry === undefined) tallies.set(stream, (entry = emptyTally()));
        return entry;
      };

      const sendBatch = async (stream: MigrationImportStream, rows: Row[]): Promise<void> => {
        const entry = tally(stream);
        try {
          const result = await options.backend.mutation<{
            inserted: number;
            unchanged: number;
            conflicts: unknown[];
            rejected: Array<{ code: string; detail: string }>;
          }>("migration:importRows", { target, stream, rows });
          entry.inserted += result.inserted;
          entry.unchanged += result.unchanged;
          entry.conflicts += result.conflicts.length;
          for (const reject of result.rejected) {
            const key = `${reject.code}: ${scrub(reject.detail)}`;
            entry.rejected[key] = (entry.rejected[key] ?? 0) + 1;
          }
        } catch (error) {
          if (rows.length > 1) {
            const half = Math.ceil(rows.length / 2);
            await sendBatch(stream, rows.slice(0, half));
            await sendBatch(stream, rows.slice(half));
            return;
          }
          const key = `batch_error: ${scrub(error instanceof Error ? error.message : String(error))}`;
          entry.rejected[key] = (entry.rejected[key] ?? 0) + 1;
        }
      };

      /** Buffers a stream's records into bounded batches. */
      const batcher = (stream: MigrationImportStream) => {
        let rows: Row[] = [];
        let bytes = 0;
        return {
          async add(record: Row) {
            const entry = tally(stream);
            // A row the shared mapping refuses, or one Convex's wire format
            // cannot carry, is not sent: it is a refusal, and fails the run.
            let refusal: string | null = null;
            let digest: string | null = null;
            try {
              digest = migrationRowDigest(
                stream,
                migrationDocument(stream, record, target, importedAt),
              );
              const problem = storageProblem(record);
              if (problem !== null) refusal = `unstorable: ${reportableProblem(problem)}`;
            } catch (error) {
              if (!(error instanceof MigrationRowError)) throw error;
              refusal = `${error.code}: ${scrub(error.message)}`;
            }
            if (refusal !== null) {
              if (pass === 1) entry.rejected[refusal] = (entry.rejected[refusal] ?? 0) + 1;
              return;
            }
            entry.sent += 1;
            if (pass === 1) entry.expected.add(digest!);
            const size = jsonBytes(record);
            if (
              rows.length > 0 &&
              (rows.length >= BATCH_MAX_ROWS || bytes + size > BATCH_MAX_BYTES)
            ) {
              await this.flush();
            }
            rows.push(record);
            bytes += size;
          },
          async flush() {
            if (rows.length === 0) return;
            const batch = rows;
            rows = [];
            bytes = 0;
            await sendBatch(stream, batch);
          },
        };
      };

      for (const stream of MIGRATION_IMPORT_STREAMS) {
        if (stream === "eventArchives" || stream === "sessionIntake") continue;
        const started = performance.now();
        log(`import (pass ${pass}): ${stream}`);
        if (stream === "sessionEvents") {
          await importSessionHistory(pass, batcher, tally);
        } else {
          const out = batcher(stream);
          for await (const record of streamRecords(exportDir, manifest, stream)) {
            const entry = tally(stream);
            entry.exported += 1;
            if (pass === 1) remember(stream, record);
            const projectId = projectOf(stream, record);
            if (projectId !== null && removedProjects.has(projectId)) {
              entry.skippedRemoved += 1;
              continue;
            }
            if (stream === "blobs" && pass === 1) await copyBlob(record);
            await out.add(record);
          }
          await out.flush();
        }
        timings[`import.${stream}${pass === 2 ? ".rerun" : ""}`] = Math.round(
          performance.now() - started,
        );
      }
      return tallies;
    };

    /** Lookups the later streams need, collected as the earlier ones pass. */
    const remember = (stream: MigrationImportStream, record: Row) => {
      if (
        stream === "projects" &&
        record.removedAt !== null &&
        options.includeRemovedProjects !== true
      ) {
        removedProjects.add(record.id as string);
      }
      if (stream === "tickets") {
        projectOfTicket.set(record.id as string, record.projectId as string);
      }
      if (stream === "sessions") {
        sessionInfo.set(record.id as string, {
          projectId: record.projectId as string,
          hot: (record.lastActivityAt as number) >= hotSince,
          lastSequence: record.lastSequence as number,
        });
      }
    };

    const copyBlob = async (record: Row) => {
      const sha = record.sha256 as string;
      const source = blobFilePath(blobsDir, sha);
      if (!existsSync(source)) {
        objectsReport.blobs.missing += 1;
        return;
      }
      const bytes = await readFile(source);
      if (sha256Hex(bytes) !== sha) {
        objectsReport.blobs.shaMismatch += 1;
        return;
      }
      await writeObject(r2Root, record.key as string, bytes);
      objectsReport.blobs.copied += 1;
      objectsReport.blobs.bytes += bytes.length;
    };

    /**
     * Session history, one Session at a time (the stream is ordered by
     * Session, then sequence). Hot Sessions' events go to the backend;
     * archived Sessions' events become `ev/` objects with index rows. Every
     * Session gets its intake row, its cursor at the last sequence.
     */
    const importSessionHistory = async (
      pass: 1 | 2,
      batcher: (stream: MigrationImportStream) => {
        add(record: Row): Promise<void>;
        flush(): Promise<void>;
      },
      tally: (stream: MigrationImportStream) => StreamTally,
    ) => {
      const events = batcher("sessionEvents");
      const archives = batcher("eventArchives");
      const intake = batcher("sessionIntake");
      const intakeOf = new Map<string, { lastSequence: number; lastEventId: string | null }>();
      let current: string | null = null;
      let archiveBuffer: Row[] = [];

      const flushArchive = async () => {
        if (archiveBuffer.length === 0) return;
        const sessionId = archiveBuffer[0]!.sessionId as string;
        const projectId = sessionInfo.get(sessionId)!.projectId;
        const firstSequence = archiveBuffer[0]!.sequence as number;
        const lastSequence = archiveBuffer.at(-1)!.sequence as number;
        const header = {
          format: SESSION_EVENT_ARCHIVE_FORMAT,
          sessionId,
          firstSequence,
          lastSequence,
          eventCount: archiveBuffer.length,
          enc: null,
        };
        const text = [
          header,
          ...archiveBuffer.map((event) => ({ ...event, acceptedAt: importedAt })),
        ]
          .map((line) => JSON.stringify(line))
          .join("\n");
        const bytes = zstdCompressSync(Buffer.from(`${text}\n`), ZSTD_LEVEL);
        const key = eventArchiveKey({ projectId, sessionId, firstSequence, lastSequence });
        await writeObject(r2Root, key, bytes);
        if (pass === 1) {
          sessionsReport.archives += 1;
          sessionsReport.archiveBytes += bytes.length;
        }
        await archives.add({
          id: derivedId("event-archive", sessionId, String(firstSequence), String(lastSequence)),
          sessionId,
          firstSequence,
          lastSequence,
          key,
          bytes: bytes.length,
          sha256: sha256Hex(bytes),
          eventCount: archiveBuffer.length,
          format: SESSION_EVENT_ARCHIVE_FORMAT,
          source: "migration",
          createdAt: importedAt,
        });
        archiveBuffer = [];
      };

      for await (const record of streamRecords(exportDir, manifest, "sessionEvents")) {
        const entry = tally("sessionEvents");
        entry.exported += 1;
        if (entry.exported % 50_000 === 0)
          log(`import (pass ${pass}): ${entry.exported} Session events`);
        const sessionId = record.sessionId as string;
        const info = sessionInfo.get(sessionId);
        if (info === undefined) {
          if (pass === 1)
            invariants.orphanSessionEvents = (invariants.orphanSessionEvents ?? 0) + 1;
          continue;
        }
        if (removedProjects.has(info.projectId)) {
          entry.skippedRemoved += 1;
          continue;
        }
        if (sessionId !== current) {
          await flushArchive();
          current = sessionId;
        }
        const previous = intakeOf.get(sessionId);
        const sequence = record.sequence as number;
        if (pass === 1 && sequence !== (previous?.lastSequence ?? 0) + 1) {
          sessionsReport.sequenceGaps += 1;
        }
        intakeOf.set(sessionId, { lastSequence: sequence, lastEventId: record.id as string });

        if (!info.hot) {
          if (pass === 1) sessionsReport.archivedEvents += 1;
          entry.sent += 1;
          archiveBuffer.push(record);
          if (archiveBuffer.length >= ARCHIVE_MAX_EVENTS) await flushArchive();
          continue;
        }
        if (pass === 1) sessionsReport.hotEvents += 1;
        await events.add(await prepareHotEvent(record, info.projectId, pass));
      }
      await flushArchive();
      await events.flush();
      await archives.flush();
      for (const [sessionId, info] of sessionInfo) {
        if (removedProjects.has(info.projectId)) continue;
        if (pass === 1) {
          if (info.hot) sessionsReport.hot += 1;
          else sessionsReport.archived += 1;
        }
        const last = intakeOf.get(sessionId);
        await intake.add({
          sessionId,
          acceptedThrough: last?.lastSequence ?? 0,
          lastEventId: last?.lastEventId ?? null,
        });
      }
      await intake.flush();
    };

    /**
     * A hot event as the backend stores it: classified the way the accept
     * fold classifies it (an unknown kind is stored and not folded; a
     * malformed known kind is quarantined), with an oversize or unstorable
     * payload spilled to `…/e/{sequence}.json.zst`.
     */
    const prepareHotEvent = async (record: Row, projectId: string, pass: 1 | 2): Promise<Row> => {
      let kindKnown = true;
      let quarantine: { code: string; detail: string } | null = null;
      try {
        decodeSessionEventPayload(record.payload, "payload");
      } catch (error) {
        if (error instanceof UnknownSessionEventKindError) kindKnown = false;
        else quarantine = { code: "malformed", detail: scrub(String((error as Error).message)) };
      }
      if (pass === 1 && !kindKnown) sessionsReport.kindUnknown += 1;
      if (pass === 1 && quarantine !== null) sessionsReport.quarantined += 1;
      const bytes = jsonBytes(record.payload);
      let payload = record.payload;
      const problem = bytes > SESSION_EVENT_INLINE_MAX_BYTES ? "oversize" : storageProblem(payload);
      if (problem !== null) {
        const reason = problem === "oversize" ? "oversize" : problem.replace(/ at .*$/, "");
        if (pass === 1) sessionsReport.spilled[reason] = (sessionsReport.spilled[reason] ?? 0) + 1;
        const object = zstdCompressSync(Buffer.from(canonicalJson(payload)), ZSTD_LEVEL);
        const key = eventSpillKey({
          projectId,
          sessionId: record.sessionId as string,
          sequence: record.sequence as number,
        });
        await writeObject(r2Root, key, object);
        const kind = (payload as { kind?: unknown } | null)?.kind;
        payload = {
          kind: typeof kind === "string" ? kind : "unknown",
          spill: { key, bytes: object.length, sha256: sha256Hex(object) },
        };
      }
      return { ...record, payload, kindKnown, quarantine, bytes };
    };

    const firstPass = await time("import", () => runImport(1));

    // Legacy rows: archived per project and table, never ported as rows.
    await time("legacyArchives", async () => {
      const groups = new Map<string, string[]>();
      for await (const record of streamRecords(exportDir, manifest, "legacyRows")) {
        const projectId = record.projectId as string | null;
        if (projectId !== null && removedProjects.has(projectId)) continue;
        const table = String(record.table);
        const name = legacyArchiveName(table);
        const key =
          projectId === null
            ? migrationKey(migrationId, `legacy-host-${name}.ndjson.zst`)
            : legacyArchiveKey(projectId, name);
        const lines = groups.get(key) ?? [];
        lines.push(JSON.stringify(record));
        groups.set(key, lines);
        objectsReport.legacyRows += 1;
      }
      for (const [key, lines] of groups) {
        await writeObject(
          r2Root,
          key,
          zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`), ZSTD_LEVEL),
        );
        objectsReport.legacyArchives += 1;
      }
    });

    // ---- 4. verify ----------------------------------------------------------

    const stored = new Map<MigrationImportStream, MigrationDigest>();
    const hotEventsBySession = new Map<string, { count: number; max: number }>();
    const archivesBySession = new Map<string, Array<[number, number]>>();
    const intakeBySession = new Map<string, number>();
    const columns = new Map<string, Array<{ id: string; position: string }>>();
    const numbers = new Map<string, Set<number>>();
    const nextNumber = new Map<string, number>();
    const needles = [...pathNeedles];
    await time("verify", async () => {
      for (const stream of MIGRATION_IMPORT_STREAMS) {
        log(`verify: ${stream}`);
        const digest = new MigrationDigest();
        stored.set(stream, digest);
        if (stream === "sessionEvents") {
          // Paging a table of hundreds of thousands of large rows is slow
          // (seconds a page); one ranged index read per Session is not.
          for (const sessionId of sessionInfo.keys()) {
            let afterSequence = 0;
            let limit = SESSION_EVENT_READ_ROWS;
            for (;;) {
              let rows: Row[];
              try {
                ({ rows } = await options.backend.query<{ rows: Row[] }>(
                  "migration:readSessionEvents",
                  { target, sessionId, afterSequence, limit },
                ));
              } catch (error) {
                // A run of large payloads can pass a query's read limit: read fewer.
                if (limit === 1) throw error;
                limit = Math.max(1, Math.floor(limit / 2));
                continue;
              }
              for (const row of rows) {
                digest.add(migrationRowDigest(stream, row));
                scanRow(stream, row, needles, invariants);
                await checkRow(stream, row);
              }
              if (rows.length < limit) break;
              afterSequence = rows.at(-1)!.sequence as number;
            }
          }
          continue;
        }
        let cursor: string | null = null;
        // A page of large rows can be too heavy for one query: halve it until
        // it fits, down to a single row.
        let numItems = READ_PAGE_ROWS;
        for (;;) {
          let page: { rows: Row[]; continueCursor: string; isDone: boolean };
          try {
            page = await options.backend.query("migration:readPage", {
              target,
              stream,
              cursor,
              numItems,
              maximumBytesRead: READ_PAGE_BYTES,
            });
          } catch (error) {
            if (numItems === 1) throw error;
            numItems = Math.max(1, Math.floor(numItems / 2));
            continue;
          }
          for (const row of page.rows) {
            digest.add(migrationRowDigest(stream, row));
            scanRow(stream, row, needles, invariants);
            await checkRow(stream, row);
          }
          if (page.isDone) break;
          cursor = page.continueCursor;
        }
      }
    });

    async function checkRow(stream: MigrationImportStream, row: Row) {
      const bump = (name: string) => (invariants[name] = (invariants[name] ?? 0) + 1);
      switch (stream) {
        case "tickets": {
          const column = `${String(row.projectId)}\u0000${String(row.status)}`;
          const list = columns.get(column) ?? [];
          list.push({ id: row.id as string, position: row.position as string });
          columns.set(column, list);
          const seen = numbers.get(row.projectId as string) ?? new Set<number>();
          if (seen.has(row.number as number)) bump("duplicateTicketKeys");
          seen.add(row.number as number);
          numbers.set(row.projectId as string, seen);
          break;
        }
        case "projectCounters":
          nextNumber.set(row.projectId as string, row.nextTicketNumber as number);
          break;
        case "sessionEvents": {
          const entry = hotEventsBySession.get(row.sessionId as string) ?? { count: 0, max: 0 };
          entry.count += 1;
          entry.max = Math.max(entry.max, row.sequence as number);
          hotEventsBySession.set(row.sessionId as string, entry);
          const spill = (row.payload as { spill?: { key: string; sha256: string } }).spill;
          if (spill !== undefined) {
            const path = join(r2Root, spill.key);
            if (!existsSync(path) || sha256Hex(await readFile(path)) !== spill.sha256) {
              bump("spillObjectsMissingOrDamaged");
            }
          }
          break;
        }
        case "eventArchives": {
          const ranges = archivesBySession.get(row.sessionId as string) ?? [];
          ranges.push([row.firstSequence as number, row.lastSequence as number]);
          archivesBySession.set(row.sessionId as string, ranges);
          const path = join(r2Root, row.key as string);
          if (!existsSync(path)) {
            bump("archiveObjectsMissing");
            break;
          }
          const bytes = await readFile(path);
          if (bytes.length !== row.bytes || sha256Hex(bytes) !== row.sha256) {
            bump("archiveObjectsDamaged");
            break;
          }
          const lines = zstdDecompressSync(bytes).toString("utf8").trimEnd().split("\n");
          const header = JSON.parse(lines[0]!) as Row;
          if (
            header.format !== SESSION_EVENT_ARCHIVE_FORMAT ||
            lines.length - 1 !== row.eventCount ||
            (row.lastSequence as number) - (row.firstSequence as number) + 1 !== row.eventCount
          ) {
            bump("archiveObjectsInconsistent");
          }
          break;
        }
        case "sessionIntake":
          intakeBySession.set(row.sessionId as string, row.acceptedThrough as number);
          if ((row.claim as { runnerId: string }).runnerId !== target.runnerId)
            bump("intakeWrongClaim");
          break;
        case "blobs": {
          let expectedKey: string | null = null;
          try {
            expectedKey = projectBlobKey(row.projectId as string, row.sha256 as string);
          } catch {
            // A key part the layout refuses: counted as a wrong key below.
          }
          if (row.key !== expectedKey) bump("blobKeysOffLayout");
          const path = join(r2Root, row.key as string);
          if (!existsSync(path)) bump("blobObjectsMissing");
          break;
        }
        default:
          break;
      }
    }

    // Ticket keys: unique per project, and below the project's next number.
    for (const [projectId, seen] of numbers) {
      const next = nextNumber.get(projectId);
      if (next === undefined || [...seen].some((number) => number >= next)) {
        invariants.ticketNumbersAtOrPastCounter =
          (invariants.ticketNumbersAtOrPastCounter ?? 0) + 1;
      }
    }
    // Column positions: unique, and in the order the export carried the column.
    for (const [column, list] of columns) {
      const sorted = list.toSorted((a, b) =>
        a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
      );
      if (new Set(list.map((entry) => entry.position)).size !== list.length) {
        invariants.duplicatePositions = (invariants.duplicatePositions ?? 0) + 1;
      }
      const expected = (ticketColumns.get(column) ?? []).filter((id) =>
        list.some((entry) => entry.id === id),
      );
      if (sorted.map((entry) => entry.id).join() !== expected.join()) {
        invariants.columnsOutOfOrder = (invariants.columnsOutOfOrder ?? 0) + 1;
      }
    }
    // Sessions: the cursor at the last sequence, history whole and contiguous.
    for (const [sessionId, info] of sessionInfo) {
      if (removedProjects.has(info.projectId)) continue;
      const bump = (name: string) => (invariants[name] = (invariants[name] ?? 0) + 1);
      if (intakeBySession.get(sessionId) !== info.lastSequence) bump("intakeNotAtLastSequence");
      if (info.hot) {
        const hot = hotEventsBySession.get(sessionId) ?? { count: 0, max: 0 };
        if (hot.count !== info.lastSequence || hot.max !== info.lastSequence)
          bump("hotSessionsIncomplete");
      } else {
        const ranges = (archivesBySession.get(sessionId) ?? []).toSorted((a, b) => a[0] - b[0]);
        let next = 1;
        for (const [first, last] of ranges) {
          if (first !== next) break;
          next = last + 1;
        }
        if (next !== info.lastSequence + 1 || hotEventsBySession.has(sessionId)) {
          bump("archivedSessionsIncomplete");
        }
      }
    }

    // ---- the second run must change nothing ----------------------------------
    const secondPass = options.rerun === false ? null : await time("rerun", () => runImport(2));

    // ---- 5. report ------------------------------------------------------------
    const streams: Record<string, StreamReport> = {};
    for (const stream of MIGRATION_IMPORT_STREAMS) {
      const entry = firstPass.get(stream) ?? emptyTally();
      const actual = stored.get(stream)!;
      const rejectedTotal = Object.values(entry.rejected).reduce((sum, count) => sum + count, 0);
      const summary: StreamReport = {
        exported: entry.exported,
        skippedRemoved: entry.skippedRemoved,
        sent: entry.sent,
        inserted: entry.inserted,
        unchanged: entry.unchanged,
        conflicts: entry.conflicts,
        rejected: entry.rejected,
        expectedRows: entry.expected.count,
        storedRows: actual.count,
        expectedDigest: entry.expected.value,
        storedDigest: actual.value,
        match: entry.expected.count === actual.count && entry.expected.value === actual.value,
      };
      if (!summary.match)
        failures.push(`${stream}: the backend does not hold what the export says`);
      if (entry.conflicts > 0) failures.push(`${stream}: ${entry.conflicts} conflicts`);
      // Every refused row is a row the migration would lose: never a pass.
      if (rejectedTotal > 0) failures.push(`${stream}: ${rejectedTotal} rows refused`);
      const again = secondPass?.get(stream);
      if (again !== undefined) {
        const againRejected = Object.values(again.rejected).reduce((sum, count) => sum + count, 0);
        summary.rerun = {
          inserted: again.inserted,
          unchanged: again.unchanged,
          conflicts: again.conflicts,
          rejectedTotal: againRejected,
        };
        if (again.inserted > 0 || again.conflicts > 0) {
          failures.push(`${stream}: the second run was not a no-op`);
        }
      }
      streams[stream] = summary;
    }
    for (const [name, count] of Object.entries(invariants)) {
      if (name !== "contentPathMentions" && count > 0) failures.push(`invariant ${name}: ${count}`);
    }
    if (sessionsReport.sequenceGaps > 0)
      failures.push(`${sessionsReport.sequenceGaps} Session sequence gaps`);
    if (objectsReport.blobs.shaMismatch > 0)
      failures.push("blob bytes that do not match their hash");

    const deferred: MigrationDryRunReport["deferred"] = {};
    for (const [name, reason] of Object.entries(MIGRATION_DEFERRED_STREAMS)) {
      const stream = manifest.streams.find((entry) => entry.name === name);
      deferred[name] = { records: stream?.records ?? 0, reason };
    }

    report = {
      ok: failures.length === 0,
      failures,
      source: {
        schemaVersion: manifest.source.schemaVersion,
        databaseBytes,
        quickCheck: quickCheck === "ok" ? "ok" : "failed",
        foreignKeyViolations,
        tableRows: Object.values(manifest.source.tableRows).reduce((sum, count) => sum + count, 0),
        preflight: manifest.preflight,
      },
      timingsMs: timings,
      exported: {
        records: verification.records,
        bytes: verification.bytes,
        streams: Object.fromEntries(
          manifest.streams.map((stream) => [stream.name, stream.records]),
        ),
      },
      streams,
      deferred,
      sessions: sessionsReport,
      objects: objectsReport,
      history,
      invariants,
      cleanedUp: false,
    };
  } finally {
    // The copy, its sidecars, the export and the stand-ins: gone on every path out.
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  report.cleanedUp = !existsSync(workspace);
  if (!report.cleanedUp) {
    report.ok = false;
    report.failures.push("the temporary workspace could not be removed");
  }
  return report;
}
/* eslint-enable max-lines-per-function */
