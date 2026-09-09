/**
 * `labels` + `ticket_labels` repo: row↔domain mapping for the project-scoped
 * label entities backing board chips, and the junction-row CRUD
 * `ticket.setLabels` diffs against. `color: NULL` means "derive by hash" —
 * see `labelColor` in `@volli/shared`'s `label.ts`; this repo never resolves
 * that, it just stores whatever's there.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Label } from "@volli/shared";
import { prepared } from "./prepared";

interface LabelRow {
  id: string;
  project_id: string;
  name: string;
  color: string | null;
  row_version: number;
  created_at: number;
  updated_at: number;
}

function mapLabel(row: LabelRow): Label {
  return { id: row.id, projectId: row.project_id, name: row.name, color: row.color };
}

/** Every label across every project — used only to build the boot bootstrap payload. */
export function listAllLabels(db: Database.Database): Label[] {
  const rows = prepared<[], LabelRow>(db, "SELECT * FROM labels ORDER BY project_id, name").all();
  return rows.map(mapLabel);
}

/**
 * The project's label named `name`, matched case-insensitively: `ui` finds
 * `UI` (VC-310). `COLLATE NOCASE` rather than a folded comparison in JS so
 * this reads the very index that enforces the rule (migration 043's
 * `labels_project_name_nocase`), which is also why `labelNameKey` in
 * `@volli/shared` folds ASCII and only ASCII — the two must not disagree.
 */
export function findLabelByName(
  db: Database.Database,
  projectId: string,
  name: string,
): Label | undefined {
  const row = prepared<[string, string], LabelRow>(
    db,
    "SELECT * FROM labels WHERE project_id = ? AND name = ? COLLATE NOCASE",
  ).get(projectId, name);
  return row ? mapLabel(row) : undefined;
}

export function getLabel(db: Database.Database, labelId: string): Label | undefined {
  const row = prepared<[string], LabelRow>(db, "SELECT * FROM labels WHERE id = ?").get(labelId);
  return row ? mapLabel(row) : undefined;
}

/**
 * Returns the project's existing label named `name` — under ANY case spelling
 * of it — or creates one with `color: null` ("derive by hash"). Resolving
 * rather than minting is what keeps a second `ui` from appearing beside `UI`
 * when a door other than the picker asks for one (VC-310); the caller gets the
 * spelling the project already settled on.
 */
export function getOrCreateLabel(
  db: Database.Database,
  projectId: string,
  name: string,
  now: number,
): Label {
  const existing = findLabelByName(db, projectId, name);
  if (existing) return existing;
  const id = randomUUID();
  prepared(
    db,
    `INSERT INTO labels (id, project_id, name, color, row_version, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 1, ?, ?)`,
  ).run(id, projectId, name, now, now);
  return { id, projectId, name, color: null };
}

/** Sets (or clears, via `null`) a label's stored color. Returns `undefined` when `labelId` is unknown. */
export function setLabelColor(
  db: Database.Database,
  labelId: string,
  color: string | null,
  now: number,
): Label | undefined {
  const result = prepared(
    db,
    "UPDATE labels SET color = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?",
  ).run(color, now, labelId);
  if (result.changes === 0) return undefined;
  return getLabel(db, labelId);
}

/** Idempotent: a duplicate `(ticket_id, label_id)` pair is silently ignored (preserves the original rowid/order). */
export function addTicketLabel(db: Database.Database, ticketId: string, labelId: string): void {
  prepared(db, "INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)").run(
    ticketId,
    labelId,
  );
}

export function removeTicketLabel(db: Database.Database, ticketId: string, labelId: string): void {
  prepared(db, "DELETE FROM ticket_labels WHERE ticket_id = ? AND label_id = ?").run(
    ticketId,
    labelId,
  );
}

/** Every ticket wearing `labelId`, oldest ticket first — a merge's blast radius. */
export function listTicketIdsWithLabel(db: Database.Database, labelId: string): string[] {
  const rows = prepared<[string], { ticket_id: string }>(
    db,
    `SELECT tl.ticket_id
       FROM ticket_labels tl
       JOIN tickets t ON t.id = tl.ticket_id
      WHERE tl.label_id = ?
      ORDER BY t.ticket_number`,
  ).all(labelId);
  return rows.map((row) => row.ticket_id);
}

/**
 * Moves every association from one label to another and deletes the emptied
 * one (VC-310's merge). `INSERT OR IGNORE` for the ticket that wore BOTH: its
 * target row already exists, and the junction's primary key would otherwise
 * reject the copy rather than collapsing it. Deleting the source last lets
 * `ticket_labels.label_id`'s ON DELETE CASCADE clear the rows just copied.
 */
export function mergeLabelInto(
  db: Database.Database,
  fromLabelId: string,
  intoLabelId: string,
): void {
  prepared(
    db,
    `INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id)
     SELECT ticket_id, ? FROM ticket_labels WHERE label_id = ?`,
  ).run(intoLabelId, fromLabelId);
  prepared(db, "DELETE FROM labels WHERE id = ?").run(fromLabelId);
}
