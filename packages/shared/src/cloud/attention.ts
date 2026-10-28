/**
 * Needs-you attention items: the vocabulary the backend stores, the frozen ids
 * each producer derives, and the review-request rule the board raises from.
 *
 * An attention item belongs to the one person it names. The backend's
 * `lib/attention.ts` is the only writer of `attentionItems`; every producer
 * (the Session fold, board events, runners, `volli notify`) goes through it,
 * which is also where push notifications (not built yet) will hook in. Who
 * may see an item is `canSeeAttention` (`visibility.ts`).
 */

import type { Actor } from "./actor";
import type { BoardEventDraft } from "./board-rules";
import type { ProjectId, RunnerId, SessionId, TicketId, UserId } from "./ids";
import type { TicketStatus } from "../ticket";

/** What raised an item. Stored; add only (a removed literal would fail the stored rows' validation). */
export const ATTENTION_SOURCES = [
  "session_attention",
  "interaction",
  "session_blocked",
  "review_requested",
  "mention",
  "environment_failed",
  "runner_alert",
  "billing",
  "notify",
] as const;
export type AttentionSource = (typeof ATTENTION_SOURCES)[number];

/** Why an item stopped needing its person. */
export const ATTENTION_CLEARED_REASONS = [
  "resolved",
  "access_lost",
  "superseded",
  "deleted",
] as const;
export type AttentionClearedReason = (typeof ATTENTION_CLEARED_REASONS)[number];

export const ATTENTION_LIMITS = {
  /** Items one `markSeen` call takes. */
  markSeenIds: 100,
  /** A `volli notify` title, in characters. */
  notifyTitleLength: 200,
  /** A `volli notify` detail, in characters. */
  notifyDetailLength: 2_000,
  /** Open `volli notify` items one Session may hold, so a chatty agent cannot bury the rest. */
  notifyOpenPerSession: 32,
} as const;

// ── frozen ids ────────────────────────────────────────────────────────────────
//
// Each id is re-derived by its producer and found again by exact string, so
// a refold, a retry or a second board write lands on the same row. DURABLE:
// changing how one is built leaves rows nothing can ever clear.

/** Frozen: a Session's item is `s:{sessionId}:{sourceId}`. */
export function sessionAttentionId(sessionId: SessionId | string, sourceId: string): string {
  return `s:${sessionId}:${sourceId}`;
}

/**
 * Frozen source ids of the Session items the backend raises itself, in a
 * `volli:` namespace no Engine attention or interaction id uses.
 */
export const SESSION_BLOCKED_SOURCE_ID = "volli:blocked";

/** Frozen: the source id of a fact the backend could not read or fold, by its sequence. */
export function quarantineSourceId(sequence: number): string {
  return `volli:quarantine:${sequence}`;
}

/** Frozen: the source id of one `volli notify` call. */
export function notifySourceId(notifyId: string): string {
  return `volli:notify:${notifyId}`;
}

/** Frozen: a review request is `t:{ticketId}:review:{userId}`, one per ticket and requested person. */
export function reviewAttentionId(ticketId: TicketId | string, userId: UserId | string): string {
  return `t:${ticketId}:review:${userId}`;
}

/** The runner alerts the backend raises itself. Frozen segments of their ids. */
export const RUNNER_ALERTS = { credentialReuse: "credential_reuse" } as const;
export type RunnerAlert = (typeof RUNNER_ALERTS)[keyof typeof RUNNER_ALERTS];

/** Frozen: a runner's alert is `r:{runnerId}:{alert}`. */
export function runnerAlertAttentionId(runnerId: RunnerId | string, alert: RunnerAlert): string {
  return `r:${runnerId}:${alert}`;
}

/** Frozen: one paused Automation alert per project and armer; ownership never transfers on re-arm. */
export function automationPauseAttentionId(
  projectId: ProjectId | string,
  userId: UserId | string,
): string {
  return `a:${projectId}:${userId}:paused`;
}

// ── review requests ─────────────────────────────────────────────────────────────

/** What the review-request rule reads of a ticket. */
export interface ReviewTicketFacts {
  status: TicketStatus;
  assigneeUserId: UserId | null;
  /** Archived or deleted: off the board. */
  archived: boolean;
}

/** The tickets a write's events may have changed a review request for, in first-seen order. */
export function reviewTicketIds(events: readonly BoardEventDraft[]): TicketId[] {
  const ids: TicketId[] = [];
  for (const { ticketId, payload } of events) {
    if (ticketId === null || ids.includes(ticketId)) continue;
    if (
      payload.kind === "status_changed" ||
      payload.kind === "assigned" ||
      payload.kind === "archived" ||
      payload.kind === "unarchived"
    ) {
      ids.push(ticketId);
    }
  }
  return ids;
}

/**
 * The ticket after a write's events: the stored row, with the status, the
 * assignee and the archive the events record laid on top, so the answer does
 * not depend on whether the write patched the row before or after appending.
 */
export function reviewFactsAfter(
  stored: ReviewTicketFacts,
  ticketId: TicketId,
  events: readonly BoardEventDraft[],
): ReviewTicketFacts {
  const facts = { ...stored };
  for (const event of events) {
    if (event.ticketId !== ticketId) continue;
    const { payload } = event;
    if (payload.kind === "status_changed") facts.status = payload.to;
    else if (payload.kind === "assigned") facts.assigneeUserId = payload.to;
    else if (payload.kind === "archived") facts.archived = true;
    else if (payload.kind === "unarchived") facts.archived = false;
  }
  return facts;
}

/**
 * Who a ticket asks for a review, if anyone: its assignee, while it sits in
 * Needs Review on the board. A person never asks themselves: when the
 * assignee is the person who made the change, nobody is asked. An agent or an
 * Automation acting for the assignee does ask them, since that is how work
 * comes back to its person.
 */
export function reviewRequestee(facts: ReviewTicketFacts, actor: Actor): UserId | null {
  if (facts.archived || facts.status !== "needs_review" || facts.assigneeUserId === null) {
    return null;
  }
  if (actor.kind === "person" && actor.userId === facts.assigneeUserId) return null;
  return facts.assigneeUserId;
}
