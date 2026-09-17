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
 * Ticket Session's claimed `session.start`; a Board Session can start Ticket
 * work without a delegation, while the Ticket event is written by every Ticket
 * door. The event lookup stays scoped by Ticket so
 * `ticket_events_ticket (ticket_id, created_at)` makes it an index seek before
 * the payload comparison.
 *
 * ── PROJECT RUNS' PRE-INSERT WINDOW ───────────────────────────────────────
 * A scheduled Run creates a Board Session, which deliberately has no Ticket
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
 *
 * ── ONE QUESTION, TWO SIZES ───────────────────────────────────────────────
 * {@link readSessionProvenances} answers a whole roster from set-based queries
 * and {@link readSessionProvenance} is that same call with a batch of one, so
 * the fetch (`data-ipc.ts`) and the push (`activity-watch.ts`) cannot come to
 * disagree about who started a Session (VC-392). Everything the precedence
 * says lives in the batch; nothing re-derives it for the single case.
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
 * Derives one Session's provenance.
 *
 * One call of {@link readSessionProvenances} rather than its own queries, so
 * there is exactly one implementation of this question in the process. The two
 * channels ask it at different sizes — the push channel answers one Session at
 * a time, the fetch answers a whole roster — and a second implementation for
 * the single case is precisely how a fetch and a push would come to disagree
 * about who started a Session. A batch of one costs what the per-Session
 * queries cost: the stages short-circuit the same way, so an Automation's
 * Session is still answered by one indexed read.
 */
export function readSessionProvenance(
  db: Database.Database,
  query: SessionProvenanceQuery,
): SessionProvenance {
  return readSessionProvenances(db, [query]).get(query.sessionId) ?? PERSON_STARTED;
}

/**
 * The same derivation over a whole roster, in a bounded number of set-based
 * queries rather than up to three per Session (VC-392).
 *
 * `volli:session-list` used to call the single reader once per row, so a
 * 60-Session roster was up to 180 synchronous statements in one unbroken block
 * immediately after a fold that deliberately yields. The stages below are the
 * same four sources in the same precedence, each asked once for every Session
 * that still needs it:
 *
 * 1. the completed Run — the only source that can carry an Automation's name;
 * 2. the pre-insert marker, for a Run that minted a Session and crashed;
 * 3. the Ticket's `session_started` event, which names the launching party;
 * 4. the parent Session's title, for the launches that name a Session.
 *
 * Stage 3 is where the batching earns most: it is an index seek on
 * `ticket_events_ticket (ticket_id, created_at)` followed by a `json_extract`
 * comparison over the Ticket's whole timeline, and the roster of a worked
 * Ticket asked for that same timeline once per Session on it. Now each Ticket
 * is read once, whatever the roster.
 *
 * A repeated `sessionId` in `queries` is answered once; the returned map is
 * keyed by Session id, and a Session has one Ticket, so no key can mean two
 * questions.
 *
 * @returns one entry per distinct queried Session id, never a missing key.
 */
