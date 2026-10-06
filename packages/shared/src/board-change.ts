/**
 * The board's Workspace change feed vocabulary (VC-565; HP § Workspace change
 * feed, F1). Domain types, not transport: the host stamps these, the board
 * router publishes them on `board.changes`, and any Client (the desktop's
 * renderer, a phone) applies them to its last-known view.
 *
 * A change names one entity and what happened to it: it is never a diff.
 * When the host knows the committed row it inlines it, so a Client applies
 * the change without a read; a change without a row asks the Client to
 * re-read that entity through its area query (for `project`, the board's
 * roster). A change caused by a Client's command names that command's
 * `commandId`, which is how a Client retires its optimistic pending write
 * (T5) instead of guessing from arrival order.
 */
import type { Label } from "./label";
import type { Project } from "./project-identity";
import type { TicketComment } from "./ticket-comment";
import type { TicketSummary } from "./ticket";

/** The resource kinds the board router names (HP § Command catalog, "Resources, open per area"). */
export const BOARD_RESOURCE_KINDS = Object.freeze({
  ticket: "ticket",
  comment: "comment",
  label: "label",
} as const);

export type BoardResourceKind = (typeof BOARD_RESOURCE_KINDS)[keyof typeof BOARD_RESOURCE_KINDS];

/** The entity kinds the board stamps on its Workspace's change feed. */
export const BOARD_CHANGE_KINDS = ["project", "ticket", "label", "comment", "ticketEvent"] as const;

export type BoardChangeKind = (typeof BOARD_CHANGE_KINDS)[number];

/** Whether the entity was written (`upsert`) or is gone (`delete`, a tombstone). */
export type BoardChangeOp = "upsert" | "delete";

interface BoardChangeBase {
  readonly op: BoardChangeOp;
  /** The entity's id; for `ticketEvent`, the ticket whose history grew. */
  readonly id: string;
  /** The Workspace (project) the entity belongs to. */
  readonly projectId: string;
  /** The Client command that caused the change, when one did. */
  readonly commandId?: string;
}

/** A project row changed; without `project`, re-read the board's roster. */
export interface BoardProjectChange extends BoardChangeBase {
  readonly kind: "project";
  readonly project?: Project;
}

/** A ticket changed; `ticket` is the committed row without its body (VC-387). */
export interface BoardTicketChange extends BoardChangeBase {
  readonly kind: "ticket";
  readonly ticket?: TicketSummary;
  /** The change moved where the ticket's Sessions run (its checkout): re-read its venue. */
  readonly checkoutMoved?: boolean;
}

export interface BoardLabelChange extends BoardChangeBase {
  readonly kind: "label";
  readonly label?: Label;
}

export interface BoardCommentChange extends BoardChangeBase {
  readonly kind: "comment";
  readonly ticketId: string;
  readonly comment?: TicketComment;
}

/** A ticket's event history grew: re-read it if it is on screen. */
export interface BoardTicketEventChange extends BoardChangeBase {
  readonly kind: "ticketEvent";
  readonly ticketId: string;
}

export type BoardChange =
  | BoardProjectChange
  | BoardTicketChange
  | BoardLabelChange
  | BoardCommentChange
  | BoardTicketEventChange;

/** One delivery on `board.changes`: the changes stamped through `cursor`, oldest first. */
export interface BoardChangeBatch {
  readonly changes: readonly BoardChange[];
}

/**
 * What a board write answers besides its row: the receipt of the command it
 * recorded (BOUNDARIES rule 4). `replayed` is true when the host had already
 * accepted this `commandId` with the same intent and answered from its
 * receipt, without running the command again.
 */
export interface BoardCommandReceipt {
  readonly commandId: string;
  readonly status: "completed";
  readonly replayed: boolean;
}

/**
 * The brand a change feed's "your cursor cannot resume here" carries
 * (HP § Workspace change feed): a cursor from another feed instance or
 * epoch, or older than the feed's retention. Every router answers it
 * `PRECONDITION_FAILED` / `subscription-resnapshot-required`, and the Client
 * re-reads its snapshot. A well-known symbol, so the brand matches across
 * module instances, as `OPERATION_UNAVAILABLE` does.
 */
export const FEED_RESNAPSHOT_REQUIRED: unique symbol = Symbol.for(
  "@volli/feed-resnapshot-required",
);

export interface FeedResnapshotRequired {
  readonly [FEED_RESNAPSHOT_REQUIRED]: true;
}

/** The error a feed throws for {@link FeedResnapshotRequired}; the message is the client's. */
export class FeedResnapshotRequiredError extends Error implements FeedResnapshotRequired {
  readonly [FEED_RESNAPSHOT_REQUIRED] = true as const;

  constructor(message = "This change-feed cursor cannot resume; read the snapshot again.") {
    super(message);
    this.name = "FeedResnapshotRequiredError";
  }
}

/** Whether a thrown value is a {@link FeedResnapshotRequired}. */
export function isFeedResnapshotRequired(value: unknown): value is FeedResnapshotRequired {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<FeedResnapshotRequired>)[FEED_RESNAPSHOT_REQUIRED] === true
  );
}

/**
 * The order of two Workspace change-feed cursors (HP § Workspace change
 * feed): negative, zero or positive when `a` is before, at or after `b` on
 * the same feed, and `null` when they come from different feeds (another
 * feed instance or epoch, a restarted host) and have no order at all.
 *
 * A cursor stays opaque to a Client in every other way: it is
 * `<feed>:<seq>`, where `<feed>` names one feed (one instance of one
 * Workspace's feed, in one epoch) and `seq` rises within it. A Client keeps
 * its view monotonic with this (never applying a read or a row older than
 * what it holds) without reading meaning from a cursor's parts.
 */
export function compareBoardCursors(a: string, b: string): number | null {
  const left = splitCursor(a);
  const right = splitCursor(b);
  if (left === null || right === null || left.feed !== right.feed) return null;
  return left.seq - right.seq;
}

function splitCursor(cursor: string): { feed: string; seq: number } | null {
  const at = cursor.lastIndexOf(":");
  if (at <= 0) return null;
  const seqText = cursor.slice(at + 1);
  if (!/^\d+$/u.test(seqText)) return null;
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq)) return null;
  return { feed: cursor.slice(0, at), seq };
}
