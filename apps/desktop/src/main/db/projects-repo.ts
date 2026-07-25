/**
 * `projects` table repo: row↔domain mapping (snake_case → camelCase) plus
 * the plain SQL `projects.create/remove/reorder` need. No event log here —
 * only tickets get one (`ticket_events`, migration 001).
 */
import type Database from "better-sqlite3";
import { isProjectThemeOverrideEmpty } from "@volli/shared";
import type { Project, ProjectThemeOverride } from "@volli/shared";
import { prepared } from "./prepared";

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  ticket_prefix: string;
  base_branch: string | null;
  setup_command: string | null;
  /** Migration 013 — one nullable column per surface, plus the auto-tint seed; NULL = inherit. */
  theme_app_slug: string | null;
  theme_terminal_name: string | null;
  theme_editor_id: string | null;
  theme_seed: string | null;
  color_index: number;
  sort_order: number;
  row_version: number;
  created_at: number;
  updated_at: number;
  /**
   * The next display number `nextTicketNumberForProject` (tickets-repo) will
   * hand out (migration 005) — a db-internal allocation detail, deliberately
   * NOT surfaced on the domain `Project` type; `mapProject` below doesn't
   * read it.
   */
  next_ticket_number: number;
}

/**
 * The row's four theme columns as a domain override — or `null` when every one
 * of them is NULL. Collapsing the all-inherit case to `null` keeps "does this
 * project override anything?" a single check for every reader, instead of an
 * object whose fields all have to be interrogated.
 */
function mapThemeOverride(row: ProjectRow): ProjectThemeOverride | null {
  const override: ProjectThemeOverride = {
    appThemeSlug: row.theme_app_slug,
    terminalThemeName: row.theme_terminal_name,
    editorThemeId: row.theme_editor_id,
    seed: row.theme_seed,
  };
  return isProjectThemeOverrideEmpty(override) ? null : override;
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    ticketPrefix: row.ticket_prefix,
    baseBranch: row.base_branch,
    setupCommand: row.setup_command,
    themeOverride: mapThemeOverride(row),
    colorIndex: row.color_index,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every project, ordered by rail position. */
export function listProjects(db: Database.Database): Project[] {
  const rows = prepared<[], ProjectRow>(db, "SELECT * FROM projects ORDER BY sort_order").all();
  return rows.map(mapProject);
}

export function countProjects(db: Database.Database): number {
  const row = prepared<[], { count: number }>(db, "SELECT COUNT(*) as count FROM projects").get();
  return row?.count ?? 0;
}

export function findProjectByPath(db: Database.Database, path: string): Project | undefined {
  const row = prepared<[string], ProjectRow>(db, "SELECT * FROM projects WHERE path = ?").get(path);
  return row ? mapProject(row) : undefined;
}

/** One project by id — used by the artifacts IPC handlers to resolve a ticket's project path. */
export function getProjectById(db: Database.Database, id: string): Project | undefined {
  const row = prepared<[string], ProjectRow>(db, "SELECT * FROM projects WHERE id = ?").get(id);
  return row ? mapProject(row) : undefined;
}

/** Updates the pinned automation base branch and returns the authoritative row. */
export function updateProjectBaseBranch(
  db: Database.Database,
  id: string,
  baseBranch: string | null,
  now: number,
): Project | undefined {
  prepared(
    db,
    `UPDATE projects
        SET base_branch = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ?`,
  ).run(baseBranch, now, id);
  return getProjectById(db, id);
}

/**
 * Updates the per-project worktree setup command and returns the authoritative
 * row — the `base_branch` precedent above, for the field migration 008 adds.
 * `null` clears it (the setup phase is then skipped for that project's
 * worktrees).
 */
export function updateProjectSetupCommand(
  db: Database.Database,
  id: string,
  setupCommand: string | null,
  now: number,
): Project | undefined {
  prepared(
    db,
    `UPDATE projects
        SET setup_command = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ?`,
  ).run(setupCommand, now, id);
  return getProjectById(db, id);
}

/**
 * Updates the project's per-surface theme override and returns the
 * authoritative row — the `base_branch`/`setup_command` precedent above, for
 * the columns migration 013 adds.
 *
 * `null` clears every surface back to inheriting the global theme; a partial
 * override clears only the surfaces whose fields are null, because resolution
 * is per surface and never per token (#69). All four columns are written on
 * every call, so the stored row always equals the override the caller asked
 * for — no read-modify-write, no stale surface left behind.
 */
export function updateProjectThemeOverride(
  db: Database.Database,
  id: string,
  override: ProjectThemeOverride | null,
  now: number,
): Project | undefined {
  prepared(
    db,
    `UPDATE projects
        SET theme_app_slug = ?, theme_terminal_name = ?, theme_editor_id = ?, theme_seed = ?,
            row_version = row_version + 1, updated_at = ?
      WHERE id = ?`,
  ).run(
    override?.appThemeSlug ?? null,
    override?.terminalThemeName ?? null,
    override?.editorThemeId ?? null,
    override?.seed ?? null,
    now,
    id,
  );
  return getProjectById(db, id);
}

/** The `sortOrder` one past the current max (`-1` when the table is empty, so this returns `0`). */
export function nextSortOrder(db: Database.Database): number {
  const row = prepared<[], { max: number | null }>(
    db,
    "SELECT MAX(sort_order) as max FROM projects",
  ).get();
  return (row?.max ?? -1) + 1;
}

/** Inserts a brand-new project row (`row_version` starts at `1`). */
export function insertProject(db: Database.Database, project: Project): void {
  prepared(
    db,
    `INSERT INTO projects (id, name, path, ticket_prefix, base_branch, setup_command, color_index, sort_order, row_version, created_at, updated_at)
     VALUES (@id, @name, @path, @ticketPrefix, @baseBranch, @setupCommand, @colorIndex, @sortOrder, 1, @createdAt, @updatedAt)`,
  ).run({
    id: project.id,
    name: project.name,
    path: project.path,
    ticketPrefix: project.ticketPrefix,
    baseBranch: project.baseBranch ?? null,
    setupCommand: project.setupCommand ?? null,
    colorIndex: project.colorIndex,
    sortOrder: project.sortOrder,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
}

/** Deletes a project; `ON DELETE CASCADE` takes its tickets/labels/ticket_events with it. */
export function deleteProject(db: Database.Database, id: string): void {
  prepared(db, "DELETE FROM projects WHERE id = ?").run(id);
}

/**
 * Rewrites `sort_order` to `0..n-1` following `orderedIds`; unknown ids are
 * silently no-ops. Wrapped in a transaction so the N row updates commit
 * atomically (one WAL commit, not N) — a mid-loop failure can never persist a
 * half-renumbered order the next boot would hydrate.
 */
export function reorderProjects(
  db: Database.Database,
  orderedIds: readonly string[],
  now: number,
): void {
  const run = db.transaction((ids: readonly string[]) => {
    const stmt = prepared(
      db,
      "UPDATE projects SET sort_order = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?",
    );
    ids.forEach((id, index) => {
      stmt.run(index, now, id);
    });
  });
  run(orderedIds);
}
