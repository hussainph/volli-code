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
  const rows = db.prepare<[], LabelRow>("SELECT * FROM labels ORDER BY project_id, name").all();
  return rows.map(mapLabel);
}

export function findLabelByName(
  db: Database.Database,
  projectId: string,
  name: string,
): Label | undefined {
  const row = db
    .prepare<[string, string], LabelRow>("SELECT * FROM labels WHERE project_id = ? AND name = ?")
    .get(projectId, name);
  return row ? mapLabel(row) : undefined;
}

export function getLabel(db: Database.Database, labelId: string): Label | undefined {
  const row = db.prepare<[string], LabelRow>("SELECT * FROM labels WHERE id = ?").get(labelId);
  return row ? mapLabel(row) : undefined;
}

/** Returns the project's existing label named `name`, or creates one with `color: null` ("derive by hash"). */
export function getOrCreateLabel(
  db: Database.Database,
  projectId: string,
  name: string,
  now: number,
): Label {
  const existing = findLabelByName(db, projectId, name);
  if (existing) return existing;
  const id = randomUUID();
  db.prepare(
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
  const result = db
    .prepare(
      "UPDATE labels SET color = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?",
    )
    .run(color, now, labelId);
  if (result.changes === 0) return undefined;
  return getLabel(db, labelId);
}

/** Idempotent: a duplicate `(ticket_id, label_id)` pair is silently ignored (preserves the original rowid/order). */
export function addTicketLabel(db: Database.Database, ticketId: string, labelId: string): void {
  db.prepare("INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)").run(
    ticketId,
    labelId,
  );
}

export function removeTicketLabel(db: Database.Database, ticketId: string, labelId: string): void {
  db.prepare("DELETE FROM ticket_labels WHERE ticket_id = ? AND label_id = ?").run(
    ticketId,
    labelId,
  );
}
