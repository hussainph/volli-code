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
import { parseSessionModel } from "@volli/shared";
import type {
  Automation,
  AutomationRun,
  AutomationRuntime,
  ModelSelection,
  ResolvedAutomationModel,
} from "@volli/shared";
import { prepared } from "./prepared";

interface AutomationRow {
  id: string;
  project_id: string | null;
  name: string;
  instructions: string;
  runtime: string | null;
  row_version: number;
  created_at: number;
  updated_at: number;
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

function mapAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    instructions: row.instructions,
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
    `INSERT INTO automations (id, project_id, name, instructions, runtime, row_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.name,
    input.instructions,
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
        SET name = ?, instructions = ?, runtime = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ?`,
  ).run(
    input.name,
    input.instructions,
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
