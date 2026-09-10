/**
 * `labels` + `ticket_labels` repo: row↔domain mapping for the project-scoped
 * label entities backing board chips, and the junction-row CRUD
 * `ticket.setLabels` diffs against. `color: NULL` means "derive by hash" —
 * see `labelColor` in `@volli/shared`'s `label.ts`; this repo never resolves
 * that, it just stores whatever's there.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Label, TicketEventActor } from "@volli/shared";
import { prepared } from "./prepared";

interface LabelRow {
  id: string;
  project_id: string;
  name: string;
  color: string | null;
  merged_into_id: string | null;
  merged_at: number | null;
  merged_by: string | null;
  row_version: number;
  created_at: number;
  updated_at: number;
}

function mapLabel(row: LabelRow): Label {
  return { id: row.id, projectId: row.project_id, name: row.name, color: row.color };
}

/** Every label across every project — used only to build the boot bootstrap payload. */
export function listAllLabels(db: Database.Database): Label[] {
  const rows = prepared<[], LabelRow>(
    db,
    "SELECT * FROM labels WHERE merged_into_id IS NULL ORDER BY project_id, name",
  ).all();
  return rows.map(mapLabel);
}

/** One project's live Labels, in the same stable name order as the bootstrap projection. */
export function listLabelsByProject(db: Database.Database, projectId: string): Label[] {
  const rows = prepared<[string], LabelRow>(
    db,
    "SELECT * FROM labels WHERE project_id = ? AND merged_into_id IS NULL ORDER BY name",
  ).all(projectId);
  return rows.map(mapLabel);
}

/**
 * The project's label named `name`, matched case-insensitively: `ui` finds
 * `UI` (VC-310). `COLLATE NOCASE` rather than a folded comparison in JS so
 * this reads the very index that enforces the rule (migration 046's
 * `labels_project_name_nocase`). `labelNameKey` in `@volli/shared` mirrors
 * NOCASE's ASCII fold and NUL boundary so in-memory consumers cannot disagree.
 */
export function findLabelByName(
  db: Database.Database,
  projectId: string,
  name: string,
): Label | undefined {
  const live = prepared<[string, string], LabelRow>(
    db,
    `SELECT * FROM labels
      WHERE project_id = ? AND name = ? COLLATE NOCASE AND merged_into_id IS NULL`,
  ).get(projectId, name);
  if (live) return mapLabel(live);
  // A merged-away name is an alias, not a mint opportunity. Aliases are kept
  // one hop deep by `retireLabelInto`, so the target row is always live.
  const survivor = prepared<[string, string], LabelRow>(
    db,
    `SELECT survivor.*
       FROM labels alias
       JOIN labels survivor ON survivor.id = alias.merged_into_id
      WHERE alias.project_id = ?
        AND alias.name = ? COLLATE NOCASE
        AND survivor.merged_into_id IS NULL
      LIMIT 1`,
  ).get(projectId, name);
  return survivor ? mapLabel(survivor) : undefined;
}

export function getLabel(db: Database.Database, labelId: string): Label | undefined {
  const row = prepared<[string], LabelRow>(
    db,
    "SELECT * FROM labels WHERE id = ? AND merged_into_id IS NULL",
  ).get(labelId);
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
    `UPDATE labels
        SET color = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND merged_into_id IS NULL`,
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

/** One canonical Label association currently stored on a Ticket. */
export function listTicketLabels(db: Database.Database, ticketId: string): Label[] {
  const rows = prepared<[string], LabelRow>(
    db,
    `SELECT l.*
       FROM ticket_labels tl
       JOIN labels l ON l.id = tl.label_id
      WHERE tl.ticket_id = ?
      ORDER BY tl.rowid`,
  ).all(ticketId);
  return rows.map(mapLabel);
}

/** The Ticket projection a Label merge previews and then mutates. */
export interface LabelMergeTicket {
  readonly id: string;
  readonly ticketNumber: number;
  readonly title: string;
  readonly archived: boolean;
}

/** Every Ticket wearing `labelId`, including archived Tickets, oldest first. */
export function listTicketsWithLabel(db: Database.Database, labelId: string): LabelMergeTicket[] {
  const rows = prepared<
    [string],
    { id: string; ticket_number: number; title: string; archived_at: number | null }
  >(
    db,
    `SELECT t.id, t.ticket_number, t.title, t.archived_at
       FROM ticket_labels tl
       JOIN tickets t ON t.id = tl.ticket_id
      WHERE tl.label_id = ?
      ORDER BY t.ticket_number`,
  ).all(labelId);
  return rows.map((row) => ({
    id: row.id,
    ticketNumber: row.ticket_number,
    title: row.title,
    archived: row.archived_at !== null,
  }));
}

/**
 * Moves every association to the survivor and retires the source as an alias.
 *
 * Retaining the row makes even a zero-Ticket merge durable and stops a later
 * request for the old name from recreating the drift. Existing aliases are
 * repointed when their survivor is merged again, so lookup stays one hop deep.
 */
export function retireLabelInto(
  db: Database.Database,
  input: {
    fromLabelId: string;
    intoLabelId: string;
    now: number;
    actor: TicketEventActor;
  },
): void {
  if (input.fromLabelId === input.intoLabelId) throw new Error("Cannot retire a Label into itself");
  prepared(
    db,
    `INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id)
     SELECT ticket_id, ? FROM ticket_labels WHERE label_id = ?`,
  ).run(input.intoLabelId, input.fromLabelId);
  prepared(db, "DELETE FROM ticket_labels WHERE label_id = ?").run(input.fromLabelId);
  prepared(
    db,
    `UPDATE labels
        SET merged_into_id = ?, row_version = row_version + 1, updated_at = ?
      WHERE merged_into_id = ?`,
  ).run(input.intoLabelId, input.now, input.fromLabelId);
  const retired = prepared(
    db,
    `UPDATE labels
        SET merged_into_id = ?, merged_at = ?, merged_by = ?,
            row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND merged_into_id IS NULL`,
  ).run(input.intoLabelId, input.now, JSON.stringify(input.actor), input.now, input.fromLabelId);
  if (retired.changes !== 1) throw new Error("Unknown or already retired Label");
}

/** The retained fact for a merged-away name, used by export and diagnostics. */
export interface LabelRetirement {
  readonly id: string;
  readonly name: string;
  readonly intoId: string;
  readonly intoName: string;
  readonly mergedAt: number;
  readonly mergedBy: string;
}

export function findLabelRetirement(
  db: Database.Database,
  projectId: string,
  name: string,
): LabelRetirement | undefined {
  const row = prepared<
    [string, string],
    {
      id: string;
      name: string;
      into_id: string;
      into_name: string;
      merged_at: number;
      merged_by: string;
    }
  >(
    db,
    `SELECT alias.id, alias.name, survivor.id AS into_id, survivor.name AS into_name,
            alias.merged_at, alias.merged_by
       FROM labels alias
       JOIN labels survivor ON survivor.id = alias.merged_into_id
      WHERE alias.project_id = ?
        AND alias.name = ? COLLATE NOCASE
        AND survivor.merged_into_id IS NULL
      LIMIT 1`,
  ).get(projectId, name);
  return row
    ? {
        id: row.id,
        name: row.name,
        intoId: row.into_id,
        intoName: row.into_name,
        mergedAt: row.merged_at,
        mergedBy: row.merged_by,
      }
    : undefined;
}
