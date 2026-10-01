import {
  MCP_RESULT_MAX_CHARS,
  type McpConnectionBlock,
  type McpJsonValue,
  type McpServerDraft,
  type McpToolDefinition,
  type RuntimeAskChoice,
  type RuntimeAskRequest,
  type RuntimeMcpCall,
  type RuntimeMcpCallResult,
  type RuntimeMcpContent,
} from "@volli/shared";

import { classifyMcpConnectionError, openMcpProtocolClient } from "./client";
import { mcpConnectionBlock } from "./credentials";
import type { McpProtocolClient, OpenMcpProtocolClient } from "./discovery";
import type { McpSignInOutcome } from "./oauth";

const SAFE_UNAVAILABLE = "MCP server is unavailable for this Session";

/**
 * The attachment's parked-question machinery, lent to one call (VC-470).
 *
 * The same port `mcp_install` confirms through: a question the person driving
 * answers, recorded in the Session's interaction ledger. Absent when the call
 * arrived with nobody to ask.
 */
export type McpHostAsk = (
  request: RuntimeAskRequest,
  signal: AbortSignal,
) => Promise<RuntimeAskChoice>;

/** What the host hands the runtime: the call, plus the ask it may raise. */
export interface McpHostPort {
  call(
    request: RuntimeMcpCall,
    signal: AbortSignal,
    ask?: McpHostAsk,
  ): Promise<RuntimeMcpCallResult>;
}

export interface McpSessionHostOptions {
  workspacePath: string;
  servers: readonly McpServerDraft[];
  open?: OpenMcpProtocolClient;
  /**
   * Moves when a server's stored secrets change. A client opened before the
   * move is retired before the next call, so a value a person just stored
   * reaches a running Session without reattaching it.
   */
  credentialsRevision?: (serverId: string) => number;
  /** Run a person's sign-in for one server, once they have allowed it. */
  signIn?: (server: McpServerDraft, signal: AbortSignal) => Promise<McpSignInOutcome>;
}

/** A call outcome the host can route: done, blocked on a person, or failed. */
type Attempt =
  | { kind: "result"; result: RuntimeMcpCallResult }
  | { kind: "blocked"; block: McpConnectionBlock }
  | { kind: "failed" };

function errorResult(text: string): RuntimeMcpCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Every live host, so an app quit can close the ones a Session teardown missed. */
const LIVE_HOSTS = new Set<McpSessionHost>();

/**
 * Close every attachment's MCP connections — and with them every stdio
 * server's process group. The accepted-quit path calls this after the
 * Sessions have closed, as the backstop for an attachment whose own close
 * never ran; pi-mcp's process-exit hook is the backstop after that.
 */
