import {
  MCP_RESULT_MAX_CHARS,
  type McpJsonValue,
  type McpServerDraft,
  type McpToolDefinition,
  type RuntimeMcpCall,
  type RuntimeMcpCallResult,
  type RuntimeMcpContent,
  type RuntimeMcpPort,
} from "@volli/shared";

import { openMcpProtocolClient } from "./client";
import type { McpProtocolClient, OpenMcpProtocolClient } from "./discovery";

const SAFE_UNAVAILABLE = "MCP server is unavailable for this Session";

export interface McpSessionHostOptions {
  workspacePath: string;
  servers: readonly McpServerDraft[];
  open?: OpenMcpProtocolClient;
}

/**
 * Bind an existing Session only to configuration for the servers in its frozen
 * definitions. Current enablement selects tools for new Sessions; it cannot
 * revoke an existing Session's durable surface. A removed server is different:
 * there is no transport left to bind, so attachment must fail rather than
 * advertise a tool that cannot run.
 */
export function serversForFrozenMcpTools(
  configured: readonly McpServerDraft[],
  definitions: readonly McpToolDefinition[],
): readonly McpServerDraft[] {
  const byId = new Map(configured.map((server) => [server.id, server]));
  const seen = new Set<string>();
  const bound: McpServerDraft[] = [];
  for (const definition of definitions) {
    if (seen.has(definition.serverId)) continue;
    seen.add(definition.serverId);
    const server = byId.get(definition.serverId);
    if (server === undefined) {
      throw new Error(
        "A required MCP server is missing. Restore its configuration and retry the attachment.",
      );
    }
    bound.push({
      id: server.id,
      name: server.name,
      enabled: true,
      transport: server.transport,
    });
  }
  return bound;
}

function combineSignals(
  left: AbortSignal,
  right: AbortSignal,
): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const abort = (event: Event): void => {
    const source = event.target;
    controller.abort(source instanceof AbortSignal ? source.reason : undefined);
  };
  for (const signal of [left, right]) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    release: () => {
      left.removeEventListener("abort", abort);
      right.removeEventListener("abort", abort);
    },
  };
}

function safeSummary(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0
    ? Array.from(value.slice(0, 1_024), (character) =>
        character.charCodeAt(0) < 32 ? " " : character,
      ).join("")
    : fallback;
}

function convertContent(block: unknown): RuntimeMcpContent {
  if (block === null || typeof block !== "object") {
    return { type: "unsupported", text: "[unsupported MCP content]" };
  }
  const entry = block as Record<string, unknown>;
  if (entry.type === "text" && typeof entry.text === "string") {
    return { type: "text", text: entry.text };
  }
  if (
    entry.type === "image" &&
    typeof entry.data === "string" &&
    typeof entry.mimeType === "string"
  ) {
    return { type: "image", data: entry.data, mimeType: entry.mimeType };
  }
  if (entry.type === "resource_link") {
    const name = safeSummary(entry.name, "resource");
    const uri = safeSummary(entry.uri, "unknown URI");
    return { type: "unsupported", text: `[resource link: ${name} — ${uri}]` };
  }
  if (entry.type === "resource") {
    const resource =
      entry.resource !== null && typeof entry.resource === "object"
        ? (entry.resource as Record<string, unknown>)
        : {};
    return {
      type: "unsupported",
      text: `[embedded resource: ${safeSummary(resource.uri, "unknown URI")}]`,
    };
  }
  return {
    type: "unsupported",
    text: `[unsupported MCP content: ${safeSummary(entry.type, "unknown")}]`,
  };
}

function convertResult(
  result: Awaited<ReturnType<McpProtocolClient["callTool"]>>,
): RuntimeMcpCallResult {
  const content = result.content.map(convertContent);
  let structuredContent: McpJsonValue | undefined;
  if (result.structuredContent !== undefined) {
    // The SDK has validated this as JSON. The encode/parse copy removes any
    // mutable prototype-bearing value before the runtime sees it.
    structuredContent = JSON.parse(JSON.stringify(result.structuredContent)) as McpJsonValue;
  }
  const converted: RuntimeMcpCallResult = {
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    isError: result.isError ?? false,
  };
  if (JSON.stringify(converted).length > MCP_RESULT_MAX_CHARS) {
    throw new Error("MCP result exceeded the safe size limit");
  }
  return converted;
}

/**
 * Attachment-scoped MCP connection owner. Clients are opened lazily, reused by
 * server id, and all retired when the attachment closes.
 */
export class McpSessionHost {
  readonly port: RuntimeMcpPort;
  readonly #workspacePath: string;
  readonly #servers: ReadonlyMap<string, McpServerDraft>;
  readonly #open: OpenMcpProtocolClient;
  readonly #clients = new Map<string, Promise<McpProtocolClient>>();
  readonly #lifetime = new AbortController();
  #closed = false;

  constructor(options: McpSessionHostOptions) {
    this.#workspacePath = options.workspacePath;
    this.#servers = new Map(options.servers.map((server) => [server.id, server]));
    this.#open = options.open ?? openMcpProtocolClient;
    this.port = { call: (request, signal) => this.#call(request, signal) };
  }

  async #client(server: McpServerDraft, signal: AbortSignal): Promise<McpProtocolClient> {
    const existing = this.#clients.get(server.id);
    if (existing !== undefined) return existing;
    const combined = combineSignals(this.#lifetime.signal, signal);
    const opening = this.#open(server, this.#workspacePath, combined.signal).finally(
      combined.release,
    );
    this.#clients.set(server.id, opening);
    try {
      return await opening;
    } catch (error) {
      if (this.#clients.get(server.id) === opening) this.#clients.delete(server.id);
      throw error;
    }
  }

  async #call(request: RuntimeMcpCall, signal: AbortSignal): Promise<RuntimeMcpCallResult> {
    if (this.#closed) throw new Error("MCP attachment is closed");
    const server = this.#servers.get(request.serverId);
    if (server === undefined || !server.enabled) throw new Error(SAFE_UNAVAILABLE);
    signal.throwIfAborted();
    const combined = combineSignals(this.#lifetime.signal, signal);
    let client: McpProtocolClient | null = null;
    try {
      client = await this.#client(server, combined.signal);
      const result = await client.callTool({
        name: request.toolName,
        arguments: request.arguments,
        signal: combined.signal,
      });
      return convertResult(result);
    } catch (error) {
      if (error instanceof Error && error.message === "MCP result exceeded the safe size limit") {
        throw error;
      }
      if (this.#clients.get(server.id) !== undefined) this.#clients.delete(server.id);
      await client?.close().catch(() => undefined);
      if (combined.signal.aborted) throw combined.signal.reason;
      return {
        content: [
          {
            type: "text",
            text: `MCP server ${safeSummary(server.name, "configured")} call failed.`,
          },
        ],
        isError: true,
      };
    } finally {
      combined.release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.abort(new Error("MCP attachment closed"));
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(clients.map(async (client) => (await client).close()));
  }
}
