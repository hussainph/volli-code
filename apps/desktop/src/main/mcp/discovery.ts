import {
  MCP_DESCRIPTION_MAX_CHARS,
  MCP_TOOL_COUNT_MAX,
  MCP_TOOL_NAME_MAX_CHARS,
  sanitizeMcpToolDefinition,
  type McpCatalogTool,
  type McpJsonObject,
  type McpServerDraft,
} from "@volli/shared";

export interface McpProtocolTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** SDK-free client seam used by discovery and live attachment hosts. */
export interface McpProtocolCallResult {
  content: readonly unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpProtocolClient {
  listTools(signal: AbortSignal): Promise<readonly McpProtocolTool[]>;
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
      });
      if (!sanitized.ok) {
        return {
          name: bounded(tool.name, MCP_TOOL_NAME_MAX_CHARS),
          description: bounded(tool.description ?? "", MCP_DESCRIPTION_MAX_CHARS),
          enabled: false,
          definition: null,
          error: sanitized.reason,
        };
      }
      return {
        name: sanitized.definition.toolName,
        description: sanitized.definition.description,
        enabled: enabled.has(sanitized.definition.toolName),
        definition: {
          ...sanitized.definition,
          inputSchema: sanitized.definition.inputSchema as McpJsonObject,
        },
        error: null,
      };
    });
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (error instanceof Error && /duplicate tool|tool limit/i.test(error.message)) throw error;
    throw new Error(`Could not discover tools from ${input.server.name}.`, { cause: error });
  } finally {
    await client?.close().catch(() => undefined);
  }
}
