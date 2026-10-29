/**
 * Restoring a bundle: build a whole new profile beside the old one, check it,
 * and only then make it the current one.
 *
 * NEVER a merge and never an overwrite. Those are the two shapes a restore
 * usually takes and both are unrecoverable when they go wrong halfway: a merge
 * leaves a database holding two histories with no way to tell which row came
 * from where, and an overwrite has already destroyed the thing the person
 * would want back. Here every write lands in a staging directory the live app
 * is not reading, every check runs against that staged profile, and the last
 * step is a rename. Anything that fails before the rename leaves the original
 * profile byte-for-byte as it was.
 *
 * THE PERSON SUPPLIES THE PATHS. A bundle carries no project directory — the
 * writer blanked it — so a restore cannot proceed without being told where
 * each project lives on THIS machine. That is a safety property rather than a
 * convenience: silently reusing `/Users/someone/code/thing` would point Volli
 * at whatever happens to be at that path here, and then create worktrees and
 * run setup commands inside it.
 *
 * TWO READERS, ONE RESTORE. `restoreBackupBundleFile` reads a bundle file of
 * any size with bounded memory (VC-988): the bounded v1 verifier, then a
 * second, pinned read that stages it (`restore-stream.ts`).
 * `restoreBackupBundle` takes the bytes and stays for small callers. Both run
 * {@link stageAndActivate}: the same migrations, usage rebuild, staged checks
 * and fenced swap.
 *
 * What this module does not do is decide when to run, ask the questions, or
 * relaunch the app. It takes a bundle and a mapping and returns a report, which
 * keeps it testable against fixture profiles and leaves the surface — and the
 * progress reporting — to the restore UI. No production surface calls either
 * entry point yet; the restore surface (VC-997) is the receiving caller, and a
 * profile-sized restore must use the file entry point.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import Database from "better-sqlite3";

import { blobsRoot, writeBlob } from "../blob-store";
import {
  DatabaseSwapFinalizeError,
  DatabaseSwapRollbackError,
  swapInStagedProfile,
} from "../db/database-file";
import type { DatabaseFileFaults } from "../db/database-file";
import { MIGRATIONS, migrate } from "../db/migrations";
import { MIN_READER_VERSION_KEY } from "../db/schema-compatibility";
import { SqliteSessionLedger } from "../session-control/sqlite-ledger";
import {
  createFileTranscriptArtifactStore,
  sessionTranscriptsRoot,
  transcriptReferenceForId,
} from "../session-runtime/transcript-artifacts";
import {
  BLOB_PREFIX,
  readBackupBundle,
  TRANSCRIPT_PREFIX,
  type BackupManifest,
  type BackupManifestEntry,
  type ReadBackupBundle,
} from "./bundle";
import { decodeValue, isSchemaMarkerRow } from "./data-document";
import type { BackupDataDocument, BackupProblem } from "./data-document";
import { BACKUP_INCLUDED_TABLES } from "./decisions";
import { stageBundleFile, TRIGGER_FILLED_TABLES } from "./restore-stream";
import { openVerifiedBackupBundleFile } from "./streaming";
import type { VerifiedBundleInventory } from "./streaming";

/** The newest schema this build can migrate a restored profile to. */
export function headSchemaVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}

export interface RestoreRequest {
  /** The bundle's bytes. */
  bundle: Buffer;
  /** The profile root to restore INTO — Electron `userData` in the app. */
  profileRoot: string;
  /** Project id → the local directory that project lives in on this machine. */
  projectPaths: Record<string, string>;
  now: number;
  /** Crash tests only: stop the profile swap at a named step. */
  faults?: DatabaseFileFaults;
}

