/**
 * Who started a Session, read from the durable records that know (VC-131,
 * VC-225).
 *
 * A completed Run's `automation_runs` row is the richest source: it links the
 * Session and snapshots the Automation name. Ticket Sessions also write a
 * `session_started` Ticket event whose actor records the party that asked, so
 * that event covers both `session.start` ancestry and a Ticket Run that crashes
 * after Session mint but before its Run row lands.
 *
 * `session_delegations` is not that source. It records ancestry only for a
 * Ticket Session's claimed `session.start`; a Project Session can start Ticket
 * work without a delegation, while the Ticket event is written by every Ticket
 * door. The event lookup stays scoped by Ticket so
 * `ticket_events_ticket (ticket_id, created_at)` makes it an index seek before
 * the payload comparison.
 *
 * ── PROJECT RUNS' PRE-INSERT WINDOW ───────────────────────────────────────
 * A scheduled Run creates a Project Session, which deliberately has no Ticket
 * event. The Session must still exist before `automation_runs` can reference it,
 * so a process death between those two transactions used to leave no launch
 * evidence and falsely credit a person.
 *
 * The accepted Run now projects its stable Session-create command id into
 * `automation_session_mint_intents` before mint begins. Once the Session ledger
 * commits that command, joining the two indexed ids proves an Automation
 * started the Session even if the Run projection never lands. A normal Project
 * Session has no such relation and remains person-started.
 *
 * The crash-window answers intentionally carry `automationName: null`. The
 * completed Run row is still the record that names an Automation; the fallback
 * proves only the party, which is enough to keep the bolt and Run-scoped live
 * treatment honest without guessing.
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
 * Derives one Session's provenance. The completed Run is asked first because it
 * alone can carry a name. The pre-mint relation then covers every Run's crash
 * window; only after those two Automation sources miss does a Ticket launch
 * event decide between a parent Session, an Automation from older history, and
 * a person.
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

  const pendingRun = prepared<[string], { present: number }>(
    db,
    `SELECT 1 AS present
       FROM session_commands AS command
       JOIN automation_session_mint_intents AS mint
         ON mint.session_create_command_id = command.id
      WHERE command.session_id = ?
      LIMIT 1`,
  ).get(query.sessionId);
  // The pre-Run window for a Project Session: its accepted Run marked the
  // stable create command before mint, but the projection that names the
  // Automation has not landed (and after a crash may never land).
  if (pendingRun !== undefined) return { kind: "automation", automationName: null };

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
