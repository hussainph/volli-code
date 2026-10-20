import type Database from "better-sqlite3";

/**
 * VC-822: expand-only. `projects.removed_at` — when the person removed the
 * project from Volli, or NULL while it is on the rail.
 *
 * Removing a project used to delete its row, and the foreign-key cascades
 * took every ticket, comment and Session of the project with it. Removal now
 * detaches the project instead: the row and everything that hangs off it
 * stay, every listing hides it, and adding the same folder again re-attaches
 * it with its board and Session history intact.
 *
 * A nullable column with no default: every existing row reads as "on the
 * rail". An older build names its columns in every INSERT and does not read
 * this one, so it shows a detached project as an ordinary one: nothing is
 * lost, the project only reappears on that build's rail.
 */
export const PROJECT_REMOVED_COLUMN_MIGRATION = `
ALTER TABLE projects ADD COLUMN removed_at INTEGER;
`;

/**
 * Probe-gated like 053's column addition: `ADD COLUMN` throws on a column that
 * is already there, and a lineage can be re-offered a version it already ran.
 */
export function applyProjectRemovedColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(projects)") as { name: string }[];
  if (columns.some(({ name }) => name === "removed_at")) return;
  db.exec(PROJECT_REMOVED_COLUMN_MIGRATION);
}
