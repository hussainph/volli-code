/**
 * Ticket comments (`ticket_comments` table, migration 003): the ticket's
 * work log — human orchestrator notes and agent session summaries — as
 * content, distinct from the append-only audit trail in `ticket-events.ts`
 * (comments are content, events are audit; every comment also fires a
 * `commented` event so it's discoverable from the event log without
 * duplicating its body there). `sessionId` links an agent-posted session
 * summary back to its {@link SessionRecord}.
 */

import { HARNESS_IDS } from "./ticket";
import type { HarnessId } from "./ticket";

/** A ticket comment: work-log content, not an audit event. */
export interface TicketComment {
  id: string;
  ticketId: string;
  /** Links an agent-posted session summary back to its session; `null` for user comments. */
  sessionId: string | null;
  /** {@link USER_ACTOR} or an {@link agentActor} string. */
  actor: string;
  /** Markdown. */
  body: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
}

/** The actor value for a human-authored comment/event. */
export const USER_ACTOR = "user";

const AGENT_ACTOR_PREFIX = "agent:";

/** Builds the actor value for a comment/event authored by a given harness (`"agent:<harnessId>"`). */
export function agentActor(harnessId: HarnessId): string {
  return `${AGENT_ACTOR_PREFIX}${harnessId}`;
}

/** Whether `actor` is an {@link agentActor} string, as opposed to {@link USER_ACTOR} or an unknown value. */
export function isAgentActor(actor: string): boolean {
  return actor.startsWith(AGENT_ACTOR_PREFIX);
}

/** The harness id encoded in an {@link agentActor} string, or `null` for {@link USER_ACTOR}/unknown actors. */
export function actorHarnessId(actor: string): HarnessId | null {
  if (!isAgentActor(actor)) return null;
  const harnessId = actor.slice(AGENT_ACTOR_PREFIX.length);
  return (HARNESS_IDS as readonly string[]).includes(harnessId) ? (harnessId as HarnessId) : null;
}
