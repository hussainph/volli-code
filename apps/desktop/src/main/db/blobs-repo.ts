/**
 * `blobs` + `blob_links` repo (migration 020): row↔domain mapping for
 * attachment bytes and the links naming where each one hangs. Replaces
 * `attachments-repo.ts`. Mirrors `comments-repo.ts`'s shape — creating or
 * removing a Ticket link also records an `attachment_added`/`attachment_removed`
 * ticket event in the SAME transaction as the row write, so row and event can
 * never drift.
 *
 * The durable event vocabulary keeps saying "attachment" (`attachment_added`,
 * `attachmentId`) because those strings are already in the ledger's codec and
 * a durable name is frozen once it ships. Only the code's noun moved to
 * `blob`; the id those events carry is now a `blob_links.id`.
 *
 * Bytes are not this module's business — `blob-store.ts` owns the file under
 * `userData`, keyed by the same hash. Inserting a Blob row for bytes the store
 * has not been given yet would be a lie, so `upsertBlob` is only ever called
 * by the import path, after the write lands.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Blob, BlobLink, NamedBlobLink, TicketEventActor } from "@volli/shared";
import { recordTicketEvent } from "./events-repo";
import { prepared } from "./prepared";

interface BlobRow {
  hash: string;
  mime: string;
  size_bytes: number;
  original_name: string;
  width: number | null;
  height: number | null;
  created_at: number;
}

interface BlobLinkRow {
  id: string;
  blob_hash: string;
  ticket_id: string | null;
  session_id: string | null;
  label: string;
  created_at: number;
}

function mapBlob(row: BlobRow): Blob {
  return {
    hash: row.hash,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    originalName: row.original_name,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

function mapLink(row: BlobLinkRow): BlobLink {
  const common = {
    id: row.id,
    blobHash: row.blob_hash,
    label: row.label,
    createdAt: row.created_at,
  };
  // Migration 020's CHECK guarantees exactly one owner is set, so the
  // ticket_id branch is the complete test — a row with neither cannot exist.
  return row.ticket_id !== null
    ? { ...common, ticketId: row.ticket_id, sessionId: null }
    : { ...common, ticketId: null, sessionId: row.session_id ?? "" };
}

export function getBlob(db: Database.Database, hash: string): Blob | undefined {
  const row = prepared<[string], BlobRow>(db, "SELECT * FROM blobs WHERE hash = ?").get(hash);
  return row ? mapBlob(row) : undefined;
}

/**
 * Records a Blob, or leaves the existing row untouched when its hash is
 * already known. Idempotent by construction: identical bytes hash identically,
 * so a re-import is a no-op rather than a conflict — which is what makes
 * pasting the same screenshot into a Ticket and then into a chat cost one row
 * and one file.
 */
export function upsertBlob(db: Database.Database, blob: Blob): Blob {
  prepared(
    db,
    `INSERT INTO blobs (hash, mime, size_bytes, original_name, width, height, created_at)
     VALUES (@hash, @mime, @sizeBytes, @originalName, @width, @height, @createdAt)
     ON CONFLICT (hash) DO NOTHING`,
  ).run({
    hash: blob.hash,
    mime: blob.mime,
    sizeBytes: blob.sizeBytes,
    originalName: blob.originalName,
    width: blob.width,
    height: blob.height,
    createdAt: blob.createdAt,
  });
  // The stored row wins over the caller's: on a second import the original
  // name and dimensions recorded first are the ones every existing link and
  // every materialized path already agree on.
  return getBlob(db, blob.hash) ?? blob;
}

/** A ticket's links, chronological (insertion-order tiebreak). */
export function listTicketLinks(db: Database.Database, ticketId: string): BlobLink[] {
  return prepared<[string], BlobLinkRow>(
    db,
    "SELECT * FROM blob_links WHERE ticket_id = ? ORDER BY created_at ASC, rowid ASC",
  )
    .all(ticketId)
    .map(mapLink);
}

/** A session's links, chronological (insertion-order tiebreak). */
export function listSessionLinks(db: Database.Database, sessionId: string): BlobLink[] {
  return prepared<[string], BlobLinkRow>(
    db,
    "SELECT * FROM blob_links WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
  )
    .all(sessionId)
    .map(mapLink);
}

/**
 * Every link that should be materialized into one workspace, joined to the
 * name its Blob was imported under. That is the Ticket's links (spec material
 * the agent should have from the first turn) AND the Session's own (files
 * handed over mid-chat) — one list, because the workspace has one
 * `.volli/attachments` directory and the collision-free naming has to be
 * decided across all of it at once.
 *
 * Either id may be null: a ticketless Session materializes only what was
 * handed to it directly, and the worktree `ensure` pipeline runs before any
 * Session exists, so it materializes the Ticket's links alone.
 *
 * Ticket links are ordered ahead of Session links rather than interleaved by
 * time, so that handing the agent a file mid-chat can only ever APPEND to the
 * naming — it can never renumber a `spec-2.png` the brief already named.
 */
