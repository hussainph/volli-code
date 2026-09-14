import type Database from "better-sqlite3";
import {
  MCP_ERROR_MAX_CHARS,
  sanitizeMcpServerDraft,
  type McpServerDraft,
  type McpServerRecord,
  type McpToolDefinition,
} from "@volli/shared";

import {
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  markMcpServerRefreshFailure,
  putMcpServer,
  selectedMcpToolDefinitions,
} from "../db/mcp-servers-repo";
import { getProjectById } from "../db/projects-repo";
import { openMcpProtocolClient } from "./client";
import { discoverMcpServer, type OpenMcpProtocolClient } from "./discovery";

export type McpServerResult =
  | { ok: true; server: McpServerRecord }
  | { ok: false; error: string; server?: McpServerRecord };
export type McpCatalogResult =
  | { ok: true; catalog: McpServerRecord["catalog"] }
  | { ok: false; error: string };
export type McpMutationResult = { ok: true } | { ok: false; error: string };

export interface McpSettingsOptions {
  db: Database.Database;
  open?: OpenMcpProtocolClient;
  now?: () => number;
}

function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : "The MCP operation failed.";
  const printable = Array.from(raw, (character) =>
    character.charCodeAt(0) < 32 ? " " : character,
  ).join("");
  return printable.length <= MCP_ERROR_MAX_CHARS
    ? printable
    : `${printable.slice(0, MCP_ERROR_MAX_CHARS - 1)}…`;
}

/** Main-owned settings owner. No SDK or repository file crosses this boundary. */
export class McpSettingsService {
  readonly #db: Database.Database;
  readonly #open: OpenMcpProtocolClient;
  readonly #now: () => number;

  constructor(options: McpSettingsOptions) {
    this.#db = options.db;
    this.#open = options.open ?? openMcpProtocolClient;
    this.#now = options.now ?? Date.now;
  }

  list(projectId: string): readonly McpServerRecord[] {
    return listMcpServers(this.#db, projectId);
  }

  selectedTools(projectId: string): readonly McpToolDefinition[] {
    return selectedMcpToolDefinitions(this.#db, projectId);
  }

  async test(input: { projectId: string; server: unknown }): Promise<McpCatalogResult> {
    const prepared = this.#prepare(input.projectId, input.server);
    if (!prepared.ok) return prepared;
    try {
      const catalog = await discoverMcpServer({
        server: prepared.server,
        workspacePath: prepared.workspacePath,
        enabledToolNames: [],
        signal: new AbortController().signal,
        open: this.#open,
      });
      return { ok: true, catalog };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  async save(input: {
    projectId: string;
    server: unknown;
    enabledTools: readonly string[];
  }): Promise<McpServerResult> {
    const prepared = this.#prepare(input.projectId, input.server);
    if (!prepared.ok) return prepared;
    const existing = getMcpServer(this.#db, prepared.server.id);
    if (existing !== undefined && existing.projectId !== input.projectId) {
      return { ok: false, error: "That MCP server id belongs to another project." };
    }
    try {
      const catalog = await discoverMcpServer({
        server: prepared.server,
        workspacePath: prepared.workspacePath,
        enabledToolNames: input.enabledTools,
        signal: new AbortController().signal,
        open: this.#open,
      });
      const invalid = catalog.filter((tool) => tool.definition === null);
      if (existing !== undefined && invalid.length > 0) {
        throw new Error(
          `Could not refresh ${prepared.server.name}: ${invalid.length} tool definition${invalid.length === 1 ? " is" : "s are"} invalid or unsupported.`,
        );
      }
      const discovered = new Map(catalog.map((tool) => [tool.name, tool]));
      for (const enabled of input.enabledTools) {
        const tool = discovered.get(enabled);
        if (tool?.definition === undefined || tool.definition === null) {
          throw new Error(`Enabled MCP tool ${enabled} was not discovered.`);
        }
      }
      const now = this.#now();
      return {
        ok: true,
        server: putMcpServer(this.#db, {
          ...prepared.server,
          projectId: input.projectId,
          catalog,
          stale: false,
          error: null,
          refreshedAt: now,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }),
      };
    } catch (error) {
      const errorText = message(error);
      if (existing === undefined) return { ok: false, error: errorText };
      return {
        ok: false,
        error: errorText,
        server: markMcpServerRefreshFailure(this.#db, existing.id, errorText, this.#now()),
      };
    }
  }

  async refresh(input: { projectId: string; serverId: string }): Promise<McpServerResult> {
    const existing = this.#owned(input.projectId, input.serverId);
    if (!existing.ok) return existing;
    const enabledTools = existing.server.catalog
      .filter((tool) => tool.enabled)
      .map((tool) => tool.name);
    return this.save({ projectId: input.projectId, server: existing.server, enabledTools });
  }

  setEnabled(input: { projectId: string; serverId: string; enabled: boolean }): McpServerResult {
    const existing = this.#owned(input.projectId, input.serverId);
    if (!existing.ok) return existing;
    return {
      ok: true,
      server: putMcpServer(this.#db, {
        ...existing.server,
        enabled: input.enabled,
        updatedAt: this.#now(),
      }),
    };
  }

  setTools(input: {
    projectId: string;
    serverId: string;
    enabledTools: readonly string[];
  }): McpServerResult {
    const existing = this.#owned(input.projectId, input.serverId);
    if (!existing.ok) return existing;
    const selected = new Set(input.enabledTools);
    for (const name of selected) {
      const tool = existing.server.catalog.find((candidate) => candidate.name === name);
      if (tool?.definition === undefined || tool.definition === null) {
        return { ok: false, error: `Enabled MCP tool ${name} was not discovered.` };
      }
    }
    return {
      ok: true,
      server: putMcpServer(this.#db, {
        ...existing.server,
        catalog: existing.server.catalog.map((tool) =>
          Object.assign({}, tool, {
            enabled: tool.definition !== null && selected.has(tool.name),
          }),
        ),
        updatedAt: this.#now(),
      }),
    };
  }

  remove(input: { projectId: string; serverId: string }): McpMutationResult {
    return deleteMcpServer(this.#db, input.projectId, input.serverId)
      ? { ok: true }
      : { ok: false, error: "MCP server not found." };
  }

  #prepare(
    projectId: string,
    candidate: unknown,
  ): { ok: true; server: McpServerDraft; workspacePath: string } | { ok: false; error: string } {
    const project = getProjectById(this.#db, projectId);
    if (project === undefined) return { ok: false, error: "Project not found." };
    if (candidate === null || typeof candidate !== "object") {
      return { ok: false, error: "MCP server configuration is invalid." };
    }
    const row = candidate as Record<string, unknown>;
    const sanitized = sanitizeMcpServerDraft({
      id: row["id"],
      name: row["name"],
      enabled: row["enabled"],
      transport: row["transport"],
    });
    return sanitized.ok
      ? { ok: true, server: sanitized.server, workspacePath: project.path }
      : { ok: false, error: sanitized.reason };
  }

  #owned(projectId: string, serverId: string): McpServerResult {
    const server = getMcpServer(this.#db, serverId);
    return server === undefined || server.projectId !== projectId
      ? { ok: false, error: "MCP server not found." }
      : { ok: true, server };
  }
}
