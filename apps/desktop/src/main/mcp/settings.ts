import type Database from "better-sqlite3";
import {
  MCP_CONNECTION_TIMEOUT_MS,
  MCP_ERROR_MAX_CHARS,
  sanitizeMcpProvenance,
  sanitizeMcpServerDraft,
  UNKNOWN_MCP_PROVENANCE,
  type McpServerDraft,
  type McpServerProvenance,
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

/** The message a cancelled attempt returns, distinct from every other failure. */
export const MCP_CANCELLED_MESSAGE = "The MCP connection was cancelled before it finished.";

/**
 * The message a timed-out attempt returns (VC-380).
 *
 * A caller that asked for an install and got "it stopped" has two very
 * different next moves depending on which stop it was: a cancellation is its
 * own doing and can be retried immediately, while a timeout says the server
 * never answered and retrying unchanged will probably time out again. The two
 * were indistinguishable before this, because the internal deadline was the
 * only thing that could stop an install at all.
 */
function timeoutMessage(serverName: string): string {
  return `${serverName} did not answer within the ${MCP_CONNECTION_TIMEOUT_MS / 1_000}s MCP connection limit.`;
}

/**
 * Whether an attempt that failed had already spent its whole deadline.
 *
 * Measured, never read off the error text. The obvious implementation is a
 * regex for "timed out" across the cause chain, and it is wrong twice: it makes
 * the classification depend on wording the MCP SDK never promised, and it
 * relabels a SERVER's own fault — "upstream database timeout" is a sentence a
 * third-party process is entitled to print — as Volli's connection limit. What
 * actually distinguishes the two is whether the attempt ran out the clock, and
 * that is a number this service already has a seam for.
 */
function spentItsDeadline(elapsedMs: number): boolean {
  return elapsedMs >= MCP_CONNECTION_TIMEOUT_MS;
}

export interface McpSettingsOptions {
  db: Database.Database;
  open?: OpenMcpProtocolClient;
  /**
   * The clock, for stored timestamps AND for how long an attempt has run.
   *
   * One seam rather than two: a second "elapsed" clock would be a second thing
   * every test has to know about, and the one question this clock answers about
   * a failed attempt — did it spend the full {@link MCP_CONNECTION_TIMEOUT_MS}
   * — is the same question a frozen test clock answers as "no".
   */
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

  /**
   * Connect and read the catalog without saving anything.
   *
   * `signal` is the caller's, and supplying one is the only way an attempt can
   * be stopped early: before VC-380 both this and {@link save} passed a signal
   * nobody held, so the internal 10-second deadline was the sole exit.
   */
  async test(input: {
    projectId: string;
    server: unknown;
    signal?: AbortSignal;
  }): Promise<McpCatalogResult> {
    const prepared = this.#prepare(input.projectId, input.server);
    if (!prepared.ok) return prepared;
    const signal = input.signal ?? new AbortController().signal;
    const startedAt = this.#now();
    try {
      const catalog = await discoverMcpServer({
        server: prepared.server,
        workspacePath: prepared.workspacePath,
        enabledToolNames: [],
        signal,
        open: this.#open,
      });
      return { ok: true, catalog };
    } catch (error) {
      return { ok: false, error: this.#stopped(error, signal, prepared.server.name, startedAt) };
    }
  }

  async save(input: {
    projectId: string;
    server: unknown;
    enabledTools: readonly string[];
    /** Where this configuration came from. Recorded as given; nothing verifies it. */
    provenance?: unknown;
    signal?: AbortSignal;
  }): Promise<McpServerResult> {
    const prepared = this.#prepare(input.projectId, input.server);
    if (!prepared.ok) return prepared;
    const existing = getMcpServer(this.#db, prepared.server.id);
    if (existing !== undefined && existing.projectId !== input.projectId) {
      return { ok: false, error: "That MCP server id belongs to another project." };
    }
    // Validated BEFORE anything is connected: a provenance note this build
    // could not read back is a caller mistake, and spending a handshake to
    // discover it would be spending a process launch on a typo.
    const provenance = sanitizeMcpProvenance(input.provenance);
    if (!provenance.ok) return { ok: false, error: provenance.reason };
    // An origin nobody restated is the origin already on file. A refresh
    // rediscovers tools; it learns nothing new about where the config came
    // from, so it must not erase what an install recorded.
    const recorded: McpServerProvenance =
      input.provenance === undefined
        ? (existing?.provenance ?? UNKNOWN_MCP_PROVENANCE)
        : provenance.provenance;
    const signal = input.signal ?? new AbortController().signal;
    const startedAt = this.#now();
    try {
      const catalog = await discoverMcpServer({
        server: prepared.server,
        workspacePath: prepared.workspacePath,
        enabledToolNames: input.enabledTools,
        signal,
        open: this.#open,
      });
      // The last gate before the only write in this method. Discovery checks
      // the signal on the way in and around the handshake, but a cancellation
      // that lands while the catalog is being validated would otherwise be
      // noticed by nobody, and acceptance 6 promises a cancelled install leaves
      // NO partial configuration — not "almost none".
      signal.throwIfAborted();
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
          provenance: recorded,
          catalog,
          stale: false,
          error: null,
          refreshedAt: now,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }),
      };
    } catch (error) {
      const errorText = this.#stopped(error, signal, prepared.server.name, startedAt);
      if (existing === undefined) return { ok: false, error: errorText };
      return {
        ok: false,
        error: errorText,
        server: markMcpServerRefreshFailure(this.#db, existing.id, errorText, this.#now()),
      };
    }
  }

  async refresh(input: {
    projectId: string;
    serverId: string;
    signal?: AbortSignal;
  }): Promise<McpServerResult> {
    const existing = this.#owned(input.projectId, input.serverId);
    if (!existing.ok) return existing;
    const enabledTools = existing.server.catalog
      .filter((tool) => tool.enabled)
      .map((tool) => tool.name);
    return this.save({
      projectId: input.projectId,
      server: existing.server,
      enabledTools,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
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

  /**
   * Why an attempt stopped, in the caller's own words.
   *
   * Three outcomes a caller acts on differently: it cancelled, the server never
   * answered, or the connection genuinely failed. Both tests are structural.
   * The signal is asked first because an abort surfaces as whatever the SDK
   * happened to throw, and the signal is the only reliable witness to it; the
   * clock is asked second because a deadline is a duration, not a spelling.
   * Neither reads the error's own text, which is a third party's prose.
   */
  #stopped(error: unknown, signal: AbortSignal, serverName: string, startedAt: number): string {
    if (signal.aborted) return MCP_CANCELLED_MESSAGE;
    if (spentItsDeadline(this.#now() - startedAt)) return timeoutMessage(serverName);
    return message(error);
  }

  #owned(projectId: string, serverId: string): McpServerResult {
    const server = getMcpServer(this.#db, serverId);
    return server === undefined || server.projectId !== projectId
      ? { ok: false, error: "MCP server not found." }
      : { ok: true, server };
  }
}