export async function closeAllMcpSessionHosts(): Promise<void> {
  await Promise.allSettled([...LIVE_HOSTS].map((host) => host.close()));
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
    // Parsed from the wire as JSON by the client. The encode/parse copy removes
    // any mutable prototype-bearing value before the runtime sees it.
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
 *
 * VC-470 adds one duty: a call blocked on something only a person can give —
 * a sign-in, a credential — is routed to that person through the ask the
 * attachment lends, and retried once if they provide it. The model receives
 * an outcome (the call's real result, or that the person declined, or that
 * the credential is still missing), never the credential.
 */
export class McpSessionHost {
  readonly port: McpHostPort;
  readonly #workspacePath: string;
  readonly #servers: ReadonlyMap<string, McpServerDraft>;
  readonly #open: OpenMcpProtocolClient;
  readonly #revision: (serverId: string) => number;
  readonly #signIn: McpSessionHostOptions["signIn"];
  readonly #clients = new Map<string, { opening: Promise<McpProtocolClient>; revision: number }>();
  readonly #lifetime = new AbortController();
  #closed = false;

  constructor(options: McpSessionHostOptions) {
    this.#workspacePath = options.workspacePath;
    this.#servers = new Map(options.servers.map((server) => [server.id, server]));
    this.#open = options.open ?? openMcpProtocolClient;
    this.#revision = options.credentialsRevision ?? (() => 0);
    this.#signIn = options.signIn;
    this.port = { call: (request, signal, ask) => this.#call(request, signal, ask) };
    LIVE_HOSTS.add(this);
  }

  async #client(server: McpServerDraft, signal: AbortSignal): Promise<McpProtocolClient> {
    const revision = this.#revision(server.id);
    const existing = this.#clients.get(server.id);
    if (existing !== undefined && existing.revision === revision) return existing.opening;
    if (existing !== undefined) {
      // Opened with credentials a person has since replaced: retire it.
      this.#clients.delete(server.id);
      void existing.opening.then((client) => client.close()).catch(() => undefined);
    }
    const combined = combineSignals(this.#lifetime.signal, signal);
    const opening = this.#open(server, this.#workspacePath, combined.signal).finally(
      combined.release,
    );
    const entry = { opening, revision };
    this.#clients.set(server.id, entry);
    try {
      return await opening;
    } catch (error) {
      if (this.#clients.get(server.id) === entry) this.#clients.delete(server.id);
      throw error;
    }
  }

  async #call(
    request: RuntimeMcpCall,
    signal: AbortSignal,
    ask: McpHostAsk | undefined,
  ): Promise<RuntimeMcpCallResult> {
    if (this.#closed) throw new Error("MCP attachment is closed");
    const server = this.#servers.get(request.serverId);
    if (server === undefined || !server.enabled) throw new Error(SAFE_UNAVAILABLE);
    signal.throwIfAborted();
    const combined = combineSignals(this.#lifetime.signal, signal);
    try {
      const first = await this.#attempt(server, request, combined.signal);
      if (first.kind === "result") return first.result;
      if (first.kind === "failed") return this.#failed(server);
      const routed = await this.#route(server, first.block, request, combined.signal, ask);
      if (routed !== "retry") return routed;
      const second = await this.#attempt(server, request, combined.signal);
      if (second.kind === "result") return second.result;
      if (second.kind === "failed") return this.#failed(server);
      return errorResult(
        second.block.kind === "sign-in"
          ? `${safeSummary(server.name, "The server")} still refused the call after the sign-in, so it was not made. A person can sign in again in Settings \u2192 Configure \u2192 MCP Servers.`
          : `${safeSummary(server.name, "The server")} is still missing ${second.block.missing.join(", ")}, so the call was not made. Only a person can add it, in Settings \u2192 Configure \u2192 MCP Servers.`,
      );
    } finally {
      combined.release();
    }
  }

  /** One try at the call. Throws only for an abort or an oversized result. */
  async #attempt(
    server: McpServerDraft,
    request: RuntimeMcpCall,
    signal: AbortSignal,
  ): Promise<Attempt> {
    let client: McpProtocolClient | null = null;
    try {
      client = await this.#client(server, signal);
      const result = await client.callTool({
        name: request.toolName,
        arguments: request.arguments,
        signal,
      });
      return { kind: "result", result: convertResult(result) };
    } catch (error) {
      if (error instanceof Error && error.message === "MCP result exceeded the safe size limit") {
        throw error;
      }
      if (this.#clients.get(server.id) !== undefined) this.#clients.delete(server.id);
      await client?.close().catch(() => undefined);
      if (signal.aborted) throw signal.reason;
      const block = mcpConnectionBlock(classifyMcpConnectionError(error, server));
      return block === undefined ? { kind: "failed" } : { kind: "blocked", block };
    }
  }

  #failed(server: McpServerDraft): RuntimeMcpCallResult {
    return errorResult(`MCP server ${safeSummary(server.name, "configured")} call failed.`);
  }

  /**
   * Put a blocked call in front of the person driving, and say what happened.
   *
   * Returns `"retry"` only when the person provided what was missing; every
   * other path is the call's final result. Nothing here carries a value: the
   * question names the server, the tool and the slot, and the answer the model
   * reads is one of signed in (the retried call's own result), declined, or
   * still missing.
   */
  async #route(
    server: McpServerDraft,
    block: McpConnectionBlock,
    request: RuntimeMcpCall,
    signal: AbortSignal,
    ask: McpHostAsk | undefined,
  ): Promise<RuntimeMcpCallResult | "retry"> {
    const name = safeSummary(server.name, "The server");
    const signIn = block.kind === "sign-in" ? this.#signIn : undefined;
    if (ask === undefined || (block.kind === "sign-in" && signIn === undefined)) {
      return errorResult(
        block.kind === "sign-in"
          ? `${name} needs a person to sign in before ${request.toolName} can run, and nobody could be asked from this Session. A person can sign in from Settings \u2192 Configure \u2192 MCP Servers. The call was not made.`
          : `${name} needs ${block.missing.join(", ")} before ${request.toolName} can run, and only a person can add it, in Settings \u2192 Configure \u2192 MCP Servers. Nobody could be asked from this Session. The call was not made.`,
      );
    }
    let choice: RuntimeAskChoice;
    try {
      choice = await ask(
        block.kind === "sign-in"
          ? {
              cause: "confirm.mcp-sign-in",
              tool: request.toolName,
              toolCallId: request.toolCallId,
              turnId: null,
              reason: `${name} needs you to sign in before ${request.toolName} can run${block.insufficientScope ? ", with more access than it was granted" : ""}. Allowing opens ${name}'s sign-in page in your browser; the agent learns only whether the sign-in worked.`,
              trip: "confirm",
              overridable: true,
            }
          : {
              cause: "confirm.mcp-credential",
              tool: request.toolName,
              toolCallId: request.toolCallId,
              turnId: null,
              reason: `${name} needs ${block.missing.join(", ")} before ${request.toolName} can run. Add it in Settings \u2192 Configure \u2192 MCP Servers, then allow to retry the call. The agent never sees the value.`,
              trip: "confirm",
              overridable: true,
            },
        signal,
      );
    } catch {
      if (signal.aborted) throw signal.reason;
      return errorResult(
        `Volli could not put this in front of anyone, so ${request.toolName} was not called.`,
      );
    }
    if (choice !== "allow") {
      return errorResult(
        block.kind === "sign-in"
          ? `The person driving declined to sign in to ${name}, so ${request.toolName} was not called.`
          : `The person driving declined to add ${block.missing.join(", ")} for ${name}, so ${request.toolName} was not called.`,
      );
    }
    if (signIn !== undefined) {
      const outcome = await signIn(server, signal);
      if (signal.aborted) throw signal.reason;
      if (!outcome.ok) {
        return errorResult(`${outcome.message} ${request.toolName} was not called.`);
      }
    }
    return "retry";
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    LIVE_HOSTS.delete(this);
    this.#lifetime.abort(new Error("MCP attachment closed"));
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(clients.map(async (client) => (await client.opening).close()));
  }
}
