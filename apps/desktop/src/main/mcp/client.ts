/**
 * The MCP client behind {@link OpenMcpProtocolClient}, on `@earendil-works/pi-mcp`
 * (VC-470; VC-8 built the port on the official SDK).
 *
 * Discovery, the verbs and the per-attachment host see only the port, so the
 * swap lives here. What this module keeps from VC-8, bound for bound:
 *
 * - **Deadlines.** The handshake and a catalog read each get
 *   {@link MCP_CONNECTION_TIMEOUT_MS} in total; a tool call gets
 *   {@link MCP_CALL_TIMEOUT_MS}. Progress notifications do not extend a call.
 * - **Paging.** A catalog is read at most {@link MCP_LIST_MAX_PAGES} pages deep
 *   (pi-mcp's own `listTools` allows a thousand), with a repeated cursor
 *   refused rather than followed.
 * - **Framing.** One stdio message may be at most 1 MB.
 * - **Environment.** A local server gets {@link mcpLaunchEnvironment}'s fixed
 *   allowlist and nothing inherited — pi-mcp inherits the whole environment
 *   unless told not to — plus the person's own env entries, resolved now.
 * - **Working directory.** Always the project root.
 *
 * PROTOCOL VERSIONS. pi-mcp opens with `initialize` at `2025-11-25` and accepts
 * a server that answers `2025-06-18`, `2025-03-26` or `2024-11-05`. The SDK it
 * replaces was dual-era: it also probed `server/discover` for the
 * `2026-07-28` revision and accepted the pre-release `2024-10-07`. A dual-era
 * server answers `initialize` and keeps working; a server that speaks ONLY
 * `2026-07-28` refuses the handshake, and that refusal is recognised and
 * reported as {@link McpProtocolEraError} rather than as an opaque failure.
 *
 * STDIO SHUTDOWN. pi-mcp starts each server in its own process group and, on
 * close, ends stdin, then signals SIGTERM and SIGKILL to the whole group, so a
 * server started through `npx` or `uvx` takes its wrapper's children with it.
 * It also SIGTERMs every live group when the host process exits.
 */
import {
  McpAbortError,
  McpAuthRequiredError,
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpHttpError,
  McpTimeoutError,
  StdioTransport,
  StreamableHttpTransport,
  type AuthProvider,
  type CallToolResult,
  type McpFetch,
  type McpRequestOptions,
  type McpTransport,
} from "@earendil-works/pi-mcp";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECTION_TIMEOUT_MS,
  mcpServerUsesOAuth,
  sanitizeMcpServerDraft,
  type McpServerDraft,
} from "@volli/shared";

import { MemoryMcpCredentialStore } from "./credential-store";
import {
  connectionProblemIn,
  McpConnectionProblem,
  McpCredentialRejectedError,
  McpProtocolEraError,
  McpSignInRequiredError,
  resolveMcpCredentialEntries,
  type McpCredentialSources,
} from "./credentials";
import {
  McpTransportFailure,
  type McpProtocolClient,
  type McpProtocolTool,
  type OpenMcpProtocolClient,
} from "./discovery";

/** The largest single stdio message a server may send. */
export const MCP_STDIO_BUFFER_MAX_BYTES = 1 * 1_024 * 1_024;
/** The deepest a catalog read follows `nextCursor`. */
export const MCP_LIST_MAX_PAGES = 64;

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

/** The slice of pi-mcp's client the port wraps; narrowed so tests can stand one in. */
export interface CloseableMcpClient {
  request<Result = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<Result>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One `tools/list` page, checked the way the SDK this replaced checked it. */
function toolsPage(value: unknown): { tools: McpProtocolTool[]; nextCursor?: string } {
  if (!isRecord(value) || !Array.isArray(value["tools"])) {
    throw new McpError(-32600, "Invalid MCP tools/list result");
  }
  for (const tool of value["tools"] as unknown[]) {
    if (
      !isRecord(tool) ||
      typeof tool["name"] !== "string" ||
      !isRecord(tool["inputSchema"]) ||
      (tool["description"] !== undefined && typeof tool["description"] !== "string")
    ) {
      throw new McpError(-32600, "Invalid entry in MCP tools/list result");
    }
  }
  const nextCursor = value["nextCursor"];
  if (nextCursor !== undefined && typeof nextCursor !== "string") {
    throw new McpError(-32600, "Invalid MCP tools/list cursor");
  }
  return {
    tools: value["tools"] as McpProtocolTool[],
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** A signal that aborts with the caller's, or by itself after `ms`. */
function withDeadline(
  signal: AbortSignal,
  ms: number,
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("MCP deadline elapsed")), ms);
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    },
  };
}

