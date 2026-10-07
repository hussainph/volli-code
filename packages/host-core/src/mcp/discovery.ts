import {
  MCP_DESCRIPTION_MAX_CHARS,
  MCP_TOOL_COUNT_MAX,
  MCP_TOOL_NAME_MAX_CHARS,
  sanitizeMcpToolDefinition,
  sanitizeMcpToolHints,
  type McpCatalogTool,
  type McpJsonObject,
  type McpServerDraft,
} from "@volli/shared";

import { connectionProblemIn } from "./credentials";
import { hostLogger } from "../log/root";

const log = hostLogger("mcp");

export interface McpProtocolTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  /** The schema of the tool's `structuredContent`, when the server publishes one (VC-469). */
  outputSchema?: unknown;
  /** A human-readable name, shown in Settings only (`sanitizeMcpToolHints`). */
  title?: unknown;
  /** The server's behaviour annotations, shown in Settings only (`sanitizeMcpToolHints`). */
  annotations?: unknown;
}

/** Client-library-free seam used by discovery and live attachment hosts. */
export interface McpProtocolCallResult {
  content: readonly unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * The connection to an MCP server failed, as opposed to the server answering.
 *
 * `callTool` rejects with this only when the transport itself is gone or
 * refused the exchange: a closed stdio pipe, a dropped socket, an HTTP status
 * that ends the protocol session. A JSON-RPC error the server sent, a local
 * timeout, a result that failed validation and the caller's own abort all
 * reject with something else, because each of them leaves the connection
 * usable for every other call sharing it. The host retires a client on this
 * error and on nothing else (VC-454).
 */
export class McpTransportFailure extends Error {
  constructor(options?: { cause?: unknown }) {
    super("MCP transport failed", options);
    this.name = "McpTransportFailure";
  }
}

export interface McpProtocolClient {
  listTools(signal: AbortSignal): Promise<readonly McpProtocolTool[]>;
  /** Rejects with {@link McpTransportFailure} when the connection itself failed. */
  callTool(input: {
    name: string;
    arguments: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
  }): Promise<McpProtocolCallResult>;
  close(): Promise<void>;
}

export type OpenMcpProtocolClient = (
  server: McpServerDraft,
  workspacePath: string,
  signal: AbortSignal,
) => Promise<McpProtocolClient>;

export interface DiscoverMcpServerInput {
  server: McpServerDraft;
  workspacePath: string;
  enabledToolNames: readonly string[];
  signal: AbortSignal;
  open: OpenMcpProtocolClient;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Connect, handshake and read the complete tool catalog through one bounded client. */
export async function discoverMcpServer(
  input: DiscoverMcpServerInput,
): Promise<readonly McpCatalogTool[]> {
  input.signal.throwIfAborted();
  let client: McpProtocolClient | null = null;
  try {
    client = await input.open(input.server, input.workspacePath, input.signal);
    input.signal.throwIfAborted();
    const tools = await client.listTools(input.signal);
    if (tools.length > MCP_TOOL_COUNT_MAX) {
      throw new Error(`Server exceeds the ${MCP_TOOL_COUNT_MAX}-tool limit.`);
    }
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new Error(
          `Server returned duplicate tool ${bounded(tool.name, MCP_TOOL_NAME_MAX_CHARS)}.`,
        );
      }
      seen.add(tool.name);
    }
    const enabled = new Set(input.enabledToolNames);
    return tools.map((tool): McpCatalogTool => {
      const sanitized = sanitizeMcpToolDefinition({
        serverId: input.server.id,
        serverName: input.server.name,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // An output schema that fails the input-schema bounds is left off and
        // the tool stays usable: it only types the structured half of a result.
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      });
      // Not shown in Settings: the tool works without it, so there is nothing
      // to ask a person to do, but someone wondering why a tool is untyped
      // finds the reason in the main-process log.
      if (sanitized.ok && sanitized.outputSchemaRejected !== undefined) {
        log.warn("left off a tool's output schema", {
          server: input.server.name,
          tool: bounded(tool.name, MCP_TOOL_NAME_MAX_CHARS),
          reason: sanitized.outputSchemaRejected,
        });
      }
      // Display-only: a server's labels sort a catalog in Settings and are
      // never part of the definition a Session freezes (see McpToolHints).
      const hints = sanitizeMcpToolHints(tool);
      const entry: McpCatalogTool = sanitized.ok
        ? {
            name: sanitized.definition.toolName,
            description: sanitized.definition.description,
            enabled: enabled.has(sanitized.definition.toolName),
            definition: {
              ...sanitized.definition,
              inputSchema: sanitized.definition.inputSchema as McpJsonObject,
            },
            error: null,
          }
        : {
            name: bounded(tool.name, MCP_TOOL_NAME_MAX_CHARS),
            description: bounded(tool.description ?? "", MCP_DESCRIPTION_MAX_CHARS),
            enabled: false,
            definition: null,
            error: sanitized.reason,
          };
      if (hints !== undefined) entry.hints = hints;
      return entry;
    });
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (error instanceof Error && /duplicate tool|tool limit/i.test(error.message)) throw error;
    // Volli's own sentences — a sign-in, a missing credential, an unsupported
    // revision — say what to do, so they are passed through rather than
    // flattened into the generic one below, which exists to keep a third
    // party's error text out of view.
    const problem = connectionProblemIn(error);
    if (problem !== null) throw problem;
    throw new Error(`Could not discover tools from ${input.server.name}.`, { cause: error });
  } finally {
    await client?.close().catch(() => undefined);
  }
}