/**
 * What a restore says about credentials (VC-559).
 *
 * No bundle carries a credential, encrypted or not, whichever secret-key
 * adapter sealed them on the machine that wrote it: the macOS keychain, a
 * headless host's key file, or one this build has never heard of. So a bundle
 * from a Mac restores onto a headless host, or back, exactly as it restores
 * onto the machine that made it, and nothing undecryptable is ever written.
 * What the restore leaves alone is this profile's own credential files
 * (`session-secrets.enc`, a headless `session-secrets.key`,
 * `mcp-credentials.json`) and Pi's `auth.json` outside the profile: they are
 * not profile entries the swap moves. The person re-enters on this machine
 * whatever was stored only on the other one.
 */
export interface RestoreCredentials {
  /** Always false. Kept as a field so a reader never has to infer it. */
  carried: false;
  /** What to enter or sign in to again here, unless this profile already had it. */
  reenter: readonly RestoreCredentialKind[];
  /** The sentence a restore surface shows. */
  message: string;
}

export type RestoreCredentialKind =
  | "session-secrets"
  | "mcp-credentials"
  | "web-search-keys"
  | "model-sign-ins";

export const RESTORE_CREDENTIALS: RestoreCredentials = Object.freeze({
  carried: false,
  reenter: Object.freeze([
    "session-secrets",
    "mcp-credentials",
    "web-search-keys",
    "model-sign-ins",
  ] as const),
  message:
    "Backups never carry credentials. Anything stored only on the machine that made this " +
    "backup needs entering again here: saved Session secrets, MCP server values and " +
    "sign-ins, web search keys, and model provider sign-ins. Credentials this profile " +
    "already had are unchanged.",
});

export interface RestoreReport {
  /** Where the profile that was there before now sits, untouched. */
  replacedPath: string;
  bundleSchemaVersion: number;
  /** The schema the restored profile ended on, after migrations ran. */
  schemaVersion: number;
  rowCounts: Record<string, number>;
  usage: { rows: number; meteredFrom: number };
  artifactsVerified: number;
  projectPaths: Record<string, string>;
  /** No credential travelled; what to re-enter. See {@link RestoreCredentials}. */
  credentials: RestoreCredentials;
}

export type RestoreResult =
  | { ok: true; report: RestoreReport }
  | { ok: false; problems: BackupProblem[] };

function problem(kind: BackupProblem["kind"], message: string): BackupProblem {
  return { kind, message };
}

/** Problems a file restore reports per refusal before summarizing the rest. */
const MAX_MAPPING_PROBLEMS = 100;

/**
 * Every project has a directory on this machine, each is its own, and none of
 * them came from the bundle.
 */
function checkProjectMapping(
  document: BackupDataDocument,
  projectPaths: Record<string, string>,
): BackupProblem[] {
  const projects = document.tables.projects;
  const idIndex = projects?.columns.indexOf("id") ?? -1;
  if (projects === undefined || idIndex === -1) {
    return [problem("shape", "Bundle data has no projects table to map.")];
  }
  const ids = projects.rows.map((row) => String(row[idIndex]));
  const carried = new Set(ids);
  return projectMappingProblems(
    () => ids,
    (id) => carried.has(id),
    projectPaths,
  );
}

/**
 * The mapping rules over any source of project ids: the parsed document's
 * rows, or the verifier's disk-backed list for a bundle file. `limit` bounds
 * the report for a file restore, whose bundle could carry any number of
 * projects; the in-memory restore reports every problem, as it always has.
 */
