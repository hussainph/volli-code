/**
 * `projects` table repo: row↔domain mapping (snake_case → camelCase) plus
 * the plain SQL `projects.create/remove/reorder` need. No event log here —
 * only tickets get one (`ticket_events`, migration 001).
 */
import type Database from "better-sqlite3";
import { isAppearance, isProjectThemeOverrideEmpty, parseCanvas } from "@volli/shared";
import type { Appearance, Canvas, Project, ProjectThemeOverride } from "@volli/shared";
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
  /** Migration 014 — the authored canvas as JSON, and the appearance; NULL = inherit. */
  theme_canvas: string | null;
  theme_appearance: string | null;
  /** Migration 020 — consent to the attach-time skills index; 0 unless the user flipped it. */
  skills_auto_disclosure: number;
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
 * Two of the row's four migration-013 theme columns as a domain override — or
 * `null` when both are NULL. Collapsing the all-inherit case to `null` keeps
 * "does this project override anything?" a single check for every reader,
 * instead of an object whose fields all have to be interrogated.
 *
 * HALF DYING, and it is worth being exact about which half. Migration 014's
 * `theme_canvas`/`theme_appearance` are what the APP surface means now (see
 * `mapCanvas` below), so `theme_app_slug` and `theme_seed` are read by nobody —
 * they went with the seed-based picker, and `@volli/shared`'s
 * `ProjectThemeOverride` no longer even carries fields for them. The other two
 * did not: the terminal and editor surfaces are separate systems (a ghostty
 * overlay file, a Monaco/shiki id) that still resolve global → project off
 * this row, and `renderer/src/stores/theme.ts` reads both out of
 * `volli:theme-state`'s `projectOverride`. The two dead COLUMNS stay because
 * `db/export.test.ts` requires every column on `projects` to have an exported
 * field, and SQLite `DROP COLUMN` is not safe on the versions we support —
 * `updateProjectThemeOverride` below still writes them (always `null`, since
 * nothing upstream can populate them anymore).
 */
function mapThemeOverride(row: ProjectRow): ProjectThemeOverride | null {
  const override: ProjectThemeOverride = {
    terminalThemeName: row.theme_terminal_name,
    editorThemeId: row.theme_editor_id,
  };
  return isProjectThemeOverrideEmpty(override) ? null : override;
}

/**
 * The row's canvas column as a domain canvas — or `null` for absent, malformed,
 * or "this is a payload from the system this one replaces".
 *
 * Degrading rather than throwing is the same stance the global canvas takes
 * (`theme-repo.ts`): a project's row is read at boot, in a loop over every
 * project, before there is any UI to surface a failure in. One hand-edited row
 * must not take the rail down with it — it inherits the global canvas, which is
 * both survivable and visible.
 */
function mapCanvas(row: ProjectRow): Canvas | null {
  if (row.theme_canvas === null || row.theme_canvas.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.theme_canvas);
  } catch {
    return null;
  }
  return parseCanvas(parsed);
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
    themeCanvas: mapCanvas(row),
    // The CHECK on the column already limits this to the three words, so a
    // value that fails the guard means a db edited around it — inherit.
    themeAppearance: isAppearance(row.theme_appearance) ? row.theme_appearance : null,
    skillsAutoDisclosure: row.skills_auto_disclosure === 1,
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
 * Updates the per-project skills auto-disclosure consent and returns the
 * authoritative row — the `base_branch`/`setup_command` precedent above, for
 * the column migration 020 adds. Session starts read this through
 * `getProjectById`, so the flip governs the NEXT start; an attached Session's
 * prompt is already durably recorded and stays what it was.
 */
export function updateProjectSkillsAutoDisclosure(
  db: Database.Database,
  id: string,
  enabled: boolean,
  now: number,
): Project | undefined {
  prepared(
    db,
    `UPDATE projects
        SET skills_auto_disclosure = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ?`,
  ).run(enabled ? 1 : 0, now, id);
  return getProjectById(db, id);
}

/**
 * Updates the project's per-surface theme override and returns the
 * authoritative row — the `base_branch`/`setup_command` precedent above, for
 * the columns migration 013 adds.
 *
 * `null` clears every surface back to inheriting the global theme; a partial
 * override clears only the surfaces whose fields are null, because resolution
 * is per surface and never per token (#69). All four columns are still
 * written on every call — `theme_app_slug`/`theme_seed` always to `null`,
 * since `ProjectThemeOverride` no longer carries fields for them (see
 * `mapThemeOverride` above) — so the stored row always equals the override
 * the caller asked for, plus the two dead columns quietly staying empty.
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
  ).run(null, override?.terminalThemeName ?? null, override?.editorThemeId ?? null, null, now, id);
  return getProjectById(db, id);
}

/**
 * Sets this project's canvas override (migration 014) and returns the
 * authoritative row; `null` clears it back to inheriting the global canvas.
 *
 * The canvas is rebuilt field by field on the way in by `parseCanvas`, exactly
 * as the global one is — storing the caller's object by reference is how a
 * resolved token set would end up in a column.
 */
export function updateProjectCanvas(
  db: Database.Database,
  id: string,
  canvas: Canvas | null,
  now: number,
): Project | undefined {
  let payload: string | null = null;
  if (canvas !== null) {
    const stored = parseCanvas(canvas);
    // Throws rather than storing something else, exactly as `setGlobalCanvas`
    // does: the IPC envelope turns it into a typed error the renderer surfaces,
    // and a write that quietly stored a different canvas is the one outcome
    // nobody can debug.
    if (stored === null) throw new Error("Refusing to store a canvas that cannot be painted");
    payload = JSON.stringify(stored);
  }
  prepared(
    db,
    `UPDATE projects
        SET theme_canvas = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ?`,
  ).run(payload, now, id);
  return getProjectById(db, id);
}

/**
 * Sets this project's appearance override (migration 014) and returns the
 * authoritative row; `null` clears it back to inheriting the global choice.
 * Written independently of the canvas — the two are separately scoped, so a
 * single "set the project's theme" write would make overriding one of them
 * silently clear the other.
 */
export function updateProjectAppearance(
  db: Database.Database,
  id: string,
  appearance: Appearance | null,
  now: number,
): Project | undefined {
  prepared(
    db,
    `UPDATE projects
        SET theme_appearance = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ?`,
  ).run(appearance, now, id);
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
