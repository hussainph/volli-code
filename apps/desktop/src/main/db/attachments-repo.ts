/**
 * `ticket_attachments` table repo (migration 011): row↔domain mapping and
 * CRUD for a ticket's attached spec material — files and URLs, materialized
 * into the agent's worktree at session boot in a later PR (this one is
 * storage only). Mirrors `comments-repo.ts`'s shape: creating/removing an
 * attachment also records an `attachment_added`/`attachment_removed` event
 * in the SAME transaction as the row write, so row and event can never
 * drift.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { defaultAttachmentLabel } from "@volli/shared";
import type { TicketAttachment, TicketEventActor } from "@volli/shared";
import { recordTicketEvent } from "./events-repo";
import { prepared } from "./prepared";

interface TicketAttachmentRow {
  id: string;
  ticket_id: string;
  kind: string;
  label: string;
  file_name: string | null;
  url: string | null;
  created_at: number;
}

function mapAttachment(row: TicketAttachmentRow): TicketAttachment {
  if (row.kind === "file") {
    return {
      id: row.id,
      ticketId: row.ticket_id,
      kind: "file",
      label: row.label,
      // Migration 011's CHECK constraint guarantees a 'file' row always has a
      // file_name — the `?? ""` here is a defensive fallback, never taken.
      fileName: row.file_name ?? "",
      createdAt: row.created_at,
    };
  }
  return {
    id: row.id,
    ticketId: row.ticket_id,
    kind: "url",
    label: row.label,
    url: row.url ?? "",
    createdAt: row.created_at,
  };
}

/** A ticket's attachments, chronological (insertion-order tiebreak). */
export function listAttachments(db: Database.Database, ticketId: string): TicketAttachment[] {
  const rows = prepared<[string], TicketAttachmentRow>(
    db,
    "SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at ASC, rowid ASC",
  ).all(ticketId);
  return rows.map(mapAttachment);
}

export function getAttachment(
  db: Database.Database,
  attachmentId: string,
): TicketAttachment | undefined {
  const row = prepared<[string], TicketAttachmentRow>(
    db,
    "SELECT * FROM ticket_attachments WHERE id = ?",
  ).get(attachmentId);
  return row ? mapAttachment(row) : undefined;
}

export type CreateAttachmentInput = (
  | { kind: "file"; fileName: string }
  | { kind: "url"; url: string }
) & {
  ticketId: string;
  /** Omitted or empty defaults to the fileName/url via {@link defaultAttachmentLabel}. */
  label?: string;
  /** Audit-log attribution for the originating command. */
  eventActor?: TicketEventActor;
};

/**
 * Inserts an attachment row and records its `attachment_added {attachmentId,
 * label}` event in one transaction (rollback leaves neither on failure —
 * e.g. an unknown `ticketId` FK violation).
 */
export function createAttachment(
  db: Database.Database,
  input: CreateAttachmentInput,
  now: number,
): TicketAttachment {
  const run = db.transaction((): TicketAttachment => {
    // `||`, not `??`: an empty-string label falls back too, upholding the
    // schema's CHECK (label <> '') — label is never empty at rest.
    const label = input.label || defaultAttachmentLabel(input);
    const attachment: TicketAttachment =
      input.kind === "file"
        ? {
            id: randomUUID(),
            ticketId: input.ticketId,
            kind: "file",
            label,
            fileName: input.fileName,
            createdAt: now,
          }
        : {
            id: randomUUID(),
            ticketId: input.ticketId,
            kind: "url",
            label,
            url: input.url,
            createdAt: now,
          };
    prepared(
      db,
      `INSERT INTO ticket_attachments (id, ticket_id, kind, label, file_name, url, created_at)
       VALUES (@id, @ticketId, @kind, @label, @fileName, @url, @createdAt)`,
    ).run({
      id: attachment.id,
      ticketId: attachment.ticketId,
      kind: attachment.kind,
      label: attachment.label,
      fileName: attachment.kind === "file" ? attachment.fileName : null,
      url: attachment.kind === "url" ? attachment.url : null,
      createdAt: attachment.createdAt,
    });
    recordTicketEvent(
      db,
      input.ticketId,
      { kind: "attachment_added", attachmentId: attachment.id, label },
      now,
      input.eventActor,
    );
    return attachment;
  });
  return run();
}

/**
 * Deletes an attachment row and records its `attachment_removed {attachmentId,
 * label}` event in one transaction. Returns the deleted attachment, or
 * `undefined` (and records no event) when `attachmentId` is unknown —
 * idempotent, mirroring `deleteComment`'s no-op-on-unknown-id behavior. Does
 * NOT remove the attachment's bytes on disk — the caller (main's IPC layer)
 * pairs this with `attachment-store.ts`'s `removeAttachmentFiles`.
 */
export function deleteAttachment(
  db: Database.Database,
  attachmentId: string,
  now: number,
  eventActor?: TicketEventActor,
): TicketAttachment | undefined {
  const run = db.transaction((): TicketAttachment | undefined => {
    const attachment = getAttachment(db, attachmentId);
    if (!attachment) return undefined;
    prepared(db, "DELETE FROM ticket_attachments WHERE id = ?").run(attachmentId);
    recordTicketEvent(
      db,
      attachment.ticketId,
      { kind: "attachment_removed", attachmentId: attachment.id, label: attachment.label },
      now,
      eventActor,
    );
    return attachment;
  });
  return run();
}
