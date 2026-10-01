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
  type RuntimeMcpPort,
} from "@volli/shared";

import { classifyMcpConnectionError, openMcpProtocolClient } from "./client";
import { mcpConnectionBlock } from "./credentials";
import {
  McpTransportFailure,
  type McpProtocolClient,
  type OpenMcpProtocolClient,
} from "./discovery";
import type { McpSignInOutcome } from "./oauth";

const SAFE_UNAVAILABLE = "MCP server is unavailable for this Session";

/**
 * The attachment's parked-question machinery, lent to one call (VC-470).
 *
 * The same port `server_install` confirms through: a question the person driving
 * answers, recorded in the Session's interaction ledger. Absent when the call
 * arrived with nobody to ask.
 */
export type McpHostAsk = (
  request: RuntimeAskRequest,
  signal: AbortSignal,
) => Promise<RuntimeAskChoice>;

/** A call port that may put a blocked call to the person driving. */
export interface McpHostPort {
  call(
    request: RuntimeMcpCall,
    signal: AbortSignal,
    ask?: McpHostAsk,
  ): Promise<RuntimeMcpCallResult>;
}

/**
 * A call that cannot run until a person gives something only they can: a
 * sign-in, or a credential (VC-470).
 *
 * Thrown by {@link McpSessionHost.rawPort} rather than turned into a result
 * there, so that the wait for the person happens OUTSIDE whatever bounds the
 * raw call — the per-server budget (VC-454) must not hold a slot for the
 * minutes a person spends in a browser. {@link McpSessionHost.routed} catches
 * it, asks, and retries.
 */
export class McpCallBlocked extends Error {
  readonly block: McpConnectionBlock;

  constructor(block: McpConnectionBlock) {
    super("MCP call is waiting on a person");
    this.name = "McpCallBlocked";
    this.block = block;
  }
}

export interface McpSessionHostOptions {
  workspacePath: string;
  servers: readonly McpServerDraft[];
  open?: OpenMcpProtocolClient;
  /**
   * Moves when a server's stored secrets change. A client opened before the
   * move is retired (drained, then closed) and the next call opens a fresh
   * one, so a value a person just stored reaches a running Session without
   * reattaching it.
   */
  credentialsRevision?: (serverId: string) => number;
  /** Run a person's sign-in for one server, once they have allowed it. */
  signIn?: (server: McpServerDraft, signal: AbortSignal) => Promise<McpSignInOutcome>;
}

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
 * One protocol client a host opened for one server, and the calls on it.
 *
 * Identity matters more than the server id it is filed under: a call that
 * fails retires the connection IT used, and only if that connection is still
 * the one the host would hand out — never whichever one happens to be cached
 * by the time its failure is noticed.
 */
interface ClientEntry {
  readonly opening: Promise<McpProtocolClient>;
  /** The credentials revision it was opened under (VC-470). */
  readonly revision: number;
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
  /** The call, routed: a call blocked on a person asks them and is retried once. */
  readonly port: McpHostPort;
  /**
   * The call alone, for a caller that bounds it (the per-server budget): it
   * throws {@link McpCallBlocked} instead of waiting on a person. Pair it with
   * {@link routed} outside the bound.
   */
  readonly rawPort: RuntimeMcpPort;
  readonly #workspacePath: string;
  readonly #servers: ReadonlyMap<string, McpServerDraft>;
  readonly #open: OpenMcpProtocolClient;
  readonly #revision: (serverId: string) => number;
  readonly #signIn: McpSessionHostOptions["signIn"];
  readonly #clients = new Map<string, ClientEntry>();
  /** Retired clients still draining or closing; owned here so `close()` can reach them. */
  readonly #retired = new Set<ClientEntry>();
  readonly #lifetime = new AbortController();
  #closed = false;

  constructor(options: McpSessionHostOptions) {
    this.#workspacePath = options.workspacePath;
    this.#servers = new Map(options.servers.map((server) => [server.id, server]));
    this.#open = options.open ?? openMcpProtocolClient;
    this.#revision = options.credentialsRevision ?? (() => 0);
    this.#signIn = options.signIn;
    this.rawPort = { call: (request, signal) => this.#call(request, signal) };
    this.port = this.routed(this.rawPort.call);
    LIVE_HOSTS.add(this);
  }

  #entry(server: McpServerDraft): ClientEntry {
    const revision = this.#revision(server.id);
    const existing = this.#clients.get(server.id);
    if (existing !== undefined && existing.revision === revision) return existing;
    // Opened with credentials a person has since replaced: drained and closed
    // like any retired client, never cut off under a sibling still using it.
    if (existing !== undefined) {
      this.#retire(server.id, existing);
      if (existing.inFlight === 0) {
        void this.#closeEntry(existing).then(() => this.#retired.delete(existing));
      }
    }
    const entry: ClientEntry = {
      opening: this.#open(server, this.#workspacePath, this.#lifetime.signal),
      revision,
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
      // Refused for want of a sign-in or a credential (VC-470). The connection
      // is fine — tokens and headers are read per request — so it is kept;
      // the person is asked outside any bound on this call.
      const block = mcpConnectionBlock(classifyMcpConnectionError(error, server));
      if (block !== undefined) throw new McpCallBlocked(block);
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
      // Not awaited: this call's answer does not wait on a goodbye to a
      // connection it no longer uses, which for HTTP is a request of its own.
      // The entry stays in `#retired` until the close lands, so `close()`
      // still waits for it.
      if (entry.retired && entry.inFlight === 0) {
        void this.#closeEntry(entry).then(() => this.#retired.delete(entry));
      }
    }
  }

  /**
   * `call`, with a blocked call put to the person driving (VC-470).
   *
   * Returns the retried call's own result when the person provided what was
   * missing; otherwise a result saying what happened — declined, still
   * missing, nobody to ask. Nothing here carries a value: the question names
   * the server, the tool and the slot.
   */
  routed(call: RuntimeMcpPort["call"]): McpHostPort {
    return {
      call: async (request, signal, ask) => {
        let blocked: McpConnectionBlock;
        try {
          return await call(request, signal);
        } catch (error) {
          if (!(error instanceof McpCallBlocked)) throw error;
          blocked = error.block;
        }
        const server = this.#servers.get(request.serverId);
        // Unreachable: a blocked call named a server this host bound.
        if (server === undefined) throw new Error(SAFE_UNAVAILABLE);
        const routed = await this.#route(server, blocked, request, signal, ask);
        if (routed !== "retry") return routed;
        try {
          return await call(request, signal);
        } catch (error) {
          if (!(error instanceof McpCallBlocked)) throw error;
          const name = safeSummary(server.name, "The server");
          return errorResult(
            error.block.kind === "sign-in"
              ? `${name} still refused the call after the sign-in, so it was not made. A person can sign in again in Settings \u2192 Configure \u2192 MCP Servers.`
              : `${name} is still missing ${error.block.missing.join(", ")}, so the call was not made. Only a person can add it, in Settings \u2192 Configure \u2192 MCP Servers.`,
          );
        }
      },
    };
  }

  /**
   * Put a blocked call in front of the person driving, and say what happened.
   * Returns `"retry"` only when the person provided what was missing.
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
      if (!outcome.ok) return errorResult(`${outcome.message} ${request.toolName} was not called.`);
    }
    return "retry";
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    LIVE_HOSTS.delete(this);
    this.#lifetime.abort(new Error("MCP attachment closed"));
    const entries = [...this.#clients.values(), ...this.#retired];
    this.#clients.clear();
    this.#retired.clear();
    await Promise.allSettled(entries.map((entry) => this.#closeEntry(entry)));
  }
}
