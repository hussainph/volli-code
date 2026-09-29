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
import {
  McpTransportFailure,
  type McpProtocolClient,
  type OpenMcpProtocolClient,
} from "./discovery";

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

/**
 * `pending`, unless `signal` aborts first.
 *
 * The caller stops waiting; the work behind `pending` does not stop. That is
 * the point: a shared connection one caller gave up on is still the
 * connection every other caller is waiting for.
 */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
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
 * One protocol client a host opened for one server, and the calls on it.
 *
 * Identity matters more than the server id it is filed under: a call that
 * fails retires the connection IT used, and only if that connection is still
 * the one the host would hand out — never whichever one happens to be cached
 * by the time its failure is noticed.
 */
interface ClientEntry {
  readonly opening: Promise<McpProtocolClient>;
  /** Calls holding this client, from acquisition until they settle. */
  inFlight: number;
  /** No longer handed to new calls; closed once `inFlight` reaches zero. */
  retired: boolean;
  closing: Promise<void> | undefined;
}

/**
 * Attachment-scoped MCP connection owner. Clients are opened lazily, reused by
 * server id, and all retired when the attachment closes.
 *
 * One client per server is shared by every call this attachment makes to it,
 * so no single call may decide its fate (VC-454). A connection is opened under
 * the attachment's lifetime, not under the signal of whichever call asked
 * first; a caller that gives up stops waiting and the open carries on for the
 * rest. A client is retired only when a call on it fails with
 * {@link McpTransportFailure} — never for a call's own abort, a server's error
 * answer, a timeout or an oversized result — and a retired client is closed
 * only after the last call still running on it settles, so a sibling that
 * could still succeed is not cut off by someone else's failure.
 */
export class McpSessionHost {
  readonly port: RuntimeMcpPort;
  readonly #workspacePath: string;
  readonly #servers: ReadonlyMap<string, McpServerDraft>;
  readonly #open: OpenMcpProtocolClient;
  readonly #clients = new Map<string, ClientEntry>();
  /** Retired clients still draining; owned here so `close()` can reach them. */
  readonly #retired = new Set<ClientEntry>();
  readonly #lifetime = new AbortController();
  #closed = false;

  constructor(options: McpSessionHostOptions) {
    this.#workspacePath = options.workspacePath;
    this.#servers = new Map(options.servers.map((server) => [server.id, server]));
    this.#open = options.open ?? openMcpProtocolClient;
    this.port = { call: (request, signal) => this.#call(request, signal) };
  }

  #entry(server: McpServerDraft): ClientEntry {
    const existing = this.#clients.get(server.id);
    if (existing !== undefined) return existing;
    const entry: ClientEntry = {
      opening: this.#open(server, this.#workspacePath, this.#lifetime.signal),
      inFlight: 0,
      retired: false,
      closing: undefined,
    };
    this.#clients.set(server.id, entry);
    // A connection that never opened has nothing to close; it is simply no
    // longer the one handed out. Registered before any caller awaits it.
    entry.opening.catch(() => {
      if (this.#clients.get(server.id) === entry) this.#clients.delete(server.id);
    });
    return entry;
  }

  #retire(serverId: string, entry: ClientEntry): void {
    if (this.#clients.get(serverId) === entry) this.#clients.delete(serverId);
    if (entry.retired) return;
    entry.retired = true;
    this.#retired.add(entry);
  }

  #closeEntry(entry: ClientEntry): Promise<void> {
    entry.closing ??= entry.opening.then(
      (client) => client.close().catch(() => undefined),
      () => undefined,
    );
    return entry.closing;
  }

  async #call(request: RuntimeMcpCall, signal: AbortSignal): Promise<RuntimeMcpCallResult> {
    if (this.#closed) throw new Error("MCP attachment is closed");
    const server = this.#servers.get(request.serverId);
    if (server === undefined || !server.enabled) throw new Error(SAFE_UNAVAILABLE);
    signal.throwIfAborted();
    const combined = combineSignals(this.#lifetime.signal, signal);
    const entry = this.#entry(server);
    entry.inFlight += 1;
    try {
      const client = await untilAborted(entry.opening, combined.signal);
      const result = await client.callTool({
        name: request.toolName,
        arguments: request.arguments,
        signal: combined.signal,
      });
      return convertResult(result);
    } catch (error) {
      // This call was withdrawn, or the attachment closed under it. Either way
      // the connection did nothing wrong and stays for every other caller.
      if (combined.signal.aborted) throw combined.signal.reason;
      if (error instanceof Error && error.message === "MCP result exceeded the safe size limit") {
        throw error;
      }
      if (error instanceof McpTransportFailure) this.#retire(server.id, entry);
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
      entry.inFlight -= 1;
      if (entry.retired && entry.inFlight === 0 && this.#retired.delete(entry)) {
        await this.#closeEntry(entry);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.abort(new Error("MCP attachment closed"));
    const entries = [...this.#clients.values(), ...this.#retired];
    this.#clients.clear();
    this.#retired.clear();
    await Promise.allSettled(entries.map((entry) => this.#closeEntry(entry)));
  }
}
