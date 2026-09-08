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
 * What this module does not do is decide when to run, ask the questions, or
 * relaunch the app. It takes bytes and a mapping and returns a report, which
 * keeps it testable against fixture profiles and leaves the surface — and the
 * streaming/progress/cancellation work — to VC-317 and the restore UI.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import Database from "better-sqlite3";

import { blobsRoot, writeBlob } from "../blob-store";
import { MIGRATIONS, migrate } from "../db/migrations";
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
  type ReadBackupBundle,
} from "./bundle";
import { decodeValue } from "./data-document";
import type { BackupDataDocument, BackupProblem } from "./data-document";
import { BACKUP_INCLUDED_TABLES } from "./decisions";

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
}

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
}

export type RestoreResult =
  | { ok: true; report: RestoreReport }
  | { ok: false; problems: BackupProblem[] };

function problem(kind: BackupProblem["kind"], message: string): BackupProblem {
  return { kind, message };
}

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
  const problems: BackupProblem[] = [];
  for (const id of ids) {
    const path = projectPaths[id];
    if (path === undefined || path.trim() === "") {
      problems.push(
        problem("mapping", `Project ${id} needs a local directory before it can be restored.`),
      );
      continue;
    }
    if (!isAbsolute(path)) {
      problems.push(problem("mapping", `Project ${id} was given a relative directory: ${path}.`));
      continue;
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      problems.push(
        problem("mapping", `Project ${id} was mapped to ${path}, which is not a directory.`),
      );
    }
  }
  for (const id of Object.keys(projectPaths)) {
    if (!ids.includes(id)) {
      problems.push(
        problem("mapping", `Mapping names project ${id}, which the bundle does not carry.`),
      );
    }
  }
  const used = new Map<string, string>();
  for (const id of ids) {
    const path = projectPaths[id];
    if (path === undefined) continue;
    const owner = used.get(path);
    if (owner !== undefined) {
      problems.push(
        problem(
          "mapping",
          `Projects ${owner} and ${id} were mapped to the same directory: ${path}.`,
        ),
      );
    }
    used.set(path, id);
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
    // The `ticket_events` insert trigger writes this table itself; the bundle
    // carries the real sequence numbers, so the trigger's guesses go first.
    if (table === "ticket_event_sequence") db.exec("DELETE FROM ticket_event_sequence");
    counts[table] = data.rows.length;
    if (data.rows.length === 0) continue;
    const pathIndex = table === "projects" ? data.columns.indexOf("path") : -1;
    const idIndex = table === "projects" ? data.columns.indexOf("id") : -1;
    const statement = db.prepare(
      `INSERT INTO "${table}" (${data.columns.map((column) => `"${column}"`).join(", ")})
       VALUES (${data.columns.map(() => "?").join(", ")})`,
    );
    for (const row of data.rows) {
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
  bundle: ReadBackupBundle,
  counts: Record<string, number>,
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
    const actual = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
    if (actual !== expected) {
      problems.push(
        problem("verify", `${table} restored ${actual} rows; the bundle carried ${expected}.`),
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
  const transcripts = createFileTranscriptArtifactStore(sessionTranscriptsRoot(staging));
  for (const entry of bundle.manifest.entries) {
    if (entry.kind === "data") continue;
    let bytes: Buffer | null;
    if (entry.kind === "transcript") {
      try {
        bytes = await transcripts.readCanonicalBytes(
          transcriptReferenceForId(`sha256:${entry.sha256}`),
        );
      } catch {
        bytes = null;
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
      bytes = readFileSyncSafe(path);
    }
    if (bytes === null || bytes.length !== entry.sizeBytes) {
      problems.push(problem("artifact-corrupt", `${entry.path} has the wrong size after restore.`));
      continue;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      problems.push(problem("artifact-corrupt", `${entry.path} failed its SHA-256 after restore.`));
    }
  }
  return problems;
}

function readFileSyncSafe(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
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

/** The profile files a restore replaces. Everything else in the root is left alone. */
const PROFILE_ENTRIES = [
  "volli.db",
  "volli.db-wal",
  "volli.db-shm",
  "blobs",
  "session-transcripts",
] as const;

/**
 * Moves each named entry from one directory to another, recording every name
 * it moved in `moved` BEFORE moving the next one.
 *
 * The accumulator is the whole point: a rename that fails on the third entry
 * has already moved two, and the caller's rollback has to know exactly which
 * two so it can put those back and only those. Returning the list would lose
 * it on the throw.
 */
function moveInto(from: string, to: string, names: readonly string[], moved: string[]): void {
  mkdirSync(to, { recursive: true });
  for (const name of names) {
    const source = join(from, name);
    if (!existsSync(source)) continue;
    renameSync(source, join(to, name));
    moved.push(name);
  }
}

/**
 * The swap, and the only moment the live profile changes.
 *
 * Two multi-entry moves with a window between and inside them, so the window
 * is what this function exists to handle. Either move can fail PARTWAY — the
 * database renamed aside, the blob directory refused — and each failure is
 * unwound to the entry: whatever the staged profile had already placed goes
 * back to staging, whatever the old profile had already set aside comes back,
 * and only then is the failure reported. That is the difference between "the
 * restore did not happen" and a profile directory missing its database.
 */
function activateProfile(profileRoot: string, staging: string, replacedPath: string): void {
  const setAside: string[] = [];
  try {
    moveInto(profileRoot, replacedPath, PROFILE_ENTRIES, setAside);
  } catch (error) {
    moveInto(replacedPath, profileRoot, setAside, []);
    rmSync(replacedPath, { recursive: true, force: true });
    throw error;
  }
  const activated: string[] = [];
  try {
    moveInto(staging, profileRoot, PROFILE_ENTRIES, activated);
  } catch (error) {
    // Staged entries first, so the old ones do not land on top of them.
    moveInto(profileRoot, staging, activated, []);
    moveInto(replacedPath, profileRoot, setAside, []);
    rmSync(replacedPath, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Reads, checks, stages, verifies, and only then activates.
 *
 * Returns a report or a list of problems; it never throws for a bundle a
 * person could plausibly hand it, because every one of those cases is
 * something to show them rather than a crash.
 */
export async function restoreBackupBundle(request: RestoreRequest): Promise<RestoreResult> {
  const read = readBackupBundle(request.bundle);
  if (!read.ok) return { ok: false, problems: read.problems };
  const bundle = read.bundle;

  const head = headSchemaVersion();
  if (bundle.document.schemaVersion > head) {
    return {
      ok: false,
      problems: [
        problem(
          "unsupported-version",
          `This backup holds a database from a newer version of Volli (schema ${bundle.document.schemaVersion}); this build knows schema ${head}. Update Volli and try again.`,
        ),
      ],
    };
  }

  const mappingProblems = checkProjectMapping(bundle.document, request.projectPaths);
  if (mappingProblems.length > 0) return { ok: false, problems: mappingProblems };

  const staging = join(request.profileRoot, `.volli-restore-${request.now}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  let db: Database.Database | null = null;
  try {
    const dbPath = join(staging, "volli.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = OFF");
    // To the bundle's schema first: its rows are shaped for the columns that
    // existed when it was written.
    migrate(db, dbPath, { toVersion: bundle.document.schemaVersion });
    const staged = db;
    const counts = db.transaction(() => writeRows(staged, bundle.document, request.projectPaths))();
    // Then the upgrade a person restoring into a newer build is really asking
    // for — the same walk a launch would have performed.
    migrate(db, dbPath);
    await rebuildUsageProjections(db, bundle.document.usageCoverage.meteredFrom);
    await writeArtifacts(staging, bundle);

    const problems = await verifyStagedProfile(db, staging, bundle, counts);
    if (problems.length > 0) {
      db.close();
      db = null;
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

    const replacedPath = join(request.profileRoot, `.volli-replaced-${request.now}`);
    activateProfile(request.profileRoot, staging, replacedPath);
    rmSync(staging, { recursive: true, force: true });

    return {
      ok: true,
      report: {
        replacedPath,
        bundleSchemaVersion: bundle.document.schemaVersion,
        schemaVersion,
        rowCounts: counts,
        usage,
        artifactsVerified: countArtifacts(bundle.manifest),
        projectPaths: { ...request.projectPaths },
      },
    };
  } catch (error) {
    db?.close();
    rmSync(staging, { recursive: true, force: true });
    // Truthful either way: everything before the swap writes only into the
    // staging directory removed above, and the swap itself puts the previous
    // profile back before it rethrows.
    return {
      ok: false,
      problems: [
        problem(
          "verify",
          `The restore did not happen and the current profile is unchanged: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      ],
    };
  }
}

function countArtifacts(manifest: BackupManifest): number {
  return manifest.entries.filter((entry) => entry.kind !== "data").length;
}
