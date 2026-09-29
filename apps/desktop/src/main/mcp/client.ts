import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECTION_TIMEOUT_MS,
  sanitizeMcpServerDraft,
  type McpServerDraft,
} from "@volli/shared";

import type { McpProtocolClient, McpProtocolTool, OpenMcpProtocolClient } from "./discovery";

const MCP_STDIO_BUFFER_MAX_BYTES = 1 * 1_024 * 1_024;
const LAUNCH_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
] as const;

/** Explicit launch allowlist: no provider, Session, Agent CLI, or telemetry secrets. */
export function mcpLaunchEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of LAUNCH_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export interface CloseableMcpClient {
  listTools(
    params?: undefined,
    options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number },
  ): Promise<{ tools: readonly McpProtocolTool[] }>;
  callTool(
    params: { name: string; arguments: Readonly<Record<string, unknown>> },
    options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number },
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** SDK object narrowed behind the port consumed by the rest of Electron main. */
export function protocolClientForConnectedClient(
  client: CloseableMcpClient,
  closeTransport?: () => Promise<void>,
): McpProtocolClient {
  let closed = false;
  return {
    async listTools(signal) {
      const result = await client.listTools(undefined, {
        signal,
        timeout: MCP_CONNECTION_TIMEOUT_MS,
        maxTotalTimeout: MCP_CONNECTION_TIMEOUT_MS,
      });
      return result.tools;
    },
    callTool: ({ name, arguments: arguments_, signal }) =>
      client.callTool(
        { name, arguments: arguments_ },
        { signal, timeout: MCP_CALL_TIMEOUT_MS, maxTotalTimeout: MCP_CALL_TIMEOUT_MS },
      ),
    async close() {
      if (closed) return;
      closed = true;
      await closeTransport?.().catch(() => undefined);
      await client.close();
    },
  };
}

function transportFor(
  server: McpServerDraft,
  workspacePath: string,
): {
  transport: Transport;
  beforeClose?: () => Promise<void>;
} {
  if (server.transport.type === "stdio") {
    const transport = new StdioClientTransport({
      command: server.transport.command,
      args: [...server.transport.args],
      cwd: workspacePath,
      env: mcpLaunchEnvironment(),
      stderr: "ignore",
      maxBufferSize: MCP_STDIO_BUFFER_MAX_BYTES,
    });
    return { transport };
  }
  const transport = new StreamableHTTPClientTransport(new URL(server.transport.url));
  return { transport, beforeClose: () => transport.terminateSession() };
}

/** Create, initialize, and own one v2 client for one server. */
export const openMcpProtocolClient: OpenMcpProtocolClient = async (
  candidate,
  workspacePath,
  signal,
) => {
  const sanitized = sanitizeMcpServerDraft(candidate);
  if (!sanitized.ok) throw new Error(sanitized.reason);
  signal.throwIfAborted();
  const client = new Client(
    { name: "volli-code", version: "0.2" },
    {
      listMaxPages: 64,
      versionNegotiation: {
        mode: "auto",
        probe: { timeoutMs: Math.min(1_000, MCP_CONNECTION_TIMEOUT_MS), maxRetries: 0 },
      },
      inputRequired: { autoFulfill: false },
    },
  );
  const { transport, beforeClose } = transportFor(sanitized.server, workspacePath);
  try {
    await client.connect(transport, {
      signal,
      timeout: MCP_CONNECTION_TIMEOUT_MS,
      maxTotalTimeout: MCP_CONNECTION_TIMEOUT_MS,
    });
    return protocolClientForConnectedClient(client, beforeClose);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
};
