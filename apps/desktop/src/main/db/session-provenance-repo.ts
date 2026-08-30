/**
 * Who started a Session, read out of the records that already know (VC-131).
 *
 * **Nothing new is written for this.** Both facts have been durable since
 * VC-126: a Run stores its Session id and the bound Automation's name at launch
 * in `automation_runs`, and every Session start records a `session_started`
 * ticket event whose ACTOR is the party that asked (`recordSessionStartedOnce`,
 * with the actor each door derived — VC-13 decision 3). So provenance is a
 * projection over existing history rather than a fourth place for the same
 * truth to be stored and drift.
 *
 * ── WHY THE TICKET EVENT, AND NOT `session_delegations` ───────────────────
 * The delegation table looks like the obvious source for "which Session started
 * this one" and it is not: it records ancestry only for a TICKET Session's
 * claimed `session.start`, because that is the grant it exists to bound. A
 * Project Session starting work on a Ticket passes no delegation at all
 * (`agent-tool-door.ts` sets it only when `session.role === "ticket"`), so its
 * children have `parent_session_id IS NULL` there — and an orchestrator's
 * fan-out is exactly the case this mark is for. The `session_started` actor is
 * written by every door, which is the property that makes it the source.
 *
 * ── WHY IT IS SCOPED BY TICKET, AND WHY THAT COSTS NO MIGRATION ───────────
 * The event's payload names the started Session, so the natural lookup is by a
 * JSON extraction — which alone is a full scan of a log that grows for as long
 * as a project is worked. The Session's own `ticketId` is what makes it an
 * index seek instead: `ticket_events_ticket (ticket_id, created_at)` already
 * exists, a ticket holds tens of events, and `recordSessionStartedOnce` scopes
 * its own idempotence read exactly this way. No expression index and no
 * migration — which also keeps this ticket's schema footprint at zero while
 * VC-130 is adding its own migration in parallel.
 *
 * A ticketless Session therefore reads as person-started, and that is correct
 * rather than a gap: `mint` records no planner event for one (planner history
 * is Ticket history), and neither door that can start a Session on someone's
 * behalf can produce one — a Run's Target is always a Ticket, and the
 * `session.start` tool refuses a request that names none.
 */
import type Database from "better-sqlite3";
import { PERSON_STARTED, type SessionProvenance } from "@volli/shared";

import { prepared } from "./prepared";

/** The Session this answer is about — identity plus the Ticket that scopes the read. */
export interface SessionProvenanceQuery {
  sessionId: string;
  ticketId: string | null;
}

/**
 * How a listing asks. An interface rather than a bare function type so the two
 * callers — the fetch in `data-ipc.ts` and the push in `activity-watch.ts` —
 * name the same port, and so a test can hand in a stub with no database.
 */
export interface SessionProvenanceReader {
  read(query: SessionProvenanceQuery): SessionProvenance;
}

/**
 * Derives one Session's provenance. The Automation record is asked first
 * because it is the only one of the two that can carry a NAME: a Run also
 * writes a `session_started` event, with the `automation` actor and no room in
 * it for which Automation ran, so consulting the event first would produce a
 * bolt that could not say what started the work.
 */
export function readSessionProvenance(
  db: Database.Database,
  query: SessionProvenanceQuery,
): SessionProvenance {
  const run = prepared<[string], { automation_name: string | null }>(
    db,
    "SELECT automation_name FROM automation_runs WHERE session_id = ? LIMIT 1",
  ).get(query.sessionId);
  if (run !== undefined) return { kind: "automation", automationName: run.automation_name };

  if (query.ticketId === null) return PERSON_STARTED;
  const started = prepared<[string, string], { actor: string }>(
    db,
    `SELECT actor FROM ticket_events
      WHERE ticket_id = ?
        AND kind = 'session_started'
        AND json_extract(payload, '$.sessionId') = ?
      LIMIT 1`,
  ).get(query.ticketId, query.sessionId);
  if (started === undefined) return PERSON_STARTED;

  const parentSessionId = parentOf(started.actor);
  if (parentSessionId === null) return PERSON_STARTED;
  const parent = prepared<[string], { title: string | null }>(
    db,
    "SELECT title FROM sessions WHERE id = ? LIMIT 1",
  ).get(parentSessionId);
  // A parent whose row is gone still leaves an honest mark: the tooltip says no
  // person opened this Session, which is the half that survives the deletion.
  return { kind: "session", parentSessionId, parentTitle: parent?.title ?? null };
}

/**
 * The parent Session id inside a stored actor, or `null` for every actor that
 * is not a Session.
 *
 * Read here rather than through `events-repo`'s `parseActor` because that one
 * answers a different question — it maps a row to a whole {@link TicketEvent},
 * and its documented asymmetry is that an unreadable token degrades to `user`.
 * This asks only "is there a Session id in here", so an unreadable token, a
 * bare token, and a JSON actor of another kind all answer the same `null`
 * without borrowing that degradation rule.
 */
function parentOf(actor: string): string | null {
  // Every actor that carries context is stored as JSON (`serializeActor`), so a
  // string that cannot start one is answered without paying for a parse — which
  // is the common case, because `user` is the actor on most rows.
  if (!actor.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(actor);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { kind?: unknown; sessionId?: unknown };
  if (candidate.kind !== "session" || typeof candidate.sessionId !== "string") return null;
  return candidate.sessionId;
}

/** {@link readSessionProvenance} bound to one database handle. */
export function createSessionProvenanceReader(db: Database.Database): SessionProvenanceReader {
  return { read: (query) => readSessionProvenance(db, query) };
}
