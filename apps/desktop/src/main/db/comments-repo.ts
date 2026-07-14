/**
 * `ticket_comments` table repo (migration 003): row↔domain mapping and CRUD
 * for a ticket's work log — content, distinct from the append-only
 * `ticket_events` audit trail. Creating a comment also records a `commented`
 * event (`{commentId}`) in the SAME transaction, so the two can never drift:
 * either both the comment row and its event exist, or neither does.
 * Editing/deleting a comment records no event — only its creation is
 * audit-worthy; the body itself is the source of truth for edits.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { TicketComment } from "@volli/shared";
import { recordTicketEvent } from "./events-repo";
import { prepared } from "./prepared";

interface TicketCommentRow {
  id: string;
  ticket_id: string;
  session_id: string | null;
  actor: string;
  body: string;
  created_at: number;
  updated_at: number;
}

function mapComment(row: TicketCommentRow): TicketComment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    sessionId: row.session_id,
    actor: row.actor,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A ticket's comments, chronological (insertion-order tiebreak) — the work-log feed. */
export function listComments(db: Database.Database, ticketId: string): TicketComment[] {
  const rows = prepared<[string], TicketCommentRow>(
    db,
    "SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC, rowid ASC",
  ).all(ticketId);
  return rows.map(mapComment);
}

export function getComment(db: Database.Database, commentId: string): TicketComment | undefined {
  const row = prepared<[string], TicketCommentRow>(
    db,
    "SELECT * FROM ticket_comments WHERE id = ?",
  ).get(commentId);
  return row ? mapComment(row) : undefined;
}

export interface CreateCommentInput {
  ticketId: string;
  body: string;
  /** {@link USER_ACTOR} or an {@link agentActor} string. */
  actor: string;
  /** Links an agent-posted session summary back to its session; `null`/omitted for user comments. */
  sessionId?: string | null;
}

/**
 * Inserts a comment row and records its `commented {commentId}` event in one
 * transaction (rollback leaves neither on failure — e.g. an unknown
 * `ticketId`/`sessionId` FK violation).
 */
export function createComment(
  db: Database.Database,
  input: CreateCommentInput,
  now: number,
): TicketComment {
  const run = db.transaction((): TicketComment => {
    const comment: TicketComment = {
      id: randomUUID(),
      ticketId: input.ticketId,
      sessionId: input.sessionId ?? null,
      actor: input.actor,
      body: input.body,
      createdAt: now,
      updatedAt: now,
    };
    prepared(
      db,
      `INSERT INTO ticket_comments (id, ticket_id, session_id, actor, body, created_at, updated_at)
       VALUES (@id, @ticketId, @sessionId, @actor, @body, @createdAt, @updatedAt)`,
    ).run(comment);
    recordTicketEvent(db, input.ticketId, { kind: "commented", commentId: comment.id }, now);
    return comment;
  });
  return run();
}

export interface UpdateCommentInput {
  commentId: string;
  body: string;
}

/** Updates a comment's body and touches `updated_at` only — no event. `undefined` when `commentId` is unknown. */
export function updateComment(
  db: Database.Database,
  input: UpdateCommentInput,
  now: number,
): TicketComment | undefined {
  const result = prepared(
    db,
    "UPDATE ticket_comments SET body = ?, updated_at = ? WHERE id = ?",
  ).run(input.body, now, input.commentId);
  if (result.changes === 0) return undefined;
  return getComment(db, input.commentId);
}

/** Hard-deletes a comment — no event. Idempotent: deleting an unknown id is a no-op. */
export function deleteComment(db: Database.Database, commentId: string): void {
  prepared(db, "DELETE FROM ticket_comments WHERE id = ?").run(commentId);
}
