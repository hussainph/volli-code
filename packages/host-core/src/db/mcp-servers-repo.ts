import type Database from "better-sqlite3";
import {
  MCP_DESCRIPTION_MAX_CHARS,
  MCP_ERROR_MAX_CHARS,
  MCP_SERVER_NAME_MAX_CHARS,
  MCP_TOOL_NAME_MAX_CHARS,
  mcpProviderToolName,
  sanitizeMcpProvenance,
  sanitizeMcpServerDraft,
  sanitizeMcpToolHints,
  validateMcpToolDefinitions,
  type McpCatalogTool,
  type McpServerProvenance,
  type McpServerRecord,
  type McpToolDefinition,
  type McpTransportConfig,
} from "@volli/shared";

import { prepared } from "./prepared";
import { getAppState, setAppState } from "./app-state-repo";

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
    // Hints are display-only and re-checked rather than trusted: a stored
    // value this build cannot read is dropped, never a reason to refuse the
    // row — the tool works without them.
    const stored = row["hints"];
    const hints =
      stored !== null && typeof stored === "object" && !Array.isArray(stored)
        ? sanitizeMcpToolHints({
            name: row["name"],
            title: (stored as Record<string, unknown>)["title"],
            annotations: {
              readOnlyHint: (stored as Record<string, unknown>)["readOnly"],
              destructiveHint: (stored as Record<string, unknown>)["destructive"],
            },
          })
        : undefined;
    const tool: McpCatalogTool = {
      name: row["name"],
      description: row["description"],
      enabled: row["enabled"],
      definition,
      error: row["error"],
    };
    if (hints !== undefined) tool.hints = hints;
    return tool;
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

/**
 * Whether one server is configured in a project, and enabled, without parsing
 * its row: what an attachment checks before every MCP call (VC-771).
 */