/**
 * The HTTP statuses that end a Streamable HTTP protocol session: 404 for a
 * session the server no longer knows, which the MCP transport says a client
 * MUST answer by starting a new one, and 400 for a request the server could
 * not tie to a session. Any other status — a 429 above all — is the server
 * answering this request, and reconnecting would only add a handshake to a
 * server that is already asking for less.
 */
const SESSION_ENDING_HTTP_STATUSES: ReadonlySet<number> = new Set([400, 404]);

/**
 * Whether a rejected call means the connection is unusable (VC-454, on pi-mcp
 * since VC-470).
 *
 * Decided here because this is the one module that may name the client
 * library's error types; the host above sees only {@link McpTransportFailure}.
 * A JSON-RPC error is the server answering, so the connection is fine, and so
 * is a result that failed validation. An HTTP status that ends the protocol
 * session, a closed connection, a call deadline the server let pass, and
 * anything that is not one of the library's errors at all (a socket, a spawn,
 * a fetch that never reached the server) are the connection failing. A
 * refusal for want of a sign-in or a credential is neither: it is answered by
 * a person, and the connection stays. The caller's own abort never reaches
 * this function.
 */
export function isMcpTransportFailure(error: unknown): boolean {
  if (connectionProblemIn(error) !== null) return false;
  if (error instanceof McpAuthRequiredError) return false;
  if (error instanceof McpHttpError) return SESSION_ENDING_HTTP_STATUSES.has(error.status);
  if (error instanceof McpError || error instanceof McpAbortError) return false;
  if (error instanceof McpConnectionClosedError || error instanceof McpTimeoutError) return true;
  return true;
}

/** A pi-mcp client narrowed behind the port the rest of Electron main consumes. */
export function protocolClientForConnectedClient(client: CloseableMcpClient): McpProtocolClient {
  let closed = false;
  return {
    async listTools(signal) {
      const startedAt = Date.now();
      const deadline = withDeadline(signal, MCP_CONNECTION_TIMEOUT_MS);
      try {
        const tools: McpProtocolTool[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < MCP_LIST_MAX_PAGES; page += 1) {
          const remaining = Math.max(1, MCP_CONNECTION_TIMEOUT_MS - (Date.now() - startedAt));
          const result = toolsPage(
            await client.request("tools/list", cursor === undefined ? undefined : { cursor }, {
              signal: deadline.signal,
              timeoutMs: remaining,
            }),
          );
          tools.push(...result.tools);
          if (result.nextCursor === undefined) return tools;
          if (cursors.has(result.nextCursor)) {
            throw new Error("MCP tools/list returned a cursor it had already returned.");
          }
          cursors.add(result.nextCursor);
          cursor = result.nextCursor;
        }
        throw new Error(`MCP tools/list exceeded ${MCP_LIST_MAX_PAGES} pages.`);
      } finally {
        deadline.release();
      }
    },
    async callTool({ name, arguments: arguments_, signal }) {
      try {
        return await client.callTool(
          name,
          { ...arguments_ },
          { signal, timeoutMs: MCP_CALL_TIMEOUT_MS },
        );
      } catch (error) {
        // The caller's own abort is never the transport failing.
        if (signal.aborted || !isMcpTransportFailure(error)) throw error;
        throw new McpTransportFailure({ cause: error });
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
    },
  };
}

/**
 * Everything a connection needs to authenticate, injected by whoever owns the
 * credential store. Absent, a server is connected with no credential at all —
 * which is every server configured before VC-470.
 */
export interface McpConnectionCredentials {
  /** Where references and stored secrets are read from, for this connection. */
  sources: () => McpCredentialSources;
  /** The OAuth auth provider for a remote server, or `undefined` when it does not sign in. */
  auth?: (server: McpServerDraft, sources: McpCredentialSources) => AuthProvider | undefined;
  /** A connection to this server completed its handshake. */
  onConnected?: (server: McpServerDraft) => void;
}

/**
 * Fetch that sets the person's headers on EVERY request, resolved at the time
 * of the request.
 *
 * Per request rather than once at connect, for the same reason OAuth tokens are
 * read per request: a value a person stores or replaces while a Session is
 * running reaches that Session's next call, with no reattachment.
 */
function credentialFetch(
  server: McpServerDraft,
  sources: () => McpCredentialSources,
  base: McpFetch = (input, init) => fetch(input, init),
): McpFetch {
  const entries =
    server.transport.type === "streamable-http" ? server.transport.headers : undefined;
  if (entries === undefined || entries.length === 0) return base;
  return (input, init) => {
    const values = resolveMcpCredentialEntries(server, "header", entries, sources());
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(values)) headers.set(name, value);
    return base(input, { ...init, headers });
  };
}

