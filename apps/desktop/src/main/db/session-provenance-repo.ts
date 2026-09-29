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
 *
 * Neither channel names a port type. There was one here — an unused
 * `SessionProvenanceReader` interface whose comment claimed both channels
 * spoke through it — and it had no caller on any branch. It is gone rather
 * than left describing a door nobody walks through; the two exported functions
 * below are the whole surface.
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
 * A roster's answers, as a total function of Session id.
 *
 * A function rather than the `Map` it closes over, for two reasons. Its
 * callers — `sessionListingRows`' `provenanceOf`, and the single reader below
 * — want exactly this shape, so neither has to write a `?? PERSON_STARTED`
 * that can never run; and the `Map` then never leaves this module, which is
 * what `docs/BOUNDARIES.md` rule 3 asks of a value an HTTP transport would
 * mangle.
 *
 * A Session the batch was never asked about answers {@link PERSON_STARTED},
 * which is the same resting answer a Session with no evidence gets. That is a
 * defined answer rather than a fallback: nothing can be said, so the mark says
 * nothing.
 */
export type SessionProvenanceLookup = (sessionId: string) => SessionProvenance;

/**
 * Derives one Session's provenance.
 *
 * One call of {@link readSessionProvenances} rather than its own queries, so
 * there is exactly one implementation of this question in the process. The two
 * channels ask it at different sizes — the push channel answers one Session at
 * a time, the fetch answers a whole roster — and a second implementation for
 * the single case is precisely how a fetch and a push would come to disagree
 * about who started a Session.
 *
 * A batch of one is the same order of work as the per-Session queries it
 * replaced, but not the same work: stages 1, 2, 4 and 5 are still single
 * indexed seeks, while stage 3 reads every launch event on the Ticket instead
 * of stopping at the matching one, because the batch picks its winner in
 * memory rather than with `LIMIT 1` (see {@link readSessionProvenances}). On a
 * Ticket with 5,000 events and 40 launches that measured 0.33 ms flat against
 * 0.001–0.70 ms for the old read, depending on where the Session's own launch
 * event sat — the same on average, with the early rows no longer free.
 */
export function readSessionProvenance(
  db: Database.Database,
  query: SessionProvenanceQuery,
): SessionProvenance {
  return readSessionProvenances(db, [query])(query.sessionId);
}

/**
 * The same derivation over a whole roster, in a bounded number of set-based
 * queries rather than up to three per Session (VC-392).
 *
 * `volli:session-list` used to call the single reader once per row, so a
 * 60-Session roster was up to 180 synchronous statements in one unbroken block
 * immediately after a fold that deliberately yields. The stages below are the
 * same sources in the same precedence, each asked once for every Session that
 * still needs it:
 *
 * 1. the completed Run — the only source that can carry an Automation's name;
 * 2. the pre-insert marker, for a Run that minted a Session and crashed;
 * 3. the Ticket's `session_started` event, which names the launching party;
 * 4. the parent Session's stored title, for the launches that name a Session;
 * 5. that parent's retitles, because the stored title is only its first one.
 *
 * Stage 3 is where the batching earns most: it is an index seek on
 * `ticket_events_ticket (ticket_id, created_at)` followed by a `json_extract`
 * over the Ticket's launch events, and the roster of a worked Ticket asked for
 * that same timeline once per Session on it. Now each Ticket is read once,
 * whatever the roster.
 *
 * WHICH ROW WINS is decided here rather than by `LIMIT 1`, and decided
 * explicitly. The queries carry no `ORDER BY` — adding one would sort a result
 * the index already delivers in the useful order — so a tie is broken on
 * `(created_at, id)` in memory instead. The reader this replaced left the
 * choice to whatever row SQLite happened to return first, which was stable in
 * practice and undefined on paper; the earliest record is now the answer by
 * construction, because the question is who STARTED a Session.
 *
 * A repeated `sessionId` in `queries` is answered once. A Session has one
 * Ticket, so a repeat cannot mean two questions; the first `ticketId` given for
 * an id is the one used.
 */