export function getMcpServerEnabled(
  db: Database.Database,
  projectId: string,
  serverId: string,
): boolean | undefined {
  const row = prepared<[string, string], { enabled: number }>(
    db,
    "SELECT enabled FROM mcp_servers WHERE id = ? AND project_id = ?",
  ).get(serverId, projectId);
  return row === undefined ? undefined : row.enabled === 1;
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

/**
 * Machine-wide configuration is expand-only: old project rows remain readable
 * by N-1 and by birth-frozen Sessions. The host row survives project removal.
 * Imported ids (including removed ones) are durable tombstones, not a cache.
 * No credential values enter this record; transports contain references only.
 */
interface GlobalMcpState {
  version: 1;
  rows: McpServerRow[];
  imported: string[];
  aliases: Record<string, string>;
  retained: McpServerRow[];
  names: Record<string, string>;
}

function storedRow(server: McpServerRecord): McpServerRow {
  return {
    id: server.id,
    project_id: server.projectId,
    name: server.name,
    enabled: server.enabled ? 1 : 0,
    transport: JSON.stringify(server.transport),
    catalog: JSON.stringify(server.catalog),
    stale: server.stale ? 1 : 0,
    error: server.error,
    refreshed_at: server.refreshedAt,
    created_at: server.createdAt,
    updated_at: server.updatedAt,
    source: server.provenance.source,
    registry_type: server.provenance.registryType,
    version: server.provenance.version,
    digest: server.provenance.digest,
  };
}

function writeGlobal(db: Database.Database, state: GlobalMcpState): void {
  // Use exactly the production SQLite row codec for both stores.
  for (const row of state.rows) mapRow(row);
  setAppState(db, "volli:mcp-global", JSON.stringify(state), Date.now());
}

function globalState(db: Database.Database): GlobalMcpState {
  const raw = getAppState(db, "volli:mcp-global");
  const value: unknown = raw === undefined ? undefined : parseJson(raw, "global configuration");
  let state: GlobalMcpState;
  if (value === undefined) {
    state = { version: 1, rows: [], imported: [], aliases: {}, retained: [], names: {} };
  } else {
    if (value === null || typeof value !== "object")
      throw new Error("Stored global MCP configuration is invalid.");
    const candidate = value as GlobalMcpState;
    if (
      candidate.version !== 1 ||
      !Array.isArray(candidate.rows) ||
      !Array.isArray(candidate.retained) ||
      !Array.isArray(candidate.imported) ||
      candidate.imported.some((id) => typeof id !== "string") ||
      candidate.names === null ||
      typeof candidate.names !== "object" ||
      Array.isArray(candidate.names) ||
      Object.values(candidate.names).some((name) => typeof name !== "string") ||
      candidate.aliases === null ||
      typeof candidate.aliases !== "object" ||
      Array.isArray(candidate.aliases) ||
      Object.values(candidate.aliases).some((id) => typeof id !== "string")
    ) {
      throw new Error("Stored global MCP configuration is invalid.");
    }
    for (const row of [...candidate.rows, ...candidate.retained]) mapRow(row);
    state = candidate;
  }
  const imported = new Set(state.imported);
  const legacy = prepared<[], McpServerRow>(
    db,
    "SELECT * FROM mcp_servers ORDER BY created_at, id",
  ).all();
  let changed = raw === undefined;
  for (const row of legacy) {
    if (imported.has(row.id)) continue;
    const server = mapRow(row);
    // Compare the complete sanitized transport: same executable/URL with
    // different arguments or credential references is NOT the same service.
    const identical = state.rows.find(
      (existing) =>
        (state.names[existing.id] ?? existing.name) === row.name &&
        JSON.stringify(mapRow(existing).transport) === JSON.stringify(server.transport),
    );
    if (identical) {
      state.aliases = { ...state.aliases, [row.id]: identical.id };
      state.retained.push(row);
      // A union keeps every selected tool. Only the new-Session catalog uses
      // canonical ids; the retained row still has its original frozen ids.
      const canonical = mapRow(identical);
      const catalog = [...canonical.catalog];
      for (const tool of server.catalog) {
        const index = catalog.findIndex((entry) => entry.name === tool.name);
        if (index < 0)
          catalog.push({
            ...tool,
            definition:
              tool.definition === null
                ? null
                : {
                    ...tool.definition,
                    serverId: canonical.id,
                    providerName: mcpProviderToolName(canonical.id, canonical.name, tool.name),
                  },
          });
        else if (tool.enabled && catalog[index]!.definition !== null)
          catalog[index] = { ...catalog[index]!, enabled: true };
      }
      identical.catalog = JSON.stringify(catalog);
      if (server.enabled) identical.enabled = 1;
    } else {
      let name = row.name;
      let suffix = 1;
      const source =
        prepared<[string], { name: string }>(db, "SELECT name FROM projects WHERE id = ?").get(
          row.project_id,
        )?.name ?? "imported";
      while (state.rows.some((existing) => existing.name === name)) {
        const ending = ` (${source.slice(0, 40)}${suffix === 1 ? "" : ` ${suffix}`})`;
        name = `${row.name.slice(0, MCP_SERVER_NAME_MAX_CHARS - ending.length)}${ending}`;
        suffix += 1;
      }
      // Keep catalog provider identities and ids unchanged for frozen callers.
      state.rows.push({ ...row, name });
      state.names = { ...state.names, [row.id]: row.name };
    }
    state.imported.push(row.id);
    imported.add(row.id);
    changed = true;
  }
  if (changed) writeGlobal(db, state);
  return state;
}

export function listGlobalMcpServers(db: Database.Database): McpServerRecord[] {
  return db.transaction(() => globalState(db).rows.map(mapRow))();
}

export function getGlobalMcpServer(db: Database.Database, id: string): McpServerRecord | undefined {
  const state = globalState(db);
  const row = state.rows.find((candidate) => candidate.id === id);
  // A duplicate's old id keeps its own credentials and transport, rather than
  // borrowing the canonical server's credentials on a frozen reattachment.
  const retained = state.retained.find((candidate) => candidate.id === id);
  return row ? mapRow(row) : retained ? mapRow(retained) : undefined;
}

export function putGlobalMcpServer(
  db: Database.Database,
  server: McpServerRecord,
): McpServerRecord {
  return db.transaction(() => {
    const state = globalState(db);
    if (Object.hasOwn(state.aliases, server.id))
      throw new Error("An imported alias is retained for existing Sessions only.");
    const row = storedRow(server);
    const checked = mapRow(row);
    const index = state.rows.findIndex((existing) => existing.id === server.id);
    if (index < 0) state.rows.push(row);
    else state.rows[index] = row;
    state.names = { ...state.names, [server.id]: server.name };
    if (!state.imported.includes(server.id)) state.imported.push(server.id);
    // Keep the original owning project for N-1, never move or fabricate one.
    const legacy = getMcpServer(db, server.id);
    const owner = legacy?.projectId ?? server.projectId;
    if (prepared<[string], { id: string }>(db, "SELECT id FROM projects WHERE id = ?").get(owner)) {
      putMcpServer(db, { ...checked, projectId: owner });
    }
    for (const [alias, canonical] of Object.entries(state.aliases)) {
      if (canonical !== server.id) continue;
      const retained = state.retained.find((candidate) => candidate.id === alias);
      if (retained) {
        retained.enabled = server.enabled ? 1 : 0;
        retained.updated_at = server.updatedAt;
      }
      const previous = getMcpServer(db, alias);
      if (previous)
        putMcpServer(db, { ...previous, enabled: server.enabled, updatedAt: server.updatedAt });
    }
    writeGlobal(db, state);
    return checked;
  })();
}

/** All removed ids, so the caller revokes each id's separate sealed credentials. */
export function deleteGlobalMcpServer(db: Database.Database, id: string): readonly string[] {
  return db.transaction(() => {
    const state = globalState(db);
    if (!state.rows.some((row) => row.id === id)) return [];
    const ids = [
      id,
      ...Object.entries(state.aliases)
        .filter(([, canonical]) => canonical === id)
        .map(([alias]) => alias),
    ];
    state.rows = state.rows.filter((row) => row.id !== id);
    state.retained = state.retained.filter((row) => !ids.includes(row.id));
    for (const removed of ids) {
      prepared(db, "DELETE FROM mcp_servers WHERE id = ?").run(removed);
      delete state.aliases[removed];
      delete state.names[removed];
    }
    writeGlobal(db, state);
    return ids;
  })();
}

/** Every credential/process identity hidden behind one deduplicated settings row. */
export function globalMcpServerIds(db: Database.Database, id: string): readonly string[] {
  const state = globalState(db);
  return [
    id,
    ...Object.entries(state.aliases)
      .filter(([, canonical]) => canonical === id)
      .map(([alias]) => alias),
  ];
}