function projectMappingProblems(
  ids: () => Iterable<string>,
  carries: (id: string) => boolean,
  projectPaths: Record<string, string>,
  limit = Number.POSITIVE_INFINITY,
): BackupProblem[] {
  const problems: BackupProblem[] = [];
  let truncated = false;
  const report = (entry: BackupProblem): void => {
    if (problems.length >= limit) truncated = true;
    else problems.push(entry);
  };
  // Own keys only: a project id like `constructor` is not mapped by Object's prototype.
  const mapped = (id: string): string | undefined =>
    Object.hasOwn(projectPaths, id) ? projectPaths[id] : undefined;
  for (const id of ids()) {
    const path = mapped(id);
    if (path === undefined || path.trim() === "") {
      report(
        problem("mapping", `Project ${id} needs a local directory before it can be restored.`),
      );
      continue;
    }
    if (!isAbsolute(path)) {
      report(problem("mapping", `Project ${id} was given a relative directory: ${path}.`));
      continue;
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      report(problem("mapping", `Project ${id} was mapped to ${path}, which is not a directory.`));
    }
  }
  for (const id of Object.keys(projectPaths)) {
    if (!carries(id)) {
      report(problem("mapping", `Mapping names project ${id}, which the bundle does not carry.`));
    }
  }
  const used = new Map<string, string>();
  for (const id of ids()) {
    const path = mapped(id);
    if (path === undefined) continue;
    const owner = used.get(path);
    if (owner !== undefined) {
      report(
        problem(
          "mapping",
          `Projects ${owner} and ${id} were mapped to the same directory: ${path}.`,
        ),
      );
    }
    used.set(path, id);
  }
  if (truncated) {
    problems.push(
      problem(
        "mapping",
        `The project mapping has more problems than this report lists; the first ${limit} are shown.`,
      ),
    );
  }
  return problems;
}

/**
 * Writes the data document into a freshly migrated database.
 *
 * Foreign keys are off for the insert and checked in full at the end, which is
 * the only honest way to load a whole graph: any single insert order would
 * still have to defend itself against a cycle the schema is free to add later,
 * and `foreign_key_check` proves the finished state rather than the sequence.
 */
