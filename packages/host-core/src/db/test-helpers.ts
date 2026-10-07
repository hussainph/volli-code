/**
 * Shared repo/integration-test scaffolding: a real, fully-migrated
 * better-sqlite3 db in a throwaway temp dir (never `:memory:` — the
 * migration backup step in `migrations.ts` copies the db FILE, and a couple
 * of tests exercise that directly), plus minimal fixture builders so repo
 * tests don't hand-roll `Project`/`Ticket` objects. Not itself a "*.test.ts"
 * file, so `vite.config.ts`'s main-project test include (every "*.test.ts"
 * under src/main) never treats it as a suite — it's imported BY the suites below.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createSessionRecord, createTicket } from "@volli/shared";
import type { Project, SessionRecord, Ticket } from "@volli/shared";
import { MIGRATIONS, migrate } from "./migrations";
import type { Migration } from "./migrations";
import { guardTransactionOwnership, throwTransactionViolation } from "./transaction-gate";

/**
 * Constructs a raw better-sqlite3 handle with no further setup. Test code uses
 * this (or {@link openTestDb}) instead of `new Database(...)` so every suite
 * opens its fixture the same way.
 *
 * WHY THIS IS NOW ONE LINE (VC-213). It used to pass an explicit
 * `nativeBinding`, because there was no single binary both runtimes could
 * load: the app runs better-sqlite3 inside Electron and these suites run it
 * under plain Node via `vp test`, and up to v12 the addon was a
 * NODE_MODULE_VERSION-keyed build. `rebuild:native` baked the Electron-ABI one
 * into `build/Release`, so a `scripts/cache-node-sqlite.mjs` postinstall step
 * fetched the Node-ABI one through better-sqlite3's own `prebuild-install`
 * dependency and parked it in `prebuilds/` — out of the blast radius of the
 * next electron-rebuild — for this helper to point at.
 *
 * better-sqlite3 13 moved the addon to the N-API, which is ABI-stable across
 * BOTH Node and Electron, and ships one prebuilt binary per platform inside
 * the package (`prebuilds/<platform>-<arch>.node`). There is no second ABI to
 * cache and nothing left to fetch, so the script is gone and the default
 * binding is correct in either runtime. `binding.gyp` makes an explicit
 * rebuild a no-op while that prebuild exists, which is why `rebuild:native`
 * leaves `build/Release` empty and nothing notices.
 */
export function openRawDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}

/**
 * Hand-applies the migrations `include` selects, in order, to a scratch
 * fixture: how a suite builds a database at an OLDER version for a migration
 * to then upgrade. Each runs exactly as it always has (its own `apply` if it
 * has one, its `sql` otherwise), one autocommit statement at a time, with the
 * handle's foreign-key setting untouched. What is different is that SQLite is
 * not asked to flush those commits to disk: `synchronous` is OFF while the
 * fixture is built and put back before this returns, so whatever the test
 * runs next (usually `migrate`, with its fsync'd rollback point) runs exactly
 * as it did before.
 *
 * WHY (VC-717). Every DDL statement of every hand-applied migration is its
 * own commit, and under the default `synchronous = FULL` each commit flushes
 * the journal and then the database. Building a v34 lineage this way issued
 * ~500 fsyncs, a v43 one ~800 (strace, on CI's ubuntu-24.04 runner) — and the
 * count grows with every migration added. On an idle runner a flush costs
 * ~0.3 ms and nobody notices; on one whose disk is throttled it costs
 * milliseconds, and `migrations.test.ts` timed out at 5 s in exactly the
 * tests that build the deepest fixtures, while its CPU-bound fresh-install
 * tests stayed at tens of milliseconds in the same run. A fixture's
 * durability against power loss is not what any of these tests is about.
 * `synchronous` decides when SQLite waits for the disk, not what it writes:
 * the v2 through v43 lineages built this way were checked byte-identical to
 * the flushing build's.
 */
export function applyMigrationsByHand(
  db: Database.Database,
  include: (migration: Migration) => boolean,
): void {
  const previous = db.pragma("synchronous", { simple: true }) as number;
  db.pragma("synchronous = OFF");
  try {
    for (const migration of MIGRATIONS.filter(include)) {
      if (migration.apply !== undefined) migration.apply(db);
      else db.exec(migration.sql);
    }
  } finally {
    db.pragma(`synchronous = ${previous}`);
  }
}

export interface TestDb {
  db: Database.Database;
  dbPath: string;
  /** Closes the handle and removes the temp dir — call from `afterEach`. */
  cleanup: () => void;
}

/** Opens a fresh temp-file db and runs every migration — the steady-state fixture most repo tests want. */
export function openTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "volli-db-test-"));
  const dbPath = join(dir, "volli.db");
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  migrate(db, dbPath);
  guardTransactionOwnership(db, throwTransactionViolation);
  return {
    db,
    dbPath,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let fixtureCounter = 0;

/** A minimal, deterministic `Project` fixture. */
export function testProject(overrides: Partial<Project> = {}): Project {
  const n = ++fixtureCounter;
  return {
    id: overrides.id ?? `proj-${n}`,
    name: overrides.name ?? `Project ${n}`,
    path: overrides.path ?? `/repo/project-${n}`,
    ticketPrefix: overrides.ticketPrefix ?? "VC",
    baseBranch: overrides.baseBranch ?? null,
    setupCommand: overrides.setupCommand ?? null,
    colorIndex: overrides.colorIndex ?? 0,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
  };
}

/** A minimal, deterministic `Ticket` fixture built through {@link createTicket}. */
export function testTicket(projectId: string, overrides: Partial<Ticket> = {}): Ticket {
  const n = ++fixtureCounter;
  return createTicket({
    id: overrides.id ?? `ticket-${n}`,
    projectId,
    ticketNumber: overrides.ticketNumber ?? n,
    title: overrides.title ?? `Ticket ${n}`,
    status: overrides.status ?? "backlog",
    order: overrides.order ?? 0,
    now: overrides.createdAt ?? 0,
    body: overrides.body,
    priority: overrides.priority,
    labels: overrides.labels,
    usesWorktree: overrides.usesWorktree,
    preferredHarnessId: overrides.preferredHarnessId,
    worktreePath: overrides.worktreePath,
    branch: overrides.branch,
    baseBranch: overrides.baseBranch,
  });
}

/** A minimal, deterministic `SessionRecord` fixture built through {@link createSessionRecord}. */
export function testSession(
  projectId: string,
  ticketId: string | null = null,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  const n = ++fixtureCounter;
  return createSessionRecord({
    id: overrides.id ?? `session-${n}`,
    projectId,
    ticketId,
    harnessId: overrides.harnessId ?? "claude-code",
    launchKind: overrides.launchKind ?? "unknown",
    placement: overrides.placement ?? "unknown",
    title: overrides.title ?? `Session ${n}`,
    cwd: overrides.cwd ?? "/repo",
    now: overrides.createdAt ?? 0,
  });
}
