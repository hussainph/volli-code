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
import { migrate } from "./migrations";

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
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  migrate(db, dbPath);
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
    harnessId: overrides.harnessId,
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
    title: overrides.title ?? `Session ${n}`,
    cwd: overrides.cwd ?? "/repo",
    now: overrides.createdAt ?? 0,
  });
}
