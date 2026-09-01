/**
 * Automation projections (migration 026): row↔domain mapping for
 * Automations V1's durable record (VC-112, tracer VC-126).
 *
 * Product writes now enter through the Automation command ledger. This module
 * remains the projection reader (and supplies narrowly-scoped write helpers to
 * that ledger), so IPC and renderer-facing services never mutate/query SQLite
 * directly.
 *
 * A stored invalid Runtime is deliberately not coerced to inheritance: SQL
 * NULL is inherit, while a malformed/future payload remains an explicit
 * `InvalidAutomationRuntime`. Run reasoning is likewise preserved verbatim —
 * historical evidence is not rewritten to today's vocabulary.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  isTicketStatus,
  NO_AUTOMATION_TRIGGER,
  parseAutomationRunAttendance,
  parseAutomationSkipReason,
  parseAutomationTrigger,
  parseSessionModel,
} from "@volli/shared";
import type {
  Automation,
  AutomationRun,
  AutomationRunAttendance,
  AutomationRuntime,
  AutomationSkippedOccurrence,
  AutomationTrigger,
  ColumnArming,
  ColumnAutomationOrder,
  ModelSelection,
  ResolvedAutomationModel,
  TicketStatus,
} from "@volli/shared";
import { prepared } from "./prepared";

interface AutomationRow {
  id: string;
  project_id: string | null;
  name: string;
  instructions: string;
  trigger_spec: string | null;
  runtime: string | null;
  row_version: number;
  created_at: number;
  updated_at: number;
}

interface ColumnArmingRow {
  project_id: string;
  status: string;
  automation_id: string;
  armed_at: number;
}

interface ColumnOrderRow {
  project_id: string;
  status: string;
  ranked_ids: string;
  ordered_at: number;
}

interface AutomationRunRow {
  id: string;
  automation_id: string | null;
  automation_name: string | null;
  ticket_id: string | null;
  session_id: string;
  provider_id: string;
  model_id: string;
  reasoning_level: string;
  /** `null` for a Run recorded before VC-133 — read as `attended`. */
  attendance: string | null;
  created_at: number;
}

interface AutomationSkipRow {
  id: string;
  automation_id: string;
  automation_name: string;
  project_id: string;
  due_at: number;
  missed_count: number;
  reason: string;
  recorded_at: number;
}

function parseJsonColumn(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // A legacy/hand-edited row may predate the JSON CHECK. Preserve the exact
    // bytes as the invalid value rather than turning a pin into inheritance.
    return value;
  }
}

function parseAutomationRuntime(value: string | null): AutomationRuntime {
  if (value === null) return null;
  const raw = parseJsonColumn(value);
  return parseSessionModel(raw) ?? { kind: "invalid", raw };
}

/**
 * A stored Trigger, or "Nothing else" for SQL NULL and for anything unreadable.
 *
 * Note the deliberate asymmetry with the Runtime above: an unreadable Runtime
 * becomes an explicit invalid value because coercing it to NULL would still
 * RUN, under a policy nobody chose. An unreadable Trigger can only ever cost a
 * Run that would have started on its own, and the Automation stays runnable by
 * hand — so degrading is the safe direction and the shared parser owns it.
 */
function readTrigger(value: string | null): AutomationTrigger {
  return value === null ? NO_AUTOMATION_TRIGGER : parseAutomationTrigger(parseJsonColumn(value));
}

/**
 * `null` for "Nothing else", so an untriggered record stores SQL NULL rather
 * than a shape. Exported because the ledger projects the same column and the
 * two writers must not drift on what an absent Trigger looks like on disk.
 */
export function triggerColumnValue(trigger: AutomationTrigger): string | null {
  return trigger.kind === "none" ? null : JSON.stringify(trigger);
}

function mapAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    instructions: row.instructions,
    trigger: readTrigger(row.trigger_spec),
    runtime: parseAutomationRuntime(row.runtime),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    automationName: row.automation_name,
    ticketId: row.ticket_id,
    sessionId: row.session_id,
    model: {
      providerId: row.provider_id,
      modelId: row.model_id,
      // This is immutable evidence. A current build may not understand a
      // provider's historical level, but it must never invent "medium".
      reasoningLevel: row.reasoning_level,
    },
    // Tolerant on read, like the reasoning level above it and for a related
    // reason: a row older than VC-133 records nothing here, and the degrade
    // direction is silence rather than a notification about work nobody is
    // waiting on (`AUTOMATION_RUN_ATTENDANCE`).
    attendance: parseAutomationRunAttendance(row.attendance),
    createdAt: row.created_at,
  };
}

/**
 * The Automations one project's surfaces list: its own plus every global one,
 * name-ordered within each Ownership, globals last (a project's own tools are
 * the specific answer; the everywhere set is the fallback shelf).
 */
export function listAutomationsForProject(db: Database.Database, projectId: string): Automation[] {
  const rows = prepared<[string], AutomationRow>(
    db,
    `SELECT * FROM automations
      WHERE project_id = ? OR project_id IS NULL
      ORDER BY project_id IS NULL, name, id`,
  ).all(projectId);
  return rows.map(mapAutomation);
}

export function getAutomation(db: Database.Database, id: string): Automation | undefined {
  const row = prepared<[string], AutomationRow>(db, "SELECT * FROM automations WHERE id = ?").get(
    id,
  );
  return row ? mapAutomation(row) : undefined;
}

/**
 * Every Automation on this machine, in no project's order (VC-130).
 *
 * The scheduler's own read, and the one place a project-blind list is right:
 * a timer serves every project at once, and asking per project would make the
 * set of schedules a function of which projects a window happens to have open.
 * Filtering to the ones that carry a schedule is the caller's, because the
 * Trigger is a JSON value rather than a column to index.
 */
export function listAllAutomations(db: Database.Database): Automation[] {
  const rows = prepared<[], AutomationRow>(
    db,
    "SELECT * FROM automations ORDER BY created_at, id",
  ).all();
  return rows.map(mapAutomation);
}

export interface AutomationWrite {
  /** `null` is global Ownership. */
  projectId: string | null;
  name: string;
  instructions: string;
  /** Which columns offer this Automation — the record's half of VC-128. */
  trigger: AutomationTrigger;
  runtime: ModelSelection | null;
}

