/**
 * `mcp_operations` table repo (migration 050): the durable record of MCP
 * MANAGEMENT operations (VC-380).
 *
 * VC-8 already records MCP tool CALLS, inside the transcript of the Session
 * that made them. That is the wrong shelf for an install: the install happened
 * in one Session and its consequence — a project-wide configuration change that
 * every later Session inherits — belongs to the project, not to that
 * conversation. A person auditing "what got installed here, and by whom" has no
 * transcript to open, and the one they would want most is a REMOVAL, whose
 * server row is gone by definition.
 *
 * So the table is append-only, project-scoped, and holds `server_id` as plain
 * text with no foreign key. Nothing here is ever updated or deleted: an
 * operation is a fact about a moment, and a fact that could be edited afterwards
 * would be worth less than no record at all.
 *
 * Append-only is not the same as write-twice. The row's id is DERIVED from the
 * calling Session and the tool call that asked (see {@link mcpOperationId}), so
 * a retried tool call lands as the one act it was rather than as two facts about
 * one moment.
 */
import type Database from "better-sqlite3";
import {
  MCP_ERROR_MAX_CHARS,
  sanitizeMcpProvenance,
  type McpOperationKind,
  type McpOperationOutcome,
  type McpOperationRecord,
  type McpServerProvenance,
} from "@volli/shared";

import { prepared } from "./prepared";

/** How many operations a read returns when the caller names no bound. */
export const MCP_OPERATION_HISTORY_LIMIT = 50;

export type { McpOperationKind, McpOperationOutcome, McpOperationRecord };

export interface RecordMcpOperationInput {
  /**
   * This row's durable identity, from {@link mcpOperationId}.
   *
   * Supplied rather than minted here, because the only writer that can derive
   * it is the one that knows which Session and which tool call asked.
   */
  id: string;
  projectId: string;
  serverId: string;
  serverName: string;
  operation: McpOperationKind;
  outcome: McpOperationOutcome;
  summary: string;
  detail: string | null;
  provenance: McpServerProvenance;
  sessionId: string | null;
  ticketId: string | null;
}

/**
 * One management operation's durable id: the caller, and the call that asked.
 *
 * `RuntimeVerbCall.toolCallId` exists for exactly this, and says so: the host
 * derives a durable operation id from trusted caller identity plus the call id,
 * "rather than minting a fresh random one per execution. That is what makes a
 * replayed tool call land as one durable act instead of two." The door already
 * builds `${sessionId}:${toolCallId}` in six places for the same reason, and an
 * audit row is the last place that should disagree with them — a retried
 * install after a lost response would otherwise leave two records of one act,
 * and a person auditing would have no way to tell that from two installs.
 *
 * DURABLE: this derivation is frozen. Changing it does not error — it
 * duplicates history.
 */
export function mcpOperationId(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

interface McpOperationRow {
  id: string;
  project_id: string;
  server_id: string;
  server_name: string;
  operation: string;
  outcome: string;
  summary: string;
  detail: string | null;
  source: string | null;
  registry_type: string | null;
  version: string | null;
  digest: string | null;
  session_id: string | null;
  ticket_id: string | null;
  created_at: number;
}

/**
 * One line of untrusted prose, flattened and bounded before it is stored.
 *
 * Both `summary` and `detail` quote a server's own error text, which is
 * whatever a third-party process chose to print. A newline in a stored audit
 * line is how one row becomes two in anything that renders it, so the same
 * treatment `McpSettingsService` gives an error on its way to a caller is given
 * here on its way to disk.
 */
function bounded(value: string): string {
  const printable = Array.from(value, (character) =>
    character.charCodeAt(0) < 32 ? " " : character,
  ).join("");
  return printable.length <= MCP_ERROR_MAX_CHARS
    ? printable
    : `${printable.slice(0, MCP_ERROR_MAX_CHARS - 1)}…`;
}

function mapRow(row: McpOperationRow): McpOperationRecord {
  const provenance = sanitizeMcpProvenance({
    source: row.source,
    registryType: row.registry_type,
    version: row.version,
    digest: row.digest,
  });
  return {
    id: row.id,
    projectId: row.project_id,
    serverId: row.server_id,
    serverName: row.server_name,
    operation: row.operation as McpOperationKind,
    outcome: row.outcome as McpOperationOutcome,
    summary: row.summary,
    detail: row.detail,
    // A malformed stored origin must not make the whole audit unreadable: the
    // record's job is to be findable after something went wrong, so it degrades
    // to "nobody said" rather than throwing the row away.
    provenance: provenance.ok
      ? provenance.provenance
      : { source: null, registryType: null, version: null, digest: null },
    sessionId: row.session_id,
    ticketId: row.ticket_id,
    createdAt: row.created_at,
  };
}

/**
 * Append one management operation, once.
 *
 * `DO NOTHING` rather than an upsert: the first write of a given id is the fact,
 * and a replay is the same fact arriving again, not a correction of it. The row
 * is then re-read rather than assumed, so a replay returns what is actually
 * stored instead of what this call would have written.
 */
export function recordMcpOperation(
  db: Database.Database,
  input: RecordMcpOperationInput,
  now: number,
): McpOperationRecord {
  const id = input.id;
  const provenance = sanitizeMcpProvenance(input.provenance);
  const stored = provenance.ok
    ? provenance.provenance
    : { source: null, registryType: null, version: null, digest: null };
  prepared(
    db,
    `INSERT INTO mcp_operations (
       id, project_id, server_id, server_name, operation, outcome, summary, detail,
       source, registry_type, version, digest, session_id, ticket_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    id,
    input.projectId,
    input.serverId,
    bounded(input.serverName),
    input.operation,
    input.outcome,
    bounded(input.summary),
    input.detail === null ? null : bounded(input.detail),
    stored.source,
    stored.registryType,
    stored.version,
    stored.digest,
    input.sessionId,
    input.ticketId,
    now,
  );
  return mapRow(
    prepared<[string], McpOperationRow>(db, "SELECT * FROM mcp_operations WHERE id = ?").get(id)!,
  );
}

/**
 * One project's management history, newest first.
 *
 * Ordered by `created_at DESC, id DESC` so the index on exactly those columns
 * can serve it, and so the tie-break is a value that means the same thing to
 * every reader. `rowid` would have been a local counter — the one shape
 * `docs/BOUNDARIES.md` rule 1 rules out for anything durable — and two writers
 * agreeing on order matters more than the order being insertion order.
 */
export function listMcpOperations(
  db: Database.Database,
  projectId: string,
  limit: number = MCP_OPERATION_HISTORY_LIMIT,
): readonly McpOperationRecord[] {
  return prepared<[string, number], McpOperationRow>(
    db,
    `SELECT * FROM mcp_operations
      WHERE project_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  )
    .all(projectId, limit)
    .map(mapRow);
}
