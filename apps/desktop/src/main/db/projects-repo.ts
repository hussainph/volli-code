/**
 * `projects` table repo: row↔domain mapping (snake_case → camelCase) plus
 * the plain SQL `projects.create/remove/reorder` need. No event log here —
 * only tickets get one (`ticket_events`, migration 001).
 */
import type Database from "better-sqlite3";
import type { Project } from "@volli/shared";

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  ticket_prefix: string;
  color_index: number;
  sort_order: number;
  row_version: number;
  created_at: number;
  updated_at: number;
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    ticketPrefix: row.ticket_prefix,
    colorIndex: row.color_index,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every project, ordered by rail position. */
export function listProjects(db: Database.Database): Project[] {
  const rows = db.prepare<[], ProjectRow>("SELECT * FROM projects ORDER BY sort_order").all();
  return rows.map(mapProject);
}

export function countProjects(db: Database.Database): number {
  const row = db.prepare<[], { count: number }>("SELECT COUNT(*) as count FROM projects").get();
  return row?.count ?? 0;
}

export function findProjectByPath(db: Database.Database, path: string): Project | undefined {
  const row = db.prepare<[string], ProjectRow>("SELECT * FROM projects WHERE path = ?").get(path);
  return row ? mapProject(row) : undefined;
}

/** The `sortOrder` one past the current max (`-1` when the table is empty, so this returns `0`). */
export function nextSortOrder(db: Database.Database): number {
  const row = db
    .prepare<[], { max: number | null }>("SELECT MAX(sort_order) as max FROM projects")
    .get();
  return (row?.max ?? -1) + 1;
}

/** Inserts a brand-new project row (`row_version` starts at `1`). */
export function insertProject(db: Database.Database, project: Project): void {
  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
     VALUES (@id, @name, @path, @ticketPrefix, @colorIndex, @sortOrder, 1, @createdAt, @updatedAt)`,
  ).run({
    id: project.id,
    name: project.name,
    path: project.path,
    ticketPrefix: project.ticketPrefix,
    colorIndex: project.colorIndex,
    sortOrder: project.sortOrder,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
}

/** Deletes a project; `ON DELETE CASCADE` takes its tickets/labels/ticket_events with it. */
export function deleteProject(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

/** Rewrites `sort_order` to `0..n-1` following `orderedIds`; unknown ids are silently no-ops. */
export function reorderProjects(
  db: Database.Database,
  orderedIds: readonly string[],
  now: number,
): void {
  const stmt = db.prepare(
    "UPDATE projects SET sort_order = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?",
  );
  orderedIds.forEach((id, index) => {
    stmt.run(index, now, id);
  });
}