export function listMaterializableLinks(
  db: Database.Database,
  sessionId: string | null,
  ticketId: string | null,
): NamedBlobLink[] {
  const rows = prepared<[string | null, string | null], BlobLinkRow & { original_name: string }>(
    db,
    `SELECT blob_links.*, blobs.original_name FROM blob_links
     JOIN blobs ON blobs.hash = blob_links.blob_hash
     WHERE blob_links.session_id = ? OR blob_links.ticket_id = ?
     ORDER BY (blob_links.session_id IS NOT NULL) ASC,
              blob_links.created_at ASC, blob_links.rowid ASC`,
  ).all(sessionId, ticketId);
  return rows.map((row) => ({
    linkId: row.id,
    blobHash: row.blob_hash,
    label: row.label,
    originalName: row.original_name,
  }));
}

export function getLink(db: Database.Database, linkId: string): BlobLink | undefined {
  const row = prepared<[string], BlobLinkRow>(db, "SELECT * FROM blob_links WHERE id = ?").get(
    linkId,
  );
  return row ? mapLink(row) : undefined;
}

export type CreateBlobLinkInput = {
  blobHash: string;
  /** Omitted or empty defaults to the Blob's original name. */
  label?: string;
  /** Audit-log attribution for the originating command; ticket links only. */
  eventActor?: TicketEventActor;
} & ({ ticketId: string; sessionId?: undefined } | { sessionId: string; ticketId?: undefined });

/**
 * Links a Blob to a Ticket or a Session. A ticket link also records its
 * `attachment_added` event in the same transaction (rollback leaves neither —
 * e.g. an unknown `ticketId` FK violation). A session link records nothing:
 * the Session ledger's own record of the turn is the transcript message that
 * carries the file part, and a second event saying the same thing would be one
 * more thing to keep in step.
 */
export function createBlobLink(
  db: Database.Database,
  input: CreateBlobLinkInput,
  now: number,
): BlobLink {
  const run = db.transaction((): BlobLink => {
    const blob = getBlob(db, input.blobHash);
    if (!blob) throw new Error(`Unknown blob: ${input.blobHash}`);
    // `||`, not `??`: an empty-string label falls back too, upholding the
    // schema's CHECK (label <> '') — a label is never empty at rest.
    const label = input.label || blob.originalName;
    const link: BlobLink = {
      id: randomUUID(),
      blobHash: input.blobHash,
      label,
      createdAt: now,
      ...(input.ticketId !== undefined
        ? { ticketId: input.ticketId, sessionId: null }
        : { ticketId: null, sessionId: input.sessionId }),
    };
    prepared(
      db,
      `INSERT INTO blob_links (id, blob_hash, ticket_id, session_id, label, created_at)
       VALUES (@id, @blobHash, @ticketId, @sessionId, @label, @createdAt)`,
    ).run({
      id: link.id,
      blobHash: link.blobHash,
      ticketId: link.ticketId,
      sessionId: link.sessionId,
      label: link.label,
      createdAt: link.createdAt,
    });
    if (link.ticketId !== null) {
      recordTicketEvent(
        db,
        link.ticketId,
        { kind: "attachment_added", attachmentId: link.id, label },
        now,
        input.eventActor,
      );
    }
    return link;
  });
  return run();
}

/**
 * Removes a link and records its `attachment_removed` event (ticket links
 * only) in one transaction. Returns the removed link, or `undefined` — and
 * records no event — when `linkId` is unknown, mirroring `deleteComment`'s
 * idempotent no-op. Does NOT touch the Blob row or its bytes: a Blob outlives
 * its last link until something collects it deliberately.
 */
export function deleteBlobLink(
  db: Database.Database,
  linkId: string,
  now: number,
  eventActor?: TicketEventActor,
): BlobLink | undefined {
  const run = db.transaction((): BlobLink | undefined => {
    const link = getLink(db, linkId);
    if (!link) return undefined;
    prepared(db, "DELETE FROM blob_links WHERE id = ?").run(linkId);
    if (link.ticketId !== null) {
      recordTicketEvent(
        db,
        link.ticketId,
        { kind: "attachment_removed", attachmentId: link.id, label: link.label },
        now,
        eventActor,
      );
    }
    return link;
  });
  return run();
}

/**
 * Hashes of Blobs no link names any more. The caller pairs this with
 * `blob-store.ts`'s remove to reclaim the bytes — deliberately, on its own
 * schedule, rather than as a cascade off the last link.
 */
export function listUnlinkedBlobHashes(db: Database.Database): string[] {
  return prepared<[], { hash: string }>(
    db,
    `SELECT hash FROM blobs
     WHERE NOT EXISTS (SELECT 1 FROM blob_links WHERE blob_links.blob_hash = blobs.hash)`,
  )
    .all()
    .map((row) => row.hash);
}