export function createAutomation(
  db: Database.Database,
  input: AutomationWrite,
  now: number,
): Automation {
  const id = randomUUID();
  prepared(
    db,
    `INSERT INTO automations (id, project_id, name, instructions, trigger_spec, runtime, row_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.name,
    input.instructions,
    triggerColumnValue(input.trigger),
    input.runtime === null ? null : JSON.stringify(input.runtime),
    now,
    now,
  );
  return getAutomation(db, id)!;
}

/** Rewrites the editable fields whole. Ownership is identity here: no move between scopes. */
export function updateAutomation(
  db: Database.Database,
  id: string,
  input: Omit<AutomationWrite, "projectId">,
  now: number,
): Automation | undefined {
  const changed = prepared(
    db,
    `UPDATE automations
        SET name = ?, instructions = ?, trigger_spec = ?, runtime = ?,
            row_version = row_version + 1, updated_at = ?
      WHERE id = ?`,
  ).run(
    input.name,
    input.instructions,
    triggerColumnValue(input.trigger),
    input.runtime === null ? null : JSON.stringify(input.runtime),
    now,
    id,
  );
  if (changed.changes === 0) return undefined;
  return getAutomation(db, id);
}

/** A record delete (VC-112, "One-time work"): Run projections retain their Automation id/name snapshot. */
export function deleteAutomation(db: Database.Database, id: string): boolean {
  return prepared(db, "DELETE FROM automations WHERE id = ?").run(id).changes > 0;
}

export interface AutomationRunWrite {
  /** `null` is an Unbound Run (VC-129) — admitted by the schema from day one. */
  automationId: string | null;
  /** Snapshot at launch; omitted only by legacy test/support callers. */
  automationName?: string | null;
  /** `null` is a Run that named no Ticket — a schedule's project Target (VC-130). */
  ticketId: string | null;
  sessionId: string;
  /** The RESOLVED selection the Session was born with, never the reference. */
  model: ResolvedAutomationModel;
  /**
   * Whether a person was at the door that asked (VC-133). Optional only for the
   * legacy test/support callers `automationName` is optional for; absent is the
   * silent answer, never a guess.
   */
  attendance?: AutomationRunAttendance;
}

export function recordAutomationRun(
  db: Database.Database,
  input: AutomationRunWrite,
  now: number,
): AutomationRun {
  const id = randomUUID();
  const automationName =
    input.automationId === null
      ? null
      : (input.automationName ??
        getAutomation(db, input.automationId)?.name ??
        "Deleted Automation");
  const attendance = parseAutomationRunAttendance(input.attendance);
  prepared(
    db,
    `INSERT INTO automation_runs
      (id, automation_id, automation_name, ticket_id, session_id, provider_id, model_id, reasoning_level, attendance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.automationId,
    automationName,
    input.ticketId,
    input.sessionId,
    input.model.providerId,
    input.model.modelId,
    input.model.reasoningLevel,
    attendance,
    now,
  );
  return {
    id,
    automationId: input.automationId,
    automationName,
    ticketId: input.ticketId,
    sessionId: input.sessionId,
    model: input.model,
    attendance,
    createdAt: now,
  };
}

/**
 * Whether the Run that opened this Session was unattended (VC-133), or `null`
 * when no Run owns it.
 *
 * Its own narrow read rather than a field on `SessionProvenance`, because the
 * two answer different questions for different audiences: provenance is drawn
 * on screen for a person reading a list, while this decides whether to
 * interrupt one. Widening the provenance row would put attendance on every
 * listing row that crosses the IPC seam — traffic and surface area for a fact
 * no surface renders.
 *
 * `null` covers both "a person opened this chat" and VC-131's pre-Run crash
 * window, where a Session is provably a Run's but its `automation_runs` row
 * never landed. Both read as "do not notify", which is the same conservative
 * direction the column's own absent value takes.
 *
 * `idx_automation_runs_session` already indexes this lookup (VC-126).
 */
export function readAutomationRunAttendance(
  db: Database.Database,
  sessionId: string,
): AutomationRunAttendance | null {
  const row = prepared<[string], { attendance: string | null }>(
    db,
    "SELECT attendance FROM automation_runs WHERE session_id = ? LIMIT 1",
  ).get(sessionId);
  return row === undefined ? null : parseAutomationRunAttendance(row.attendance);
}

/** One Run projection by durable id. */
export function getAutomationRun(db: Database.Database, id: string): AutomationRun | undefined {
  const row = prepared<[string], AutomationRunRow>(
    db,
    "SELECT * FROM automation_runs WHERE id = ?",
  ).get(id);
  return row === undefined ? undefined : mapRun(row);
}

/** This Ticket's Runs, newest first — the rail's history and the palette's context. */
export function listRunsForTicket(db: Database.Database, ticketId: string): AutomationRun[] {
  const rows = prepared<[string], AutomationRunRow>(
    db,
    "SELECT * FROM automation_runs WHERE ticket_id = ? ORDER BY created_at DESC, id DESC",
  ).all(ticketId);
  return rows.map(mapRun);
}

/**
 * Every Run in one project, newest first — the Automations page's Run history
 * (VC-127).
 *
 * The scope comes from the Run's OWN durable evidence: the Session it opened,
 * whose `project_id` is `NOT NULL` and was written when the Run was recorded.
 * Not through the Automation — a global Automation is listable in every
 * project, but a Run it produced happened in ONE of them, and listing it in a
 * second project's history would be a door into work done elsewhere.
 *
 * Deliberately not an inner join on live Tickets either. `automation_runs`
 * orphans `ticket_id` exactly as `sessions.ticket_id` does, so a Ticket delete
 * would erase a Run from every project's history while its Session, its
 * resolved model and its first message all survive — history that quietly
 * disappears is worse than history that names something gone. The same
 * evidence is what lets a Run that names no Ticket at all (VC-112's
 * project-target schedule Runs, VC-130) be filed here without a second
 * scoping rule.
 */
export function listRunsForProject(db: Database.Database, projectId: string): AutomationRun[] {
  const rows = prepared<[string], AutomationRunRow>(
    db,
    `SELECT automation_runs.* FROM automation_runs
       JOIN sessions ON sessions.id = automation_runs.session_id
      WHERE sessions.project_id = ?
      ORDER BY automation_runs.created_at DESC, automation_runs.id DESC`,
  ).all(projectId);
  return rows.map(mapRun);
}

/**
 * One Automation's Runs inside one project, newest first (VC-130).
 *
 * The single-flight guard for a Run that names no Ticket. A ticket Run asks
 * "is anything already working on this Ticket"; a schedule Run has no Ticket to
 * ask about, so it asks the nearest true question instead — is an earlier Run
 * of THIS schedule, in THIS project, still working. Scoped through the Run's
 * own Session like the project history above it, for the same reason: a global
 * Automation is listable everywhere but each Run happened in one project.
 */
export function listProjectRunsForAutomation(
  db: Database.Database,
  input: { automationId: string; projectId: string },
): AutomationRun[] {
  const rows = prepared<[string, string], AutomationRunRow>(
    db,
    `SELECT automation_runs.* FROM automation_runs
       JOIN sessions ON sessions.id = automation_runs.session_id
      WHERE automation_runs.automation_id = ? AND sessions.project_id = ?
      ORDER BY automation_runs.created_at DESC, automation_runs.id DESC`,
  ).all(input.automationId, input.projectId);
  return rows.map(mapRun);
}

/* ------------------------------------- column arming (migration 031) ------- */

/**
 * The Arming PROJECTION — the machine-local half of a switch whose intent is an
 * ordinary Automation command (`automations/engine.ts`,
 * `automation.set-arming`).
 *
 * The split is the same one `automations/enablement.ts` states for enablement,
 * and this table is the second projection under that one pattern:
 *
 *  - **The intent is durable, evented and receipted.** Arming decides whether
 *    work starts without a person, which is user intent under
 *    docs/BOUNDARIES.md rule 5. Machine-locality decides where the projection
 *    LANDS; it is not an exemption from the seam. So nothing outside the ledger
 *    transaction calls the writers below — they are the projection's hands, not
 *    a door.
 *  - **The projection is machine-local and never travels.** These rows are the
 *    choice one machine made about one column: they are absent from git, from a
 *    project directory, and from the record that VC-112 says moves to an
 *    account one day. A second machine sees the Automations and fires nothing
 *    until someone arms something there.
 *
 * The composite primary key is what makes "a column arms at most one
 * Automation, or none" true at the storage layer rather than by convention, and
 * it also makes each row independent — see {@link mapArming} for why one
 * unreadable row fails closed by itself instead of voiding the project's.
 */
/**
 * One row, or `null` when this build cannot read it.
 *
 * Tolerant on read and FAILING CLOSED, the stance `enablement.ts` argues for at
 * length: a row this build cannot understand can only have come from a future
 * build or a hand edit, and guessing at it would FIRE something nobody armed
 * here. Dropping it can only under-fire, which VC-112 already calls the resting
 * state.
 *
 * Closed per ROW rather than per project, and that is the difference the key
 * makes. Enablement is one JSON blob, so half of it being unreadable makes the
 * whole blob a guess; arming is one row per column, each naming its own column
 * in its own primary key, so an unreadable row can only ever be about a column
 * this build does not have. Voiding the project's other columns would disarm
 * ones we can read perfectly, which is a bigger lie than dropping the one we
 * cannot.
 */
function mapArming(row: ColumnArmingRow): ColumnArming | null {
  return isTicketStatus(row.status)
    ? {
        projectId: row.project_id,
        status: row.status,
        automationId: row.automation_id,
        armedAt: row.armed_at,
      }
    : null;
}

/** Every armed column in one project, board order left to the caller. */
export function listColumnArmings(db: Database.Database, projectId: string): ColumnArming[] {
  const rows = prepared<[string], ColumnArmingRow>(
    db,
    "SELECT * FROM automation_column_arming WHERE project_id = ?",
  ).all(projectId);
  return rows.flatMap((row) => {
    const arming = mapArming(row);
    return arming === null ? [] : [arming];
  });
}

/**
 * Arms `status` with `automationId`, replacing whatever it held. The
 * projection's hand: called from inside the ledger transaction that recorded
 * the intent (`SqliteAutomationLedgerTransaction.putColumnArming`), never from
 * a handler.
 *
 * The upsert is what makes "a column arms at most one Automation" true at the
 * storage layer: the composite primary key admits no second row, so there is no
 * ordering of writes in which a column ends up with two.
 */
export function setColumnArming(
  db: Database.Database,
  input: { projectId: string; status: TicketStatus; automationId: string },
  now: number,
): void {
  prepared(
    db,
    `INSERT INTO automation_column_arming (project_id, status, automation_id, armed_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id, status)
       DO UPDATE SET automation_id = excluded.automation_id, armed_at = excluded.armed_at`,
  ).run(input.projectId, input.status, input.automationId, now);
}

/**
 * Disarms one column, the same hand as {@link setColumnArming}. Silent when it
 * was already unarmed — the end state is the point.
 */
export function clearColumnArming(
  db: Database.Database,
  input: { projectId: string; status: TicketStatus },
): void {
  prepared(db, "DELETE FROM automation_column_arming WHERE project_id = ? AND status = ?").run(
    input.projectId,
    input.status,
  );
}

/* -------------------------------------- column order (migration 034) ------ */

/**
 * The ORDER projection (VC-132) — the third table under the pattern the two
 * above it established: an ordinary durable command (`automation.set-column-order`)
 * whose answer lands somewhere machine-local.
 *
 * What it stores is which Offered Automation reads as `1` when a card is
 * dragged over the column. It is not part of the record for the reason the
 * arming is not: the drag pins the column's ARMED Automation to digit `1`, and
 * an order that travelled while the arming it is read against did not would
 * print one digit here and mean another elsewhere.
 */
/**
 * One row, or `null` when this build cannot read it — the same tolerant,
 * fail-closed read `mapArming` argues for, and closed per ROW for the same
 * reason: each row names its own column in its own primary key, so an
 * unreadable one can only ever be about a column this build does not have.
 *
 * A rank that fails to parse degrades to "no rank here", which is the resting
 * state of every column nobody has arranged: the Offered list still reads, in
 * the order the caller was handed. Nothing about a lost rank can start a Run.
 */
function mapColumnOrder(row: ColumnOrderRow): ColumnAutomationOrder | null {
  if (!isTicketStatus(row.status)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.ranked_ids);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) return null;
  return {
    projectId: row.project_id,
    status: row.status,
    rankedAutomationIds: parsed,
    orderedAt: row.ordered_at,
  };
}

