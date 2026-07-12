/**
 * One-time localStorage → SQLite import (docs/CONCEPT.md decision #29): the pre-SQLite
 * `Project` shape (no `sortOrder`/`updatedAt`, as it lived in the
 * zustand-persisted `volli:projects` store) and a defensive validator for
 * the value read back out of localStorage. Mirrors the board store's
 * `isValidTicket` (apps/desktop/src/renderer/src/stores/board.ts): validate
 * rather than trust, drop invalid rows individually rather than throwing.
 */

/** The pre-SQLite `Project` shape: no `sortOrder`, no `updatedAt`. */
export interface LegacyProject {
  id: string;
  name: string;
  path: string;
  ticketPrefix: string;
  colorIndex: number;
  /** Epoch milliseconds. */
  createdAt: number;
}

const LEGACY_PROJECT_STRING_FIELDS = ["id", "name", "path", "ticketPrefix"] as const;

/** Whether `value` is a {@link LegacyProject} every field the importer reads can trust. */
function isValidLegacyProject(value: unknown): value is LegacyProject {
  if (typeof value !== "object" || value === null) return false;
  const project = value as Record<string, unknown>;
  return (
    LEGACY_PROJECT_STRING_FIELDS.every((field) => typeof project[field] === "string") &&
    typeof project.colorIndex === "number" &&
    typeof project.createdAt === "number"
  );
}

/**
 * Sanitizes an unknown value (the zustand-persisted `volli:projects` payload,
 * already unwrapped from its `{state,version}` envelope by the caller) into
 * an array of trustworthy {@link LegacyProject}s. A non-array input yields an
 * empty array; individual entries that fail validation are dropped rather
 * than aborting the whole import.
 *
 * Duplicate `id` or `path` entries (from hand-edited or version-drifted
 * localStorage) are also dropped, keeping the first occurrence: the `projects`
 * table has `PRIMARY KEY(id)` and `UNIQUE(path)`, so a duplicate would throw on
 * insert and — since the import is one transaction — abort the whole batch,
 * losing every valid project. Deduping here keeps one bad row from destroying
 * the rest.
 */
export function sanitizeLegacyProjects(value: unknown): LegacyProject[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const projects: LegacyProject[] = [];
  for (const entry of value) {
    if (!isValidLegacyProject(entry)) continue;
    if (seenIds.has(entry.id) || seenPaths.has(entry.path)) continue;
    seenIds.add(entry.id);
    seenPaths.add(entry.path);
    projects.push(entry);
  }
  return projects;
}
