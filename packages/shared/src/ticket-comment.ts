/**
 * Ticket comments (`ticket_comments` table, migration 003): the ticket's
 * work log — human orchestrator notes and agent session summaries — as
 * content, distinct from the append-only audit trail in `ticket-events.ts`
 * (comments are content, events are audit; every comment also fires a
 * `commented` event so it's discoverable from the event log without
 * duplicating its body there). `sessionId` links an agent-posted session
 * summary back to its {@link SessionRecord}.
 */

import { FIRST_CLASS_HARNESS_IDS } from "./ticket";
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

/**
 * The actor value for a comment written by a socket caller Volli could not
 * identify (VC-163).
 *
 * Named here beside {@link USER_ACTOR} because this column is a bare `string`
 * and every reader of it has to compare against a literal. Two independent
 * spellings of one durable value is how a row ends up rendering as its own enum
 * token in one place and as a person in another — and for THIS value, being
 * mistaken for a person is the exact attribution VC-92 §6 ruled dead.
 *
 * Matches `TicketEventActor`'s `unauthenticated` kind, which is what the socket
 * door stamps a granted anonymous write with.
 */
export const UNAUTHENTICATED_ACTOR = "unauthenticated";

/** The actor-string prefix marking an {@link agentActor} value (`"agent:<harnessId>"`). */
export const AGENT_ACTOR_PREFIX = "agent:";

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
  return (FIRST_CLASS_HARNESS_IDS as readonly string[]).includes(harnessId)
    ? (harnessId as HarnessId)
    : null;
}