/** Every arranged column in one project, board order left to the caller. */
export function listColumnOrders(
  db: Database.Database,
  projectId: string,
): ColumnAutomationOrder[] {
  const rows = prepared<[string], ColumnOrderRow>(
    db,
    "SELECT * FROM automation_column_order WHERE project_id = ?",
  ).all(projectId);
  return rows.flatMap((row) => {
    const order = mapColumnOrder(row);
    return order === null ? [] : [order];
  });
}

/**
 * Writes one column's rank, replacing whatever it held. The projection's hand:
 * called from inside the ledger transaction that recorded the intent
 * (`SqliteAutomationLedgerTransaction.putColumnOrder`), never from a handler.
 *
 * An EMPTY list deletes the row rather than storing `[]`. "Arranged into
 * nothing" and "never arranged" are the same fact — both read as the Offered
 * list in the order the caller was handed — and keeping one spelling of it
 * means no reader has to know two.
 */
export function setColumnOrder(
  db: Database.Database,
  input: { projectId: string; status: TicketStatus; rankedAutomationIds: readonly string[] },
  now: number,
): void {
  if (input.rankedAutomationIds.length === 0) {
    prepared(db, "DELETE FROM automation_column_order WHERE project_id = ? AND status = ?").run(
      input.projectId,
      input.status,
    );
    return;
  }
  prepared(
    db,
    `INSERT INTO automation_column_order (project_id, status, ranked_ids, ordered_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id, status)
       DO UPDATE SET ranked_ids = excluded.ranked_ids, ordered_at = excluded.ordered_at`,
  ).run(input.projectId, input.status, JSON.stringify([...input.rankedAutomationIds]), now);
}

