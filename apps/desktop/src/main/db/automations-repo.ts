/**
 * `automations` + `automation_runs` repo (migration 025): row↔domain mapping
 * for Automations V1's durable record (VC-112, tracer VC-126).
 *
 * Ids are `randomUUID()` at the one place a row is minted — docs/BOUNDARIES.md
 * standing rule 1. `runtime` stores the pinned selection as one JSON blob and
 * reads through `parseSessionModel`'s degrade-don't-throw stance: a hand-edited
 * pin that no longer parses reads as inherit, which is survivable and visible,
 * where a throw would take every listing down with it.
 *
 * A Run row stores the resolved provider/model/reasoning as flat columns —
 * never the reference — so the record still answers "what ran" after models
 * churn or the Automation is edited or deleted.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { parseSessionModel, REASONING_LEVELS } from "@volli/shared";
import type { Automation, AutomationRun, ModelSelection } from "@volli/shared";
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
  ticket_id: string | null;
  session_id: string;
  provider_id: string;
  model_id: string;
  reasoning_level: string;
  created_at: number;
}

function parseJsonColumn(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function mapAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    instructions: row.instructions,
    runtime: parseSessionModel(parseJsonColumn(row.runtime)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    ticketId: row.ticket_id,
    sessionId: row.session_id,
    model: {
      providerId: row.provider_id,
      modelId: row.model_id,
      // The column CHECK only refuses the empty string; the vocabulary is
      // Volli's. A row written by a wider future scale still reads, degraded
      // to "medium" rather than corrupting the whole listing.
      reasoningLevel: REASONING_LEVELS.find((level) => level === row.reasoning_level) ?? "medium",
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

/** A record delete (VC-112, "One-time work"): runs keep their history via `ON DELETE SET NULL`. */
export function deleteAutomation(db: Database.Database, id: string): boolean {
  return prepared(db, "DELETE FROM automations WHERE id = ?").run(id).changes > 0;
}

export interface AutomationRunWrite {
  /** `null` is an Unbound Run (VC-129) — admitted by the schema from day one. */
  automationId: string | null;
  ticketId: string;
  sessionId: string;
  /** The RESOLVED selection the Session was born with, never the reference. */
  model: ModelSelection;
}

export function recordAutomationRun(
  db: Database.Database,
  input: AutomationRunWrite,
  now: number,
): AutomationRun {
  const id = randomUUID();
  prepared(
    db,
    `INSERT INTO automation_runs (id, automation_id, ticket_id, session_id, provider_id, model_id, reasoning_level, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.automationId,
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
    ticketId: input.ticketId,
    sessionId: input.sessionId,
    model: input.model,
    createdAt: now,
  };
}

/** This Ticket's Runs, newest first — the rail's history and the palette's context. */
export function listRunsForTicket(db: Database.Database, ticketId: string): AutomationRun[] {
  const rows = prepared<[string], AutomationRunRow>(
    db,
    "SELECT * FROM automation_runs WHERE ticket_id = ? ORDER BY created_at DESC, id DESC",
  ).all(ticketId);
  return rows.map(mapRun);
}

/** The newest Run on a Ticket, or undefined — the single-flight guard's durable half. */
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