function writeRows(
  db: Database.Database,
  document: BackupDataDocument,
  projectPaths: Record<string, string>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of BACKUP_INCLUDED_TABLES) {
    const data = document.tables[table];
    if (data === undefined) continue;
    // The `ticket_events` and `session_events` insert triggers write these two
    // tables themselves; the bundle carries the real sequence numbers, so the
    // triggers' guesses go first.
    if (table === "ticket_event_sequence") db.exec("DELETE FROM ticket_event_sequence");
    if (table === "session_event_sequence") db.exec("DELETE FROM session_event_sequence");
    // A hand-built or foreign bundle's schema marker is never written back:
    // the migrations this restore runs own the restored file's floor.
    const rows = data.rows.filter((row) => !isSchemaMarkerRow(table, data.columns, row));
    counts[table] = rows.length;
    if (rows.length === 0) continue;
    const pathIndex = table === "projects" ? data.columns.indexOf("path") : -1;
    const idIndex = table === "projects" ? data.columns.indexOf("id") : -1;
    const statement = db.prepare(
      `INSERT INTO "${table}" (${data.columns.map((column) => `"${column}"`).join(", ")})
       VALUES (${data.columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) {
      const values = row.map((value, index) => {
        if (index === pathIndex) {
          const id = String(decodeValue(row[idIndex] ?? null));
          return projectPaths[id] ?? "";
        }
        return decodeValue(value);
      });
      statement.run(...(values as never[]));
    }
  }
  return counts;
}

/**
 * Rebuilds `session_usage` from the restored events, and re-establishes the
 * coverage row from the boundary the bundle carried.
 *
 * The rebuild is the ledger's own, not a second implementation of it: two ways
 * to derive the same money is how the two get to disagree. Going through the
 * ledger's transaction rather than a private helper is also what makes this
 * the SAME rebuild the app performs, which is the claim the decision register
 * makes when it calls `session_usage` rebuildable.
 *
 * The coverage row is written beside it rather than derived, and that is the
 * asymmetry worth reading twice: `session_usage` is exactly recomputable from
 * the events, while the metering boundary is a fact ABOUT that history which
 * no amount of it can reproduce. A restore that let migration 027's rule run
 * against a fresh database would write `0` — "every window is complete" — over
 * a profile that knew otherwise.
 */
async function rebuildUsageProjections(db: Database.Database, meteredFrom: number): Promise<void> {
  const ledger = new SqliteSessionLedger(db);
  await ledger.transaction((transaction) => {
    transaction.rebuildUsageProjection();
  });
  db.prepare("UPDATE session_usage_coverage SET metered_from = ? WHERE id = 1").run(meteredFrom);
}

/** The checks that run against the staged profile, after it is fully written. */
async function verifyStagedProfile(
  db: Database.Database,
  staging: string,
  manifestEntries: Iterable<BackupManifestEntry>,
  counts: Record<string, number>,
  streamArtifacts: boolean,
): Promise<BackupProblem[]> {
  const problems: BackupProblem[] = [];
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    problems.push(
      problem(
        "verify",
        `The restored database has ${violations.length} broken reference(s): ${JSON.stringify(violations.slice(0, 3))}.`,
      ),
    );
  }
  // Counted after the upgrade migrations, on purpose. A migration that
  // BACKFILLS rows into a table the bundle also carries would trip this, and
  // that is the intended outcome rather than a false alarm: two writers filling
  // one table during a restore is a question someone has to answer here.
  for (const [table, expected] of Object.entries(counts)) {
    // The schema marker is the migrations' own row, not the bundle's.
    const actual = (
      table === "app_state"
        ? db
            .prepare(`SELECT COUNT(*) AS n FROM app_state WHERE key IS NOT ?`)
            .get(MIN_READER_VERSION_KEY)
        : db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()
    ) as { n: number };
    if (actual.n !== expected) {
      problems.push(
        problem("verify", `${table} restored ${actual.n} rows; the bundle carried ${expected}.`),
      );
    }
  }
  // The rebuilt projection must account for exactly the events it derives from.
  const usageEvents = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM session_events WHERE json_extract(payload, '$.kind') = 'usage.recorded'",
      )
      .get() as { n: number }
  ).n;
  const usageRows = (db.prepare("SELECT COUNT(*) AS n FROM session_usage").get() as { n: number })
    .n;
  if (usageRows !== usageEvents) {
    problems.push(
      problem(
        "verify",
        `The rebuilt usage index holds ${usageRows} rows for ${usageEvents} usage events.`,
      ),
    );
  }
  // Every artifact on disk, re-hashed where it now lives. Transcript hashes
  // describe canonical bytes, not their compressed storage representation.
  // A file restore streams each one, so no single attachment is held whole;
  // the in-memory restore reads each one whole, as it always has.
  const transcripts = createFileTranscriptArtifactStore(sessionTranscriptsRoot(staging));
  for (const entry of manifestEntries) {
    if (entry.kind === "data") continue;
    let measured: { size: number; sha256: string } | null;
    if (entry.kind === "transcript") {
      try {
        const reference = transcriptReferenceForId(`sha256:${entry.sha256}`);
        measured = streamArtifacts
          ? await measureChunks(transcripts.readCanonicalChunks(reference))
          : measureBytes(await transcripts.readCanonicalBytes(reference));
      } catch (error) {
        if (isMissing(error)) {
          problems.push(
            problem("artifact-missing", `${entry.path} was not written into the profile.`),
          );
          continue;
        }
        // The store refuses bytes that are not this digest's: unreadable here.
        measured = null;
      }
    } else {
      const path = stagedBlobArtifactPath(staging, entry.path);
      if (path === null) {
        problems.push(
          problem("verify", `Restored bundle entry ${entry.path} has no place on disk.`),
        );
        continue;
      }
      if (!existsSync(path)) {
        problems.push(
          problem("artifact-missing", `${entry.path} was not written into the profile.`),
        );
        continue;
      }
      measured = streamArtifacts
        ? await measureChunks(createReadStream(path)).catch(() => null)
        : measureBytes(readFileSyncSafe(path));
    }
    if (measured === null || measured.size !== entry.sizeBytes) {
      problems.push(problem("artifact-corrupt", `${entry.path} has the wrong size after restore.`));
      continue;
    }
    if (measured.sha256 !== entry.sha256) {
      problems.push(problem("artifact-corrupt", `${entry.path} failed its SHA-256 after restore.`));
    }
  }
  return problems;
}

function measureBytes(bytes: Buffer | null): { size: number; sha256: string } | null {
  if (bytes === null) return null;
  return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function readFileSyncSafe(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Size and SHA-256 of a byte stream, consumed to its end. */
async function measureChunks(
  chunks: AsyncIterable<Uint8Array | string>,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of chunks) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    hash.update(bytes);
    size += bytes.length;
  }
  return { size, sha256: hash.digest("hex") };
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Where a blob entry lands inside a staged profile. */
function stagedBlobArtifactPath(staging: string, entryPath: string): string | null {
  if (!entryPath.startsWith(BLOB_PREFIX)) return null;
  const hash = entryPath.slice(BLOB_PREFIX.length);
  return join(blobsRoot(staging), hash.slice(0, 2), hash);
}

function transcriptIdFromArchivePath(path: string): string {
  const hex = path.slice(TRANSCRIPT_PREFIX.length, -".json".length);
  return `sha256:${hex}`;
}

async function writeArtifacts(staging: string, bundle: ReadBackupBundle): Promise<void> {
  const blobs = blobsRoot(staging);
  const transcripts = createFileTranscriptArtifactStore(sessionTranscriptsRoot(staging));
  mkdirSync(blobs, { recursive: true });
  for (const [path, bytes] of bundle.artifacts) {
    if (path.startsWith(BLOB_PREFIX)) {
      // The store hashes what it is handed, so a byte string that does not
      // land at its declared name cannot be written under it by mistake.
      writeBlob(blobs, bytes);
      continue;
    }
    await transcripts.writeCanonicalBytes(
      transcriptReferenceForId(transcriptIdFromArchivePath(path)),
      bytes,
    );
  }
}

/**
 * The profile entries a restore replaces beside the database itself. Every
 * other entry in the root, credentials included, is left alone.
 */
const PROFILE_COMPANIONS = ["blobs", "session-transcripts"] as const;

/** The live database inside a profile root (or a staged one). */
function profileDatabasePath(root: string): string {
  return join(root, "volli.db");
}

/**
 * The swap, and the only moment the live profile changes.
 *
 * It belongs to the fenced database-file module (VC-628), not to this one:
 * the open lock, a durable intent marker that keeps boot from creating an
 * empty profile mid-swap, SQLite's exclusive ownership of the live file (so a
 * running app is refused rather than detached from the file it is writing),
 * fsync, and an atomic rename onto the live path, which is never empty. A
 * failure partway puts the previous profile back, entry by entry, and clears
 * the marker; only a failure to put it back leaves boot refusing, with the
 * original files kept in the set-aside directory.
 */
function activateProfile(
  profileRoot: string,
  staging: string,
  replacedPath: string,
  faults: DatabaseFileFaults | undefined,
): void {
  swapInStagedProfile({
    dbPath: profileDatabasePath(profileRoot),
    stagedPath: profileDatabasePath(staging),
    asideDirectory: replacedPath,
    replacing: "healthy",
    companions: PROFILE_COMPANIONS,
    faults,
  });
}

/** The refusal for a bundle whose database is newer than this build, or null. */
function newerSchemaProblem(schemaVersion: number): BackupProblem | null {
  const head = headSchemaVersion();
  if (schemaVersion <= head) return null;
  return problem(
    "unsupported-version",
    `This backup holds a database from a newer version of Volli (schema ${schemaVersion}); this build knows schema ${head}. Update Volli and try again.`,
  );
}

/**
 * What one restore stages, whichever reader produced it. The in-memory and
 * file restores differ only in how rows and artifacts reach the staged
 * profile; migrations, the usage rebuild, every staged check and the fenced
 * swap are this one sequence.
 */
interface StagePlan {
  schemaVersion: number;
  meteredFrom: number;
  artifactsVerified: number;
  /** Writes the bundle's rows into the staged database; returns rows per table. */
  writeRows(db: Database.Database): Promise<Record<string, number>>;
  /** Writes artifacts not already written with the rows. */
  writeArtifacts(staging: string): Promise<void>;
  manifestEntries(): Iterable<BackupManifestEntry>;
  /**
   * A file restore: staged artifacts are re-hashed as streams rather than
   * whole, and SQLite's temporary structures (a migration's VACUUM copy, large
   * sorts) go to disk rather than RAM. The in-memory restore keeps both as
   * they always were.
   */
  bounded: boolean;
  /** Releases the reader's resources before the swap. Must not throw. */
  release(): void;
}

/**
 * Stages a whole profile in `staging`, verifies it, and only then activates.
 * `staging` exists and holds nothing the swap moves; it is removed on every
 * path except a rollback failure, where it is evidence.
 */
async function stageAndActivate(
  request: Pick<RestoreRequest, "profileRoot" | "projectPaths" | "now" | "faults">,
  staging: string,
  plan: StagePlan,
): Promise<RestoreResult> {
  let db: Database.Database | null = null;
  try {
    const dbPath = profileDatabasePath(staging);
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = OFF");
    // As at startup: the second walk below takes a safety copy and compacts,
    // and the migration free-space budget assumes VACUUM builds its compacted
    // copy in memory, not as a third copy on this disk (`disk-preflight.ts`).
    // A file restore is the exception: its staged database can be gigabytes,
    // so that copy (and any large sort) goes to SQLite's temporary directory
    // (`SQLITE_TMPDIR`, else `TMPDIR`, else `/var/tmp`) instead of RAM. The
    // free-space preflight does not count it; a compaction that runs out of
    // room is reported and skipped by the migration, never a failed restore.
    db.pragma(plan.bounded ? "temp_store = FILE" : "temp_store = MEMORY");
    // To the bundle's schema first: its rows are shaped for the columns that
    // existed when it was written.
    migrate(db, dbPath, { toVersion: plan.schemaVersion });
    const counts = await plan.writeRows(db);
    // Then the upgrade a person restoring into a newer build is really asking
    // for — the same walk a launch would have performed.
    migrate(db, dbPath);
    await rebuildUsageProjections(db, plan.meteredFrom);
    await plan.writeArtifacts(staging);

    const problems = await verifyStagedProfile(
      db,
      staging,
      plan.manifestEntries(),
      counts,
      plan.bounded,
    );
    if (problems.length > 0) {
      db.close();
      db = null;
      plan.release();
      rmSync(staging, { recursive: true, force: true });
      return { ok: false, problems };
    }

    const usage = {
      rows: (db.prepare("SELECT COUNT(*) AS n FROM session_usage").get() as { n: number }).n,
      meteredFrom: (
        db.prepare("SELECT metered_from FROM session_usage_coverage WHERE id = 1").get() as {
          metered_from: number;
        }
      ).metered_from,
    };
    const schemaVersion = db.pragma("user_version", { simple: true }) as number;
    // Checkpoint and close before the swap: a WAL sidecar left behind would
    // arrive in the activated profile as a half-written tail.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    plan.release();

    const replacedPath = join(request.profileRoot, `.volli-replaced-${request.now}`);
    try {
      activateProfile(request.profileRoot, staging, replacedPath, request.faults);
    } catch (error) {
      if (error instanceof DatabaseSwapFinalizeError) {
        rmSync(staging, { recursive: true, force: true });
        return {
          ok: false,
          problems: [
            problem(
              "verify",
              `The restored profile is installed and checked, but the restore could not be finalized, so Volli will not open it yet. The previous profile is preserved at ${replacedPath}.`,
            ),
          ],
        };
      }
      if (error instanceof DatabaseSwapRollbackError) {
        // Staging may hold half of either profile now: keep it as evidence.
        return {
          ok: false,
          problems: [
            problem(
              "verify",
              `The restore failed and the previous profile could not be put back. Its files are preserved at ${replacedPath}; the restored files at ${staging}.`,
            ),
          ],
        };
      }
      throw error;
    }
    rmSync(staging, { recursive: true, force: true });

    return {
      ok: true,
      report: {
        replacedPath,
        bundleSchemaVersion: plan.schemaVersion,
        schemaVersion,
        rowCounts: counts,
        usage,
        artifactsVerified: plan.artifactsVerified,
        projectPaths: { ...request.projectPaths },
        credentials: RESTORE_CREDENTIALS,
      },
    };
  } catch (error) {
    db?.close();
    plan.release();
    rmSync(staging, { recursive: true, force: true });
    // Truthful either way: everything before the swap writes only into the
    // staging directory removed above, and the swap itself puts the previous
    // profile back before it rethrows.
    return { ok: false, problems: [notRestoredProblem(error)] };
  }
}

function notRestoredProblem(error: unknown): BackupProblem {
  return problem(
    "verify",
    `The restore did not happen and the current profile is unchanged: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

/** The staging directory one restore attempt owns, emptied of any earlier attempt's. */
function freshStaging(profileRoot: string, now: number): string {
  const staging = join(profileRoot, `.volli-restore-${now}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  return staging;
}

/**
 * Reads, checks, stages, verifies, and only then activates.
 *
 * Returns a report or a list of problems; it never throws for a bundle a
 * person could plausibly hand it, because every one of those cases is
 * something to show them rather than a crash.
 *
 * Holds the whole bundle in memory, so it is for small bundles (fixtures,
 * tests, older callers). A profile-sized backup goes through
 * {@link restoreBackupBundleFile}.
 */
export async function restoreBackupBundle(request: RestoreRequest): Promise<RestoreResult> {
  const read = readBackupBundle(request.bundle);
  if (!read.ok) return { ok: false, problems: read.problems };
  const bundle = read.bundle;

  const newer = newerSchemaProblem(bundle.document.schemaVersion);
  if (newer !== null) return { ok: false, problems: [newer] };

  const mappingProblems = checkProjectMapping(bundle.document, request.projectPaths);
  if (mappingProblems.length > 0) return { ok: false, problems: mappingProblems };

  const staging = freshStaging(request.profileRoot, request.now);
  return stageAndActivate(request, staging, {
    schemaVersion: bundle.document.schemaVersion,
    meteredFrom: bundle.document.usageCoverage.meteredFrom,
    artifactsVerified: countArtifacts(bundle.manifest),
    writeRows: async (db) =>
      db.transaction(() => writeRows(db, bundle.document, request.projectPaths))(),
    writeArtifacts: (target) => writeArtifacts(target, bundle),
    manifestEntries: () => bundle.manifest.entries,
    bounded: false,
    release: () => {},
  });
}

export interface RestoreFileRequest extends Omit<RestoreRequest, "bundle"> {
  /** The bundle file. Read twice — verified, then staged — never into memory. */
  bundlePath: string;
  /**
   * Awaited at bounded row, byte and entry intervals during both reads, as the
   * automatic backup's verifier awaits it: it may pause (memory pressure) and
   * may reject to cancel. A rejection before activation leaves the profile
   * unchanged.
   */
  checkpoint?: () => Promise<void>;
}

/**
 * {@link restoreBackupBundle} for a bundle FILE of any size, with bounded
 * memory (VC-988).
 *
 * The same refusals, the same staged profile, the same checks and the same
 * fenced swap; only the reading differs. The bundle is verified by the
 * bounded v1 verifier the automatic backup uses (`openVerifiedBackupBundleFile`),
 * then read a second time to stage it, every entry pinned to the size and
 * SHA-256 the verifier recorded (`restore-stream.ts`). Neither read holds the
 * data document, so a profile whose `data.json` exceeds V8's string limit
 * restores like a fixture.
 *
 * Scratch space lives inside the staging directory under `profileRoot`:
 * the verifier's inventory (bounded by the bundle's entry, link and project
 * counts) and the staged profile itself. Like the in-memory restore, every
 * refusal and failure before activation removes it.
 */
export async function restoreBackupBundleFile(request: RestoreFileRequest): Promise<RestoreResult> {
  let staging: string;
  try {
    staging = freshStaging(request.profileRoot, request.now);
  } catch (error) {
    return { ok: false, problems: [notRestoredProblem(error)] };
  }
  let held: VerifiedBundleInventory;
  try {
    const opened = await openVerifiedBackupBundleFile(
      request.bundlePath,
      join(staging, "verify"),
      request.checkpoint,
    );
    if (!opened.ok) {
      rmSync(staging, { recursive: true, force: true });
      return { ok: false, problems: opened.problems };
    }
    held = opened.inventory;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, problems: [notRestoredProblem(error)] };
  }
  let refusal: BackupProblem[];
  try {
    refusal = fileRestoreRefusal(held, request.projectPaths);
  } catch (error) {
    refusal = [notRestoredProblem(error)];
  }
  if (refusal.length > 0) {
    closeQuietly(held);
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, problems: refusal };
  }

  return stageAndActivate(request, staging, {
    schemaVersion: held.bundle.document.schemaVersion,
    meteredFrom: held.bundle.document.usageCoverage.meteredFrom,
    artifactsVerified: held.bundle.manifest.entries.blob + held.bundle.manifest.entries.transcript,
    writeRows: async (db) => {
      const staged = await stageBundleFile({
        filePath: request.bundlePath,
        db,
        staging,
        inventory: held,
        projectPaths: request.projectPaths,
        checkpoint: request.checkpoint,
      });
      return staged.counts;
    },
    // Streamed into place during the same read as the rows.
    writeArtifacts: async () => {},
    manifestEntries: () => held.manifestEntries(),
    bounded: true,
    release: () => closeQuietly(held),
  });
}

/**
 * Closes the verifier's scratch inventory. Its directory sits inside staging,
 * which every path removes (or keeps as evidence) anyway, so a failure here
 * must not turn a report into a thrown error.
 */
function closeQuietly(inventory: VerifiedBundleInventory): void {
  try {
    inventory.close();
  } catch {
    // Removed with the staging directory.
  }
}

/**
 * The refusals a file restore makes after verification and before staging,
 * in the in-memory restore's order: a newer schema, then the mapping.
 */
function fileRestoreRefusal(
  inventory: VerifiedBundleInventory,
  projectPaths: Record<string, string>,
): BackupProblem[] {
  const newer = newerSchemaProblem(inventory.bundle.document.schemaVersion);
  if (newer !== null) return [newer];
  if (!inventory.projectsMappable) {
    return [problem("shape", "Bundle data has no projects table to map.")];
  }
  const mapping = projectMappingProblems(
    () => inventory.projectIds(),
    (id) => inventory.carriesProject(id),
    projectPaths,
    MAX_MAPPING_PROBLEMS,
  );
  if (mapping.length > 0) return mapping;
  // The one ordering the in-memory restore does not need: it loads tables in
  // its own order, while a stream loads them in the document's. Both Volli
  // writers put each event table before the sequence table its trigger fills.
  const order = Object.keys(inventory.bundle.document.tables);
  for (const [sequenceTable, eventTable] of Object.entries(TRIGGER_FILLED_TABLES)) {
    const sequenceAt = order.indexOf(sequenceTable);
    const eventsAt = order.indexOf(eventTable);
    if (sequenceAt !== -1 && eventsAt > sequenceAt) {
      return [
        problem(
          "shape",
          `Bundle data lists ${sequenceTable} before ${eventTable}; a file restore needs ${eventTable} first, as Volli writes it.`,
        ),
      ];
    }
  }
  return [];
}

function countArtifacts(manifest: BackupManifest): number {
  return manifest.entries.filter((entry) => entry.kind !== "data").length;
}