function transportFor(
  server: McpServerDraft,
  workspacePath: string,
  credentials: McpConnectionCredentials,
  auth: AuthProvider | undefined,
): McpTransport {
  if (server.transport.type === "stdio") {
    const env = resolveMcpCredentialEntries(
      server,
      "env",
      server.transport.env,
      credentials.sources(),
    );
    return new StdioTransport({
      command: server.transport.command,
      args: [...server.transport.args],
      cwd: workspacePath,
      // Never inherit: pi-mcp would otherwise hand the server Volli's whole
      // environment. The allowlist, then what the person configured for it.
      inheritEnv: false,
      env: { ...mcpLaunchEnvironment(), ...env },
      // Drained into a bounded ring nobody reads: a server's stderr can echo
      // the environment it was given, so it is never surfaced or logged.
      stderr: "pipe",
      maxStderrBytes: 16 * 1_024,
      maxMessageBytes: MCP_STDIO_BUFFER_MAX_BYTES,
    });
  }
  return new StreamableHttpTransport({
    url: server.transport.url,
    fetch: credentialFetch(server, credentials.sources),
    ...(auth === undefined ? {} : { authProvider: auth }),
  });
}

/** Whether a handshake refusal names the modern-only `2026-07-28` revision. */
function refusedAsModernOnly(error: unknown): boolean {
  const texts: string[] = [];
  if (error instanceof McpError) {
    texts.push(error.message, JSON.stringify(error.data ?? null));
  } else if (error instanceof McpHttpError) {
    texts.push(error.body);
  }
  return texts.some((text) => text.includes("2026-07-28"));
}

/**
 * Translate what a refused connection or call means into a problem Volli can
 * name: a 401 the auth provider could not answer is a sign-in, and a
 * handshake refused for the modern-only revision is said as that. Anything
 * else is returned unchanged, for the caller's generic sentence.
 */
export function classifyMcpConnectionError(
  error: unknown,
  server: Pick<McpServerDraft, "name" | "transport">,
): unknown {
  if (connectionProblemIn(error) !== null) return error;
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof McpAuthRequiredError) {
      // A server carrying the person's own Authorization header does not sign
      // in: a 401 there says the configured credential was refused.
      const headers =
        server.transport.type === "streamable-http" ? server.transport.headers : undefined;
      return mcpServerUsesOAuth(headers)
        ? new McpSignInRequiredError(server.name, false)
        : new McpCredentialRejectedError(
            server.name,
            (headers ?? []).map((entry) => `header ${entry.name}`),
          );
    }
    current = current.cause;
  }
  if (refusedAsModernOnly(error)) return new McpProtocolEraError(server.name);
  return error;
}

/** Build the opener every MCP connection in main goes through. */
export function createMcpProtocolClientOpener(
  credentials: McpConnectionCredentials = {
    sources: () => ({ store: new MemoryMcpCredentialStore(), environment: process.env }),
  },
  overrides: { auth?: AuthProvider } = {},
): OpenMcpProtocolClient {
  return async (candidate, workspacePath, signal) => {
    const sanitized = sanitizeMcpServerDraft(candidate);
    if (!sanitized.ok) throw new Error(sanitized.reason);
    signal.throwIfAborted();
    const server = sanitized.server;
    const auth = overrides.auth ?? credentials.auth?.(server, credentials.sources());
    const transport = transportFor(server, workspacePath, credentials, auth);
    const client = new McpClient({
      name: "volli-code",
      version: "0.2",
      requestTimeoutMs: MCP_CONNECTION_TIMEOUT_MS,
    });
    // The handshake takes no signal of its own, so cancellation and the
    // overall deadline both end it the one way it can be ended: by closing.
    const deadline = withDeadline(signal, MCP_CONNECTION_TIMEOUT_MS);
    const stop = (): void => {
      void client.close().catch(() => undefined);
    };
    deadline.signal.addEventListener("abort", stop, { once: true });
    try {
      await client.connect(transport);
      deadline.signal.throwIfAborted();
      credentials.onConnected?.(server);
      return protocolClientForConnectedClient(client);
    } catch (error) {
      await client.close().catch(() => undefined);
      if (signal.aborted) throw signal.reason;
      if (error instanceof McpConnectionProblem) throw error;
      throw classifyMcpConnectionError(error, server);
    } finally {
      deadline.signal.removeEventListener("abort", stop);
      deadline.release();
    }
  };
}

/** The opener with no credentials: every server configured before VC-470. */
export const openMcpProtocolClient: OpenMcpProtocolClient = createMcpProtocolClientOpener();
