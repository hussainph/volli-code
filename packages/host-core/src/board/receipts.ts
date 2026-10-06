/**
 * The board's command receipts (VC-565; HP § Commands, "Repeating the same
 * key and intent returns the durable result without new intent/effect").
 *
 * A board write a Client sends under a `commandId` is recorded here in the
 * same transaction as its effect, with the answer it gave. The same id with
 * the same intent answers that recorded answer and changes nothing; the same
 * id with another intent is the Client's conflict ({@link
 * BoardCommandIntentConflictError}, branded so every router answers
 * `CONFLICT` / `command-conflict`). A write with no `commandId` (the desktop
 * window's legacy channels, flag off) records nothing, exactly as before.
 *
 * Receipts are retry evidence, not history: past {@link
 * BOARD_RECEIPT_RETENTION_MS} a receipt never answers (an expired row is
 * read as absent, whether or not a later write has pruned it yet), and a
 * backup leaves them behind.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "@volli/session-engine";
import { COMMAND_INTENT_CONFLICT, type CommandIntentConflict } from "@volli/shared";

import { prepared } from "../db/prepared";

/** How long a receipt answers a retry: far past any Client's reconnect backoff. */
export const BOARD_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** One command's identity: who it was for, which operation, and what it asked. */
export interface BoardCommandKey {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly operation: string;
  /** The command's input, without its `commandId`. */
  readonly intent: unknown;
}

/** A command id reused for a different board command: the Client's conflict. */
export class BoardCommandIntentConflictError extends Error implements CommandIntentConflict {
  readonly [COMMAND_INTENT_CONFLICT] = true as const;

  constructor(commandId: string) {
    super(`Command ${commandId} was already used for a different board command.`);
    this.name = "BoardCommandIntentConflictError";
  }
}

function intentDigest(key: BoardCommandKey): string {
  return createHash("sha256")
    .update(canonicalJson({ operation: key.operation, intent: key.intent ?? null }))
    .digest("hex");
}

/** The oldest `created_at` that still answers at `now`. */
function liveSince(now: number): number {
  return now - BOARD_RECEIPT_RETENTION_MS;
}

/**
 * The recorded answer for this command, when it was accepted with this
 * intent within retention; `undefined` when it never was, or its receipt has
 * expired. Throws the branded conflict for the same id under another intent.
 */
export function replayBoardCommand(
  db: Database.Database,
  key: BoardCommandKey,
  now: number,
): { readonly reply: unknown } | undefined {
  const row = prepared<[string, string, number], { intent_digest: string; reply: string }>(
    db,
    `SELECT intent_digest, reply FROM board_command_receipts
     WHERE workspace_id = ? AND command_id = ? AND created_at >= ?`,
  ).get(key.workspaceId, key.commandId, liveSince(now));
  if (row === undefined) return undefined;
  if (row.intent_digest !== intentDigest(key)) {
    throw new BoardCommandIntentConflictError(key.commandId);
  }
  return { reply: JSON.parse(row.reply) as unknown };
}

/**
 * The recorded answer of a command whose resource is gone, so its Workspace
 * can no longer be read off it: a repeated delete. Looked up by its id and
 * operation in whichever Workspace recorded it; the intent must still match.
 * Only the desktop's own window reaches this (it owns every Workspace): a
 * network caller naming a resource that is gone is refused by the router
 * before any handler runs.
 */
export function replayOrphanedBoardCommand(
  db: Database.Database,
  key: Omit<BoardCommandKey, "workspaceId">,
  now: number,
): { readonly reply: unknown; readonly workspaceId: string } | undefined {
  const row = prepared<[string, string, number], { workspace_id: string }>(
    db,
    `SELECT workspace_id FROM board_command_receipts
     WHERE command_id = ? AND operation = ? AND created_at >= ? LIMIT 1`,
  ).get(key.commandId, key.operation, liveSince(now));
  if (row === undefined) return undefined;
  const { reply } = replayBoardCommand(db, { ...key, workspaceId: row.workspace_id }, now)!;
  return { reply, workspaceId: row.workspace_id };
}

/**
 * Records an accepted command's answer. Call it inside the transaction that
 * committed the effect, so the two are durable together; it also drops
 * receipts past retention, an indexed range delete.
 */
export function recordBoardCommand(
  db: Database.Database,
  key: BoardCommandKey,
  reply: unknown,
  now: number,
): void {
  prepared<[number]>(db, "DELETE FROM board_command_receipts WHERE created_at < ?").run(
    liveSince(now),
  );
  prepared<[string, string, string, string, string, number]>(
    db,
    `INSERT INTO board_command_receipts
       (workspace_id, command_id, operation, intent_digest, reply, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    key.workspaceId,
    key.commandId,
    key.operation,
    intentDigest(key),
    JSON.stringify(reply ?? null),
    now,
  );
}
