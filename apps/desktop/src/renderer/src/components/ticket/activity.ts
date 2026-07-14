/**
 * Pure logic behind the ticket Activity feed (ticket-detail-mvp step 4): merge
 * the append-only event log with the comment work-log into one chronological
 * stream, and map each property-change event to a one-line human sentence.
 * Kept free of React/DOM so it's unit-testable at the lib level (the feed
 * component that renders these is view glue, outside the coverage gate).
 *
 * A `commented` event is deliberately DROPPED from the one-liner stream — the
 * comment it points at renders as its own full block instead, so surfacing the
 * event too would double every comment.
 */

import {
  actorHarnessId,
  HARNESS_LABELS,
  isAgentActor,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  USER_ACTOR,
  type TicketComment,
  type TicketEvent,
  type TicketEventPayload,
  type WorktreeIdentity,
} from "@volli/shared";

/** One entry in the merged feed: either a property-change one-liner or a comment block. */
export type FeedItem =
  | { kind: "event"; id: string; at: number; event: TicketEvent }
  | { kind: "comment"; id: string; at: number; comment: TicketComment };

const AGENT_PREFIX = "agent:";

/**
 * A comment/event author's display name: the human is "You"; a first-class
 * harness shows its label; a custom `agent:<id>` harness shows its bare id; any
 * other actor is shown verbatim.
 */
export function commentAuthorLabel(actor: string): string {
  if (actor === USER_ACTOR) return "You";
  const harnessId = actorHarnessId(actor);
  if (harnessId !== null) return HARNESS_LABELS[harnessId];
  if (isAgentActor(actor)) return actor.slice(AGENT_PREFIX.length);
  return actor;
}

/** Joins a labels_changed payload into "added a, b, removed c". */
function describeLabelChange(added: readonly string[], removed: readonly string[]): string {
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`removed ${removed.join(", ")}`);
  return parts.length > 0 ? parts.join(", ") : "updated labels";
}

/** Describes a worktree-identity change, favouring the branch (the field the UI edits most). */
function describeWorktreeChange(from: WorktreeIdentity, to: WorktreeIdentity): string {
  if (from.branch !== to.branch) {
    return to.branch === null ? "cleared branch" : `set branch ${to.branch}`;
  }
  if (from.baseBranch !== to.baseBranch) {
    return to.baseBranch === null ? "cleared base branch" : `set base branch ${to.baseBranch}`;
  }
  if (from.worktreePath !== to.worktreePath) {
    return to.worktreePath === null ? "cleared worktree" : `set worktree ${to.worktreePath}`;
  }
  return "updated worktree";
}

/**
 * The one-line sentence for a property-change event (`null` for `commented`,
 * which the feed renders as its comment instead). Verb-phrase style, no
 * subject — the feed row supplies the actor/timestamp chrome.
 */
export function describeEvent(payload: TicketEventPayload): string | null {
  switch (payload.kind) {
    case "created":
      return "created the ticket";
    case "status_changed":
      return `moved ${TICKET_STATUS_LABELS[payload.from]} → ${TICKET_STATUS_LABELS[payload.to]}`;
    case "priority_changed":
      return `changed priority ${TICKET_PRIORITY_LABELS[payload.from]} → ${TICKET_PRIORITY_LABELS[payload.to]}`;
    case "retitled":
      return `renamed to "${payload.to}"`;
    case "body_edited":
      return "edited the description";
    case "labels_changed":
      return describeLabelChange(payload.added, payload.removed);
    case "archived":
      return "archived the ticket";
    case "unarchived":
      return "restored the ticket";
    case "session_started":
      return `started session ${payload.title}`;
    case "session_ended":
      return "ended a session";
    case "worktree_changed":
      return describeWorktreeChange(payload.from, payload.to);
    case "commented":
      return null;
  }
}

/**
 * Merges events and comments into one chronological (oldest-first) feed.
 * `commented` events are dropped (their comment renders instead). Sorts by
 * timestamp; ties keep input order (events before comments), so the result is
 * deterministic for a given DB read.
 */
export function buildActivityFeed(
  events: readonly TicketEvent[],
  comments: readonly TicketComment[],
): FeedItem[] {
  const items: FeedItem[] = [];
  for (const event of events) {
    if (event.payload.kind === "commented") continue;
    items.push({ kind: "event", id: event.id, at: event.createdAt, event });
  }
  for (const comment of comments) {
    items.push({ kind: "comment", id: comment.id, at: comment.createdAt, comment });
  }
  return items.toSorted((a, b) => a.at - b.at);
}
