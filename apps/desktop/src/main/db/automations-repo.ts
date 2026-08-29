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
  parseAutomationTrigger,
  parseSessionModel,
} from "@volli/shared";
import type {
  Automation,
  AutomationRun,
  AutomationRuntime,
  AutomationTrigger,
  ColumnArming,
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

interface AutomationRunRow {
  id: string;
  automation_id: string | null;
  automation_name: string | null;
  ticket_id: string | null;
  session_id: string;
  provider_id: string;
  model_id: string;
  reasoning_level: string;
  created_at: number;
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
  ticketId: string;
  sessionId: string;
  /** The RESOLVED selection the Session was born with, never the reference. */
  model: ResolvedAutomationModel;
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
  prepared(
    db,
    `INSERT INTO automation_runs
      (id, automation_id, automation_name, ticket_id, session_id, provider_id, model_id, reasoning_level, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.automationId,
    automationName,
    input.ticketId,
    input.sessionId,
    input.model.providerId,
    input.model.modelId,
    input.model.reasoningLevel,
    now,
  );
  return {
    id,
    automationId: input.automationId,
    automationName,
    ticketId: input.ticketId,
    sessionId: input.sessionId,
    model: input.model,
    createdAt: now,
  };
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

/** The newest Run on a Ticket, or undefined — retained for older read-only callers. */
export function latestRunForTicket(
  db: Database.Database,
  ticketId: string,
): AutomationRun | undefined {
  const row = prepared<[string], AutomationRunRow>(
    db,
    "SELECT * FROM automation_runs WHERE ticket_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get(ticketId);
  return row ? mapRun(row) : undefined;
}

/* ------------------------------------- column arming (migration 031) ------- */

/**
 * The Arming projection is read and written directly here rather than through
 * the Automation command ledger, and that is the design rather than a shortcut.
 *
 * The ledger is the durable RECORD — the thing VC-112 says moves from local
 * SQLite to an account one day. Arming must never make that trip: it is the
 * choice one machine made about one column, and a second machine must see the
 * Automations and fire nothing until someone turns something on there. Writing
 * arming as a ledger command would file it in exactly the history that travels.
 *
 * Nothing is lost by the shortcut either. The write is a single upsert keyed by
 * `(project_id, status)`, so it is idempotent by construction — the retry
 * identity a command id exists to provide has no work to do here.
 */
function mapArming(row: ColumnArmingRow): ColumnArming | null {
  // A status this build does not know is dropped rather than surfaced: it can
  // only have come from a future/hand-edited row, and an arming on a column
  // that does not exist can never fire.
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
 * Arms `status` with `automationId`, replacing whatever it held.
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

/** Disarms one column. Silent when it was already unarmed — the end state is the point. */
export function clearColumnArming(
  db: Database.Database,
  input: { projectId: string; status: TicketStatus },
): void {
  prepared(db, "DELETE FROM automation_column_arming WHERE project_id = ? AND status = ?").run(
    input.projectId,
    input.status,
  );
}
