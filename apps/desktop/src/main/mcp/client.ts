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
 * - **Framing.** One message may be at most 8 MiB plus framing on either transport.
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
 * `2026-07-28` refuses the handshake. A structured UnsupportedProtocolVersion
 * refusal (-32022, data.supported) is reported as {@link McpProtocolEraError}
 * when it advertises that revision and none this client accepts. Prose alone
 * cannot identify the era. Modern discovery/calls still await pi-mcp support.
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
  SUPPORTED_PROTOCOL_VERSIONS,
  type AuthProvider,
  type CallToolResult,
  type McpFetch,
  type McpRequestOptions,
  type McpTransport,
} from "@earendil-works/pi-mcp";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECTION_TIMEOUT_MS,
  MCP_PLAIN_HTTP_CREDENTIAL_REFUSAL,
  MCP_RESULT_MAX_BYTES,
  mcpEndpointMayCarryCredentials,
  mcpServerUsesOAuth,
  sanitizeMcpServerDraft,
  type McpServerDraft,
} from "@volli/shared";

import { MemoryMcpCredentialStore } from "./credential-store";
import {
  connectionProblemIn,
  McpConnectionProblem,
  McpCredentialRejectedError,
  McpInsecureEndpointError,
  McpMessageTooLargeError,
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

/**
 * The largest single stdio message a server may send: VC-469's
 * {@link MCP_RESULT_MAX_BYTES} (8 MiB) outer bound on one tool result, plus
 * room for the JSON-RPC envelope around it. The runtime cuts what the model
 * reads and saves the rest; this only has to let a result that size arrive.
 */
export const MCP_STDIO_BUFFER_MAX_BYTES = MCP_RESULT_MAX_BYTES + 64 * 1_024;
/**
 * The largest single message a Streamable HTTP server may send, on the same
 * terms: one JSON response body, or one SSE event. pi-mcp bounds an SSE event
 * itself but reads a JSON body whole, so {@link boundedFetch} bounds those.
 */
export const MCP_HTTP_MESSAGE_MAX_BYTES = MCP_STDIO_BUFFER_MAX_BYTES;
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

/**
 * One `tools/list` page, checked the way the SDK this replaced checked it.
 *
 * Each tool is passed on whole, `outputSchema` and annotations included, for
 * discovery to judge; only its shape is checked here.
 */
function toolsPage(value: unknown): { tools: McpProtocolTool[]; nextCursor?: string } {
  if (!isRecord(value) || !Array.isArray(value["tools"])) {
    throw new McpError(-32600, "Invalid MCP tools/list result");
  }
  for (const tool of value["tools"] as unknown[]) {
    if (
      !isRecord(tool) ||
      typeof tool["name"] !== "string" ||
      !isRecord(tool["inputSchema"]) ||
      (tool["outputSchema"] !== undefined && !isRecord(tool["outputSchema"])) ||
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
export function protocolClientForConnectedClient(
  client: CloseableMcpClient,
  hooks: {
    /** Why the connection was dropped from underneath, when Volli dropped it. */
    dropped?: () => Error | undefined;
    /** Runs after the client has closed: the stdio process-group backstop. */
    afterClose?: () => Promise<void>;
  } = {},
): McpProtocolClient {
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
        if (signal.aborted) throw error;
        // Dropped by Volli for a message over the bound: the connection is
        // gone, and the reason is Volli's to say rather than a silent timeout.
        const dropped = hooks.dropped?.();
        if (dropped !== undefined) throw new McpTransportFailure({ cause: dropped });
        if (!isMcpTransportFailure(error)) throw error;
        throw new McpTransportFailure({ cause: error });
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await client.close();
      } finally {
        await hooks.afterClose?.();
      }
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
 * Fetch that sets the person's headers on every request TO THE SERVER'S OWN
 * ENDPOINT, resolved at the time of the request.
 *
 * Per request rather than once at connect, for the same reason OAuth tokens are
 * read per request: a value a person stores or replaces while a Session is
 * running reaches that Session's next call, with no reattachment.
 *
 * Only to the endpoint, and never across a redirect. The transport hands this
 * same fetch to the OAuth code as `context.fetch`, which uses it for discovery
 * and token requests on hosts the server's metadata names; and an ordinary
 * redirect would carry a custom header wherever the server pointed it. So a
 * request for any other URL goes out bare, and a request that carries the
 * headers follows only a method-preserving redirect (307/308) within the
 * endpoint's own origin — any other redirect is returned to the transport,
 * which fails the request, rather than followed with the person's values.
 */
export function credentialFetch(
  server: McpServerDraft,
  sources: () => McpCredentialSources,
  base: McpFetch = (input, init) => fetch(input, init),
): McpFetch {
  const entries =
    server.transport.type === "streamable-http" ? server.transport.headers : undefined;
  if (
    server.transport.type !== "streamable-http" ||
    entries === undefined ||
    entries.length === 0
  ) {
    return base;
  }
  const endpoint = new URL(server.transport.url);
  return async (input, init) => {
    let target = new URL(String(input));
    if (target.href !== endpoint.href) return base(input, init);
    if (!mcpEndpointMayCarryCredentials(endpoint.href)) {
      throw new McpInsecureEndpointError(server.name, MCP_PLAIN_HTTP_CREDENTIAL_REFUSAL);
    }
    const values = resolveMcpCredentialEntries(server, "header", entries, sources());
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(values)) headers.set(name, value);
    for (let hop = 0; ; hop += 1) {
      const response = await base(target, { ...init, headers, redirect: "manual" });
      if (response.status !== 307 && response.status !== 308) return response;
      const location = response.headers.get("location");
      if (location === null || hop >= 4) return response;
      const next = new URL(location, target);
      if (next.origin !== endpoint.origin) return response;
      await response.body?.cancel().catch(() => undefined);
      target = next;
    }
  };
}

/** Statuses whose responses carry no body, and which `new Response` refuses one for. */
const BODILESS_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Fetch whose response bodies cannot exceed `maxBytes` — except an SSE stream,
 * which is long-lived by design and is bounded per event by the transport.
 *
 * pi-mcp reads a JSON response with `response.json()`, which has no limit of
 * its own; nothing in the main process may read an unbounded body from a
 * third party. A declared length over the bound is refused before reading, and
 * an undeclared one stops the read at the bound.
 */
export function boundedFetch(base: McpFetch, maxBytes: number): McpFetch {
  const tooLarge = (): Error => new McpMessageTooLargeError("The server", maxBytes);
  return async (input, init) => {
    const response = await base(input, init);
    const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    // An event stream is exempt only when it is one: a 2xx. An error answer
    // labelled `text/event-stream` is read whole by the transport, so it is
    // bounded like any other body.
    if (
      response.body === null ||
      (type === "text/event-stream" && response.ok) ||
      BODILESS_STATUSES.has(response.status)
    ) {
      return response;
    }
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw tooLarge();
    }
    let received = 0;
    const limited = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > maxBytes) controller.error(tooLarge());
          else controller.enqueue(chunk);
        },
      }),
    );
    return new Response(limited, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * pi-mcp sends notifications/cancelled but gives every HTTP POST the same
 * connection-wide signal. Preserve the old client's per-request withdrawal:
 * stateless servers have no session in which to match that notification.
 * Keep the request controller through SSE consumption, until its reply, and
 * never abort a sibling call or the server-to-client GET stream.
 */
function cancellableHttpTransport(
  options: ConstructorParameters<typeof StreamableHttpTransport>[0],
): StreamableHttpTransport {
  const requests = new Map<string | number, AbortController>();
  const baseFetch = options.fetch ?? fetch;
  const endpoint = new URL(options.url).href;
  const transport = new StreamableHttpTransport({
    ...options,
    fetch: (input, init) => {
      const message: unknown =
        String(input) === endpoint && init?.method === "POST" && typeof init.body === "string"
          ? JSON.parse(init.body)
          : null;
      const controller =
        isRecord(message) &&
        typeof message["method"] === "string" &&
        (typeof message["id"] === "string" || typeof message["id"] === "number")
          ? requests.get(message["id"])
          : undefined;
      return baseFetch(
        input,
        controller === undefined
          ? init
          : {
              ...init,
              signal:
                init?.signal == null
                  ? controller.signal
                  : AbortSignal.any([init.signal, controller.signal]),
            },
      );
    },
  });
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    if ("method" in message && message.method === "notifications/cancelled") {
      const id = isRecord(message.params) ? message.params["requestId"] : undefined;
      if (typeof id === "string" || typeof id === "number") {
        requests.get(id)?.abort(new McpAbortError());
      }
    }
    if (!("method" in message) || !("id" in message)) return send(message);
    requests.set(message.id, new AbortController());
    try {
      await send(message);
    } catch (error) {
      requests.delete(message.id);
      throw error;
    }
  };
  transport.onMessage((message) => {
    if (!("method" in message)) requests.delete(message.id);
  });
  transport.onClose(() => requests.clear());
  return transport;
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
  return cancellableHttpTransport({
    url: server.transport.url,
    fetch: boundedFetch(credentialFetch(server, credentials.sources), MCP_HTTP_MESSAGE_MAX_BYTES),
    maxMessageBytes: MCP_HTTP_MESSAGE_MAX_BYTES,
    ...(auth === undefined ? {} : { authProvider: auth }),
  });
}