export function readSessionProvenances(
  db: Database.Database,
  queries: readonly SessionProvenanceQuery[],
): SessionProvenanceLookup {
  const answers = new Map<string, SessionProvenance>();
  const lookup: SessionProvenanceLookup = (sessionId) => answers.get(sessionId) ?? PERSON_STARTED;
  const pending = new Map<string, string | null>();
  for (const query of queries) {
    if (pending.has(query.sessionId)) continue;
    pending.set(query.sessionId, query.ticketId);
  }
  if (pending.size === 0) return lookup;

  // ── 1. completed Runs ───────────────────────────────────────────────────
  // `automation_runs.session_id` is not unique, so a Session can carry more
  // than one Run row; the earliest is the one that started it.
  const runOf = new Map<string, Ranked<{ automationName: string | null }>>();
  for (const row of prepared<
    [string],
    { session_id: string; automation_name: string | null; created_at: number; id: string }
  >(
    db,
    `SELECT session_id, automation_name, created_at, id
       FROM automation_runs
      WHERE session_id IN (SELECT value FROM json_each(?))`,
  ).iterate(idList(pending.keys()))) {
    keepEarliest(runOf, row.session_id, row, { automationName: row.automation_name });
  }
  for (const [sessionId, run] of runOf) {
    answers.set(sessionId, { kind: "automation", automationName: run.value.automationName });
    pending.delete(sessionId);
  }
  if (pending.size === 0) return lookup;

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
    // Any marker proves the party; there is nothing to rank, because the
    // answer carries no name to choose between.
    if (!pending.has(row.session_id)) continue;
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
  if (ticketOf.size === 0) return lookup;

  // ── 3. the Ticket's launch event ────────────────────────────────────────
  // Scoped by Ticket for the same reason the single read is: the index makes
  // it a seek per Ticket, and the payload comparison then runs over that
  // Ticket's events rather than the table.
  const launchOf = new Map<string, Ranked<{ actor: string }>>();
  const tickets = new Set(ticketOf.values());
  for (const row of prepared<
    [string],
    // `json_extract` answers with whatever the payload holds, including `null`
    // for a launch event this build cannot read. The column is therefore
    // `unknown` and narrowed below rather than asserted to be a string.
    { ticket_id: string; session_id: unknown; actor: string; created_at: number; id: string }
  >(
    db,
    `SELECT ticket_id, json_extract(payload, '$.sessionId') AS session_id, actor, created_at, id
       FROM ticket_events
      WHERE ticket_id IN (SELECT value FROM json_each(?))
        AND kind = 'session_started'`,
  ).iterate(idList(tickets))) {
    const sessionId = row.session_id;
    if (typeof sessionId !== "string") continue;
    // A launch event speaks only for the Session it names ON THE TICKET IT WAS
    // RECORDED ON. Matching the payload alone would let an event on one Ticket
    // answer for a Session sitting on another.
    if (ticketOf.get(sessionId) !== row.ticket_id) continue;
    keepEarliest(launchOf, sessionId, row, { actor: row.actor });
  }
  const parentOf = new Map<string, string>();
  for (const [sessionId, launch] of launchOf) {
    const launcher = launchActorOf(launch.value.actor);
    if (launcher === null) continue;
    // The pre-Run window: the launch says an Automation, and the record that
    // would name it is not there (or never will be). The bolt still draws.
    if (launcher.kind === "automation") {
      answers.set(sessionId, { kind: "automation", automationName: null });
      continue;
    }
    parentOf.set(sessionId, launcher.sessionId);
  }
  if (parentOf.size === 0) return lookup;

  // ── 4 & 5. the parent Sessions' titles, as they read NOW ──────────────────
  // `sessions.title` is the fold's SEED, not its answer: the row is written
  // once at mint and a rename is a `session.retitled` fact on the Session's own
  // ledger (`foldSession` in `@volli/shared` sets `title` from each one). A
  // parent read from the row alone therefore kept the name it was born with,
  // while the same listing drew that parent under its current one. Stage 5
  // replays the same rule the fold does, for the parents only.
  const parents = new Set(parentOf.values());
  const titleOf = new Map<string, string | null>();
  for (const row of prepared<[string], { id: string; title: string | null }>(
    db,
    "SELECT id, title FROM sessions WHERE id IN (SELECT value FROM json_each(?))",
  ).iterate(idList(parents))) {
    titleOf.set(row.id, row.title);
  }
  // `session_event_sequence (session_id, kind, sequence)` makes this a seek per
  // parent, and a parent has a handful of renames at most. Ordering is the
  // Session's OWN `sequence` — local order within one Session, which is what
  // `docs/BOUNDARIES.md` rule 2 permits a reducer to depend on.
  const latestRename = new Map<string, { sequence: number; title: string | null }>();
  for (const row of prepared<
    [string],
    { session_id: string; sequence: number; title: string | null }
  >(
    db,
    `SELECT event.session_id AS session_id, event.sequence AS sequence,
            json_extract(event.payload, '$.title') AS title
       FROM session_event_sequence AS kinds
       JOIN session_events AS event ON event.id = kinds.event_id
      WHERE kinds.session_id IN (SELECT value FROM json_each(?))
        AND kinds.kind = 'session.retitled'`,
  ).iterate(idList(parents))) {
    // The LAST rename is the current name, so this keeps the highest sequence
    // rather than the lowest — the opposite of every other stage here.
    const held = latestRename.get(row.session_id);
    if (held !== undefined && row.sequence <= held.sequence) continue;
    latestRename.set(row.session_id, { sequence: row.sequence, title: row.title });
  }
  for (const [sessionId, parentSessionId] of parentOf) {
    const renamed = latestRename.get(parentSessionId);
    // `null` is a real projected title — a rename to nothing — so a rename wins
    // whenever there is one, and `??` here would wrongly restore the seed.
    // A parent whose row is gone still leaves an honest mark: the tooltip says
    // no person opened this Session, which is the half that survives the
    // deletion.
    answers.set(sessionId, {
      kind: "session",
      parentSessionId,
      parentTitle: renamed !== undefined ? renamed.title : (titleOf.get(parentSessionId) ?? null),
    });
  }
  return lookup;
}

/** A candidate row plus the `(created_at, id)` pair that ranks it. */
interface Ranked<Value> {
  createdAt: number;
  id: string;
  value: Value;
}

/**
 * Holds the earliest row seen for a key, breaking a same-millisecond tie on the
 * row's own id so the winner never depends on the order SQLite returned.
 */
function keepEarliest<Value>(
  held: Map<string, Ranked<Value>>,
  key: string,
  row: { created_at: number; id: string },
  value: Value,
): void {
  const previous = held.get(key);
  if (
    previous !== undefined &&
    (previous.createdAt < row.created_at ||
      (previous.createdAt === row.created_at && previous.id <= row.id))
  ) {
    return;
  }
  held.set(key, { createdAt: row.created_at, id: row.id, value });
}

/**
 * The set of ids a stage asks about, as the one bound parameter of its query.
 *
 * A JSON array through `json_each` rather than a generated `IN (?,?,?)`: the
 * SQL text is then the same for every roster size, so `prepared`'s per-handle
 * cache holds one statement per stage instead of one per arity, and no roster
 * can reach SQLite's bound-parameter limit. The same idiom, for the same
 * reason, is in `tickets-repo.ts` and `sequence-cursor.ts`. `EXPLAIN QUERY
 * PLAN` reports each stage as `SEARCH ... USING INDEX` driven from the list.
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