/* ------------------------------ skipped occurrences (migration 032) ------- */

/**
 * A recorded skip, read in today's vocabulary.
 *
 * The reason degrades to `unknown` rather than to `app-closed`, and the
 * asymmetry with the Trigger beside it is the point: an unreadable Trigger
 * degrades to firing nothing, which costs a Run nobody sees; an unreadable
 * REASON must still read as a skip, because the one thing VC-112 forbids is a
 * skip that looks like a silence. Asserting "the app was closed" would be
 * inventing a cause; saying so plainly is not.
 */
function mapSkip(row: AutomationSkipRow): AutomationSkippedOccurrence {
  return {
    id: row.id,
    automationId: row.automation_id,
    automationName: row.automation_name,
    projectId: row.project_id,
    dueAt: row.due_at,
    missedCount: row.missed_count,
    reason: parseAutomationSkipReason(parseJsonColumn(row.reason)),
    recordedAt: row.recorded_at,
  };
}

/**
 * Records one Skipped occurrence — the projection's hand, called from inside
 * the ledger transaction that recorded the intent, never from a handler.
 */
export function insertSkippedOccurrence(
  db: Database.Database,
  skip: AutomationSkippedOccurrence,
): void {
  prepared(
    db,
    `INSERT INTO automation_skipped_occurrences
      (id, automation_id, automation_name, project_id, due_at, missed_count, reason, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    skip.id,
    skip.automationId,
    skip.automationName,
    skip.projectId,
    skip.dueAt,
    skip.missedCount,
    JSON.stringify(skip.reason),
    skip.recordedAt,
  );
}

/** One project's Skipped occurrences, newest due time first — the page's history. */
export function listSkippedOccurrencesForProject(
  db: Database.Database,
  projectId: string,
): AutomationSkippedOccurrence[] {
  const rows = prepared<[string], AutomationSkipRow>(
    db,
    `SELECT * FROM automation_skipped_occurrences
      WHERE project_id = ?
      ORDER BY due_at DESC, id DESC`,
  ).all(projectId);
  return rows.map(mapSkip);
}

/** One recorded skip by id — the ledger's read-back after it writes one. */
export function getSkippedOccurrence(
  db: Database.Database,
  id: string,
): AutomationSkippedOccurrence | undefined {
  const row = prepared<[string], AutomationSkipRow>(
    db,
    "SELECT * FROM automation_skipped_occurrences WHERE id = ?",
  ).get(id);
  return row === undefined ? undefined : mapSkip(row);
}