/**
 * A recognized modern version error, not a version mentioned in arbitrary prose.
 * A dual-era advertisement is not a modern-only refusal: initialize can still
 * work with a revision pi-mcp accepts. Do not infer an era from other codes.
 */
function modernOnlyVersionError(code: unknown, data: unknown): boolean {
  if (code !== -32022 || !isRecord(data)) return false;
  const supported = data["supported"];
  if (!Array.isArray(supported) || !supported.every((version) => typeof version === "string")) {
    return false;
  }
  return (
    supported.includes("2026-07-28") &&
    !supported.some((version) =>
      (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version),
    )
  );
}

/**
 * Recognize pi-mcp's stdio JSON-RPC error, or a structured HTTP 400 error body.
 * HTTP validation errors may omit id (or use null), unlike stdio responses.
 * The body has already passed boundedFetch's message bound. This only names
 * a refused legacy handshake; transport-specific modern probing/fallback must
 * be implemented upstream in pi-mcp, not as a second client here.
 */
function refusedAsModernOnly(error: unknown): boolean {
  if (error instanceof McpError) return modernOnlyVersionError(error.code, error.data);
  if (!(error instanceof McpHttpError) || error.status !== 400) return false;
  let body: unknown;
  try {
    body = JSON.parse(error.body);
  } catch {
    return false;
  }
  if (
    !isRecord(body) ||
    body["jsonrpc"] !== "2.0" ||
    "result" in body ||
    "method" in body ||
    (body["id"] !== undefined &&
      body["id"] !== null &&
      typeof body["id"] !== "string" &&
      !(typeof body["id"] === "number" && Number.isFinite(body["id"]))) ||
    !isRecord(body["error"]) ||
    typeof body["error"]["message"] !== "string"
  ) {
    return false;
  }
  return modernOnlyVersionError(body["error"]["code"], body["error"]["data"]);
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

/**
 * After a stdio client has closed, end whatever is still in the server's
 * process group.
 *
 * pi-mcp signals the group when the server exits after stdin closes, but not
 * when the server had already exited (its helpers keep running), and it sends
 * no SIGKILL after that SIGTERM. This closes both gaps from Volli's side: if
 * anything is left in the group, SIGTERM, a short grace, then SIGKILL. The
 * group id is the server's own pid (pi-mcp starts it as a group leader); a
 * group with no members left answers ESRCH and is left alone, which keeps the
 * window for a reused id to the moment between the check and the signal.
 */
export async function endProcessGroup(group: number, graceMs = 2_000): Promise<void> {
  if (process.platform === "win32") return;
  const alive = (): boolean => {
    try {
      process.kill(-group, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return;
  try {
    process.kill(-group, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!alive()) return;
  }
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // Gone between the check and the signal.
  }
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
    // pi-mcp reports a stdio line over the bound as an error event and drops
    // it, leaving the request it answered to wait out its whole deadline. The
    // stream is no longer trustworthy past that point, so the connection is
    // closed at once and every waiting call learns why.
    let dropped: Error | undefined;
    client.onError((error) => {
      if (dropped !== undefined || !/^MCP stdio message exceeds \d+ bytes$/.test(error.message)) {
        return;
      }
      dropped = new McpMessageTooLargeError(server.name, MCP_STDIO_BUFFER_MAX_BYTES);
      void client.close().catch(() => undefined);
    });
    try {
      await client.connect(transport);
      deadline.signal.throwIfAborted();
      credentials.onConnected?.(server);
      const group = transport instanceof StdioTransport ? transport.pid : undefined;
      return protocolClientForConnectedClient(client, {
        dropped: () => dropped,
        ...(group === undefined ? {} : { afterClose: () => endProcessGroup(group) }),
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      if (signal.aborted) throw signal.reason;
      if (dropped !== undefined) throw dropped;
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