export function readSessionProvenances(
  db: Database.Database,
  queries: readonly SessionProvenanceQuery[],
): Map<string, SessionProvenance> {
  const answers = new Map<string, SessionProvenance>();
  const pending = new Map<string, string | null>();
  for (const query of queries) {
    if (pending.has(query.sessionId)) continue;
    pending.set(query.sessionId, query.ticketId);
  }
  if (pending.size === 0) return answers;

  // ── 1. completed Runs ───────────────────────────────────────────────────
  for (const row of prepared<[string], { session_id: string; automation_name: string | null }>(
    db,
    `SELECT session_id, automation_name
       FROM automation_runs
      WHERE session_id IN (SELECT value FROM json_each(?))`,
  ).iterate(idList(pending.keys()))) {
    // First row wins for a Session with more than one Run row, which is what
    // the single-Session read's bare `LIMIT 1` also takes.
    if (answers.has(row.session_id)) continue;
    answers.set(row.session_id, { kind: "automation", automationName: row.automation_name });
    pending.delete(row.session_id);
  }
  if (pending.size === 0) return answers;

  // ── 2. a Run's pre-insert window ────────────────────────────────────────
  // Its accepted Run marked the stable create command before mint, but the
  // projection that names the Automation has not landed (and after a crash may
  // never land).
  for (const row of prepared<[string], { session_id: string }>(
    db,
    `SELECT command.session_id AS session_id
       FROM session_commands AS command
       JOIN automation_session_mint_intents AS mint
         ON mint.session_create_command_id = command.id
      WHERE command.session_id IN (SELECT value FROM json_each(?))`,
  ).iterate(idList(pending.keys()))) {
    if (answers.has(row.session_id)) continue;
    answers.set(row.session_id, { kind: "automation", automationName: null });
    pending.delete(row.session_id);
  }

  // Every Session left rests at a person unless a Ticket launch event says
  // otherwise, and a Board Session has no Ticket timeline to ask.
  for (const sessionId of pending.keys()) answers.set(sessionId, PERSON_STARTED);
  const ticketOf = new Map<string, string>();
  for (const [sessionId, ticketId] of pending) {
    if (ticketId !== null) ticketOf.set(sessionId, ticketId);
  }
  if (ticketOf.size === 0) return answers;

  // ── 3. the Ticket's launch event ────────────────────────────────────────
  // Scoped by Ticket for the same reason the single read is: the index makes
  // it a seek per Ticket, and the payload comparison then runs over that
  // Ticket's events rather than the table.
  const parentOf = new Map<string, string>();
  const tickets = new Set(ticketOf.values());
  for (const row of prepared<[string], { ticket_id: string; session_id: string; actor: string }>(
    db,
    `SELECT ticket_id, json_extract(payload, '$.sessionId') AS session_id, actor
       FROM ticket_events
      WHERE ticket_id IN (SELECT value FROM json_each(?))
        AND kind = 'session_started'`,
  ).iterate(idList(tickets))) {
    const sessionId = row.session_id;
    if (typeof sessionId !== "string") continue;
    // Only the Sessions this roster asked about, and only the first event for
    // each — the single read's `LIMIT 1` inside the same Ticket scope.
    if (ticketOf.get(sessionId) !== row.ticket_id) continue;
    ticketOf.delete(sessionId);
    const launcher = launchActorOf(row.actor);
    if (launcher === null) continue;
    // The pre-Run window: the launch says an Automation, and the record that
    // would name it is not there (or never will be). The bolt still draws.
    if (launcher.kind === "automation") {
      answers.set(sessionId, { kind: "automation", automationName: null });
      continue;
    }
    parentOf.set(sessionId, launcher.sessionId);
  }
  if (parentOf.size === 0) return answers;

  // ── 4. the parent Sessions' titles ──────────────────────────────────────
  const titleOf = new Map<string, string | null>();
  for (const row of prepared<[string], { id: string; title: string | null }>(
    db,
    "SELECT id, title FROM sessions WHERE id IN (SELECT value FROM json_each(?))",
  ).iterate(idList(new Set(parentOf.values())))) {
    titleOf.set(row.id, row.title);
  }
  for (const [sessionId, parentSessionId] of parentOf) {
    // A parent whose row is gone still leaves an honest mark: the tooltip says
    // no person opened this Session, which is the half that survives the
    // deletion.
    answers.set(sessionId, {
      kind: "session",
      parentSessionId,
      parentTitle: titleOf.get(parentSessionId) ?? null,
    });
  }
  return answers;
}

/**
 * The set of ids a stage asks about, as the one bound parameter of its query.
 *
 * A JSON array through `json_each` rather than a generated `IN (?,?,?)`: the
 * SQL text is then the same for every roster size, so `prepared`'s per-handle
 * cache holds one statement per stage instead of one per arity, and no roster
 * can reach SQLite's bound-parameter limit. The plan is unchanged — each value
 * is still an index seek (`SEARCH ... USING INDEX`), driven from the list.
 */
function idList(ids: Iterable<string>): string {
  return JSON.stringify([...ids]);
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
