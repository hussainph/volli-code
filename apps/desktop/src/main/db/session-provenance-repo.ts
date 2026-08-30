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
 *
 * ── THE EVENT DECIDES THE PARTY; THE RUN RECORD ONLY NAMES IT ─────────────
 * The two records do not land together, and they cannot be made to: `run.ts`
 * creates the Session (durably, with its `session_started` event) and only THEN
 * asks the Automations ledger to complete the Run, which is the write that
 * inserts `automation_runs`. They are two ledgers with two transactions, and
 * `automation_runs.session_id` is a foreign key to a Session that must already
 * exist — so no reordering closes the gap between them.
 *
 * A crash, or a startup recovery that does not finish, therefore leaves a real
 * window in which a Run's Session exists with no Run row pointing at it. **The
 * `session_started` actor is what closes it.** Every Session start records that
 * actor, `run.ts` passes `{ kind: "automation" }`, and a party is a durable
 * fact of the launch rather than of the bookkeeping that followed it. Reading
 * the Run row alone would answer `user` for such a Session — the one wrong
 * answer this feature can give, because it takes away both the bolt and the
 * board's Run-scoped live ring and says a person did this.
 *
 * What the window does cost is the NAME: nothing that survives the crash ties
 * this Session to which Automation ran. `AutomationRunPlan` holds the name and
 * is durable first, but it is keyed by the Session OPERATION id, and joining it
 * would mean rebuilding `sessionCreateCommandId`'s string in SQL and scanning
 * the Automations event log for every unmarked row — real coupling and an
 * unindexed scan, to name a case that only a crash produces. The mark says
 * "an Automation started this" and declines to guess which; see
 * `SessionProvenance.automationName`.
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
 * bolt that could not say what started the work. It is asked first, and it is
 * not required — the event answers for the rows it cannot reach.
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

  const launcher = launchActorOf(started.actor);
  if (launcher === null) return PERSON_STARTED;
  // The pre-Run window: the launch says an Automation, and the record that
  // would name it is not there (or never will be). The bolt still draws.
  if (launcher.kind === "automation") return { kind: "automation", automationName: null };
  const parentSessionId = launcher.sessionId;
  const parent = prepared<[string], { title: string | null }>(
    db,
    "SELECT title FROM sessions WHERE id = ? LIMIT 1",
  ).get(parentSessionId);
  // A parent whose row is gone still leaves an honest mark: the tooltip says no
  // person opened this Session, which is the half that survives the deletion.
  return { kind: "session", parentSessionId, parentTitle: parent?.title ?? null };
}

/** The two parties a launch actor can name, once everything else is `null`. */
type LaunchActor = { kind: "automation" } | { kind: "session"; sessionId: string };

/**
 * Which of the two non-resting parties a stored actor names, or `null` for one
 * that names neither.
 *
 * Read here rather than through `events-repo`'s `parseActor` because that one
 * answers a different question — it maps a row to a whole {@link TicketEvent},
 * and its documented asymmetry is that an unreadable token degrades to `user`.
 * Borrowing that here would put the degradation on the wrong side of THIS
 * question: an unreadable token means "nothing can be said", and this module
 * says nothing by returning `null`, which the caller draws as the resting case.
 * `unauthenticated` is `null` for the reason `SessionProvenance` gives — it
 * names nobody, so there is nothing for a mark to say.
 *
 * Both spellings of an `automation` actor land on the same answer, because
 * `serializeActor` writes the context-less one as a bare token and the
 * session-driven one as JSON. A Run passes `{ kind: "automation" }` and so
 * takes the bare-token path; reading only the JSON one is how this whole arm
 * was invisible.
 */
function launchActorOf(actor: string): LaunchActor | null {
  // Every actor that carries context is stored as JSON (`serializeActor`), so a
  // string that cannot start one is answered without paying for a parse — which
  // is the common case, because `user` is the actor on most rows.
  if (!actor.startsWith("{")) return actor === "automation" ? { kind: "automation" } : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(actor);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { kind?: unknown; sessionId?: unknown };
  if (candidate.kind === "automation") return { kind: "automation" };
  if (candidate.kind !== "session" || typeof candidate.sessionId !== "string") return null;
  return { kind: "session", sessionId: candidate.sessionId };
}

/** {@link readSessionProvenance} bound to one database handle. */
export function createSessionProvenanceReader(db: Database.Database): SessionProvenanceReader {
  return { read: (query) => readSessionProvenance(db, query) };
}
