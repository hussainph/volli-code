import type Database from "better-sqlite3";
import {
  MCP_DESCRIPTION_MAX_CHARS,
  MCP_ERROR_MAX_CHARS,
  MCP_TOOL_NAME_MAX_CHARS,
  sanitizeMcpProvenance,
  sanitizeMcpServerDraft,
  validateMcpToolDefinitions,
  type McpCatalogTool,
  type McpServerProvenance,
  type McpServerRecord,
  type McpToolDefinition,
  type McpTransportConfig,
} from "@volli/shared";

import { prepared } from "./prepared";

interface McpServerRow {
  id: string;
  project_id: string;
  name: string;
  enabled: number;
  transport: string;
  catalog: string;
  stale: number;
  error: string | null;
  refreshed_at: number | null;
  created_at: number;
  updated_at: number;
  source: string | null;
  registry_type: string | null;
  version: string | null;
  digest: string | null;
}

/**
 * Stored provenance, re-validated on the way out (VC-380).
 *
 * The same discipline `mapRow` already holds for the transport and the
 * catalog: a row is untrusted until this build has checked it, because the
 * file on disk outlives the version that wrote it and a hand-edited profile is
 * an ordinary thing to meet.
 */
function parseProvenance(row: McpServerRow): McpServerProvenance {
  const sanitized = sanitizeMcpProvenance({
    source: row.source,
    registryType: row.registry_type,
    version: row.version,
    digest: row.digest,
  });
  if (!sanitized.ok) throw new Error(`Stored MCP provenance is invalid: ${sanitized.reason}`);
  return sanitized.provenance;
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Stored MCP ${field} is invalid.`);
  }
}

function parseCatalog(value: string, serverId: string): readonly McpCatalogTool[] {
  const parsed = parseJson(value, "catalog");
  if (!Array.isArray(parsed)) throw new Error("Stored MCP catalog is invalid.");
  const catalog = parsed.map((entry, index): McpCatalogTool => {
    if (entry === null || Array.isArray(entry) || typeof entry !== "object") {
      throw new Error(`Stored MCP catalog entry ${index} is invalid.`);
    }
    const row = entry as Record<string, unknown>;
    if (
      typeof row["name"] !== "string" ||
      row["name"].length > MCP_TOOL_NAME_MAX_CHARS ||
      typeof row["description"] !== "string" ||
      row["description"].length > MCP_DESCRIPTION_MAX_CHARS ||
      typeof row["enabled"] !== "boolean" ||
      (row["error"] !== null &&
        (typeof row["error"] !== "string" || row["error"].length > MCP_ERROR_MAX_CHARS))
    ) {
      throw new Error(`Stored MCP catalog entry ${index} is invalid.`);
    }
    const definition = row["definition"] as McpToolDefinition | null;
    if (definition !== null) {
      validateMcpToolDefinitions([definition]);
      if (definition.serverId !== serverId || definition.toolName !== row["name"]) {
        throw new Error(`Stored MCP catalog entry ${index} has mismatched identity.`);
      }
    }
    return {
      name: row["name"],
      description: row["description"],
      enabled: row["enabled"],
      definition,
      error: row["error"],
    };
  });
  validateMcpToolDefinitions(
    catalog.flatMap((tool) => (tool.definition === null ? [] : [tool.definition])),
  );
  return catalog;
}

function mapRow(row: McpServerRow): McpServerRecord {
  if (
    row.error !== null &&
    (typeof row.error !== "string" || row.error.length > MCP_ERROR_MAX_CHARS)
  ) {
    throw new Error("Stored MCP server error is invalid.");
  }
  const draft = sanitizeMcpServerDraft({
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    transport: parseJson(row.transport, "transport"),
  });
  if (!draft.ok) throw new Error(`Stored MCP server is invalid: ${draft.reason}`);
  return {
    ...draft.server,
    projectId: row.project_id,
    provenance: parseProvenance(row),
    catalog: parseCatalog(row.catalog, row.id),
    stale: row.stale === 1,
    error: row.error,
    refreshedAt: row.refreshed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMcpServers(db: Database.Database, projectId: string): McpServerRecord[] {
  return prepared<[string], McpServerRow>(
    db,
    "SELECT * FROM mcp_servers WHERE project_id = ? ORDER BY created_at, id",
  )
    .all(projectId)
    .map(mapRow);
}

export function getMcpServer(db: Database.Database, serverId: string): McpServerRecord | undefined {
  const row = prepared<[string], McpServerRow>(db, "SELECT * FROM mcp_servers WHERE id = ?").get(
    serverId,
  );
  return row === undefined ? undefined : mapRow(row);
}

export function putMcpServer(db: Database.Database, server: McpServerRecord): McpServerRecord {
  const sanitized = sanitizeMcpServerDraft(server);
  if (!sanitized.ok) throw new Error(sanitized.reason);
  const provenance = sanitizeMcpProvenance(server.provenance);
  if (!provenance.ok) throw new Error(provenance.reason);
  validateMcpToolDefinitions(
    server.catalog.flatMap((tool) => (tool.definition === null ? [] : [tool.definition])),
  );
  prepared(
    db,
    `INSERT INTO mcp_servers (
       id, project_id, name, enabled, transport, catalog, stale, error,
       refreshed_at, created_at, updated_at, source, registry_type, version, digest
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       name = excluded.name,
       enabled = excluded.enabled,
       transport = excluded.transport,
       catalog = excluded.catalog,
       stale = excluded.stale,
       error = excluded.error,
       refreshed_at = excluded.refreshed_at,
       updated_at = excluded.updated_at,
       source = excluded.source,
       registry_type = excluded.registry_type,
       version = excluded.version,
       digest = excluded.digest`,
  ).run(
    sanitized.server.id,
    server.projectId,
    sanitized.server.name,
    sanitized.server.enabled ? 1 : 0,
    JSON.stringify(sanitized.server.transport satisfies McpTransportConfig),
    JSON.stringify(server.catalog),
    server.stale ? 1 : 0,
    server.error,
    server.refreshedAt,
    server.createdAt,
    server.updatedAt,
    provenance.provenance.source,
    provenance.provenance.registryType,
    provenance.provenance.version,
    provenance.provenance.digest,
  );
  return getMcpServer(db, server.id)!;
}

export function markMcpServerRefreshFailure(
  db: Database.Database,
  serverId: string,
  error: string,
  now: number,
): McpServerRecord | undefined {
  prepared(db, "UPDATE mcp_servers SET stale = 1, error = ?, updated_at = ? WHERE id = ?").run(
    error,
    now,
    serverId,
  );
  return getMcpServer(db, serverId);
}

export function deleteMcpServer(
  db: Database.Database,
  projectId: string,
  serverId: string,
): boolean {
  return (
    prepared(db, "DELETE FROM mcp_servers WHERE project_id = ? AND id = ?").run(projectId, serverId)
      .changes > 0
  );
}

export function selectedMcpToolDefinitions(
  db: Database.Database,
  projectId: string,
): readonly McpToolDefinition[] {
  const definitions = listMcpServers(db, projectId).flatMap((server) =>
    server.enabled
      ? server.catalog.flatMap((tool) =>
          tool.enabled && tool.definition !== null ? [tool.definition] : [],
        )
      : [],
  );
  return validateMcpToolDefinitions(definitions);
}
