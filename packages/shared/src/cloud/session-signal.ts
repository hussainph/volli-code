/**
 * What a Session's `done` / `blocked` signal does to the board, as data.
 *
 * Today the one effect is a courtesy: the Session's last todo list, left on its
 * ticket as a comment, so the person who comes back to the ticket reads what
 * the Session thought it was doing at the moment it stopped. On `blocked` that
 * is most of a handover.
 *
 * Pure, so every writer derives the same comment from the same facts: the
 * local agent socket after it records the signal (writing through the board's
 * comment command), and the cloud backend when it accepts the signal and folds
 * the Session's todo list. Nothing here reads a transcript or writes a row.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { todoListMarkdown, type SessionTodoList } from "../session-todo";
import { parseId, type CommentId, type TicketId } from "./ids";

/**
 * DURABLE, not live: a signal comment's UUID-v8 derivation. Changing this
 * segment or hash layout would duplicate comments on every refold.
 */
export function sessionSignalCommentId(sessionId: string, eventId: string): CommentId {
  const bytes = sha256(utf8ToBytes(`session-signal-comment:${sessionId}:${eventId}`)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return parseId(
    "comment",
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

export type SessionSignal = "done" | "blocked";

/** One board write a signal implies. */
export type SessionSignalBoardEffect = {
  kind: "comment";
  ticketId: TicketId;
  body: string;
};

/**
 * The board writes a signal implies: none for a ticketless (Board) Session,
 * none for a Session that never wrote a todo list (`null`), and none for one
 * that deliberately cleared it (`[]`): "here is an empty checklist" is noise.
 */
export function sessionSignalBoardEffects(input: {
  signal: SessionSignal;
  ticketId: TicketId | null;
  todoList: SessionTodoList | null;
}): SessionSignalBoardEffect[] {
  const { signal, ticketId, todoList } = input;
  if (ticketId === null || todoList === null || todoList.length === 0) return [];
  return [
    {
      kind: "comment",
      ticketId,
      body: `Todo list at session ${signal}:\n\n${todoListMarkdown(todoList)}`,
    },
  ];
}
