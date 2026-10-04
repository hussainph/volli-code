import { createConnection } from "node:net";

import { AGENT_ERROR_CODES, makeAgentError } from "@volli/shared";
import type { AgentErrorCode, AgentRequest, AgentResponse } from "@volli/shared";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The Volli contract variables, as the `ctx.env` block a request carries.
 *
 * One builder for every caller, because there are four of them — `probe`,
 * `readHelpRuntime`, `runCli` and `runHook` — and each hand-rolled the same
 * four-way spread. VC-163 had to add `token` to all four, which is the tell: a
 * field the door reads is a field every door-facing request needs, and a
 * caller that forgets one does not fail, it silently sends less. For `token`
 * that means silently dropping to the unauthenticated actor.
 *
 * Empty strings are treated as absent throughout. The door has to be able to
 * tell "Volli exported nothing" from "a caller supplied a blank string", and an
 * exported `VOLLI_SESSION_TOKEN=""` would otherwise arrive as a token-shaped
 * field it has to reason about.
 *
 * Overrides let a caller state a value it resolved itself rather than read —
 * `readHelpRuntime` and `runHook` both resolve a socket path through their own
 * fallbacks before they get here. They are spread last and plainly: a caller
 * that has nothing to say omits the key rather than passing `undefined`, which
 * is what every caller already does and what keeps this a spread rather than a
 * merge with a rule in it.
 */
export function agentRequestEnv(
  env: Record<string, string | undefined>,
  overrides: AgentRequest["ctx"]["env"] = {},
): AgentRequest["ctx"]["env"] {
  const named = (name: string): string | undefined => env[name] || undefined;
  const socket = named("VOLLI_SOCKET");
  const session = named("VOLLI_SESSION");
  // Forwarded verbatim, never inspected: the CLI cannot mint one and cannot say
  // whether one means anything. It is transport for a secret Volli exported
  // into this attachment, and the door is the only judge of it.
  const token = named("VOLLI_SESSION_TOKEN");
  const ticket = named("VOLLI_TICKET");
  return {
    ...(socket === undefined ? {} : { socket }),
    ...(session === undefined ? {} : { session }),
    ...(token === undefined ? {} : { token }),
    ...(ticket === undefined ? {} : { ticket }),
    ...overrides,
  };
}

/**
 * What reading the operator's token file found: the token, a reason not to
 * use it, or nothing there.
 */
export type OperatorTokenFileRead =
  | { readonly token: string }
  | { readonly warning: string }
  | null;

/**
 * The operator token this invocation sends, if any (VC-623).
 *
 * The precedence rule is the whole of this function, and its first line is the
 * one that matters: **beside any Session evidence, none — and the file is never
 * read.** A Session's `volli` keeps sending exactly what it sent before this
 * existed, so the agent path does not change, and a Session that can somehow
 * see a person's token still cannot present it beside its own identity. The
 * door enforces the same rule from its side; this keeps the CLI from asking.
 *
 * Otherwise `VOLLI_OPERATOR_TOKEN`, then the operator's own 0600 file. Empty
 * values are absent, as everywhere in the request environment.
 */
export async function operatorTokenFor(
  env: Readonly<Record<string, string | undefined>>,
  readTokenFile: () => Promise<OperatorTokenFileRead>,
): Promise<{ token?: string; warning?: string }> {
  if (env["VOLLI_SESSION_TOKEN"] !== undefined || env["VOLLI_SESSION"] !== undefined) return {};
  const exported = env["VOLLI_OPERATOR_TOKEN"]?.trim();
  if (exported) return { token: exported };
  const read = await readTokenFile();
  if (read === null) return {};
  return "token" in read ? { token: read.token } : { warning: read.warning };
}

/** The file-system calls {@link readOperatorTokenFile} makes; tests script them. */
export interface OperatorTokenFileSystem {
  lstat(path: string): Promise<{ isFile(): boolean; mode: number; uid: number }>;
  readFile(path: string): Promise<string>;
  /** The invoking user's uid, or `null` where the platform has none. */
  uid(): number | null;
}

/**
 * Reads the operator token file, refusing it the way ssh refuses a private
 * key: a file other users can read, that another user owns, or that is not a
 * regular file is not used, and the warning names the fix. A missing or empty
 * file is simply no token.
 */
export async function readOperatorTokenFile(
  path: string,
  fs: OperatorTokenFileSystem,
): Promise<OperatorTokenFileRead> {
  let stat;
  try {
    stat = await fs.lstat(path);
  } catch {
    return null;
  }
  const uid = fs.uid();
  if (!stat.isFile() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    return {
      warning: `volli: not using ${path}: it must be a regular file you own that only you can read (chmod 600 ${path}).\n`,
    };
  }
  let text;
  try {
    text = await fs.readFile(path);
  } catch {
    return null;
  }
  const token = text.trim();
  return token.length === 0 ? null : { token };
}

export class AgentClientError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentClientError";
  }
}

function parseResponse(line: string): AgentResponse {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new AgentClientError("SOCKET_PROTOCOL", "The app returned malformed JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentClientError("SOCKET_PROTOCOL", "The app returned an invalid response.");
  }
  const response = value as Record<string, unknown>;
  if (response["v"] !== 1 || typeof response["ok"] !== "boolean") {
    throw new AgentClientError("SOCKET_PROTOCOL", "The app returned an unsupported response.");
  }
  if (response["ok"] === true) {
    if (!("data" in response)) {
      throw new AgentClientError(
        "SOCKET_PROTOCOL",
        "The app returned an invalid success response.",
      );
    }
    return { v: 1, ok: true, data: response["data"] };
  }
  const error = response["error"];
  if (
    typeof error !== "object" ||
    error === null ||
    Array.isArray(error) ||
    typeof (error as Record<string, unknown>)["code"] !== "string" ||
    !(AGENT_ERROR_CODES as readonly string[]).includes(
      (error as Record<string, unknown>)["code"] as string,
    ) ||
    typeof (error as Record<string, unknown>)["message"] !== "string"
  ) {
    throw new AgentClientError("SOCKET_PROTOCOL", "The app returned an invalid error response.");
  }
  const typedError = error as {
    code: AgentErrorCode;
    message: string;
    reason?: unknown;
    next?: unknown;
  };
  if (
    (typedError.reason !== undefined && typeof typedError.reason !== "string") ||
    (typedError.next !== undefined &&
      typedError.next !== null &&
      typeof typedError.next !== "string")
  ) {
    throw new AgentClientError("SOCKET_PROTOCOL", "The app returned invalid error guidance.");
  }
  const normalized = makeAgentError(
    typedError.code,
    typedError.message,
    typedError.next === undefined ? undefined : (typedError.next as string | null),
  );
  return {
    v: 1,
    ok: false,
    error:
      typeof typedError.reason === "string"
        ? { ...normalized, reason: typedError.reason }
        : normalized,
  };
}

export interface AgentClientOptions {
  timeoutMs: number;
}

/** Performs one NDJSON request against the app-owned Unix socket. */
export function requestAgent(
  socketPath: string,
  request: AgentRequest,
  options: AgentClientOptions,
): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let receivedBytes = 0;
    let settled = false;
    let connected = false;
    const finish = (action: () => void): void => {
      /* v8 ignore next -- competing socket events may finish the same request; the guard is defensive */
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new AgentClientError("TIMEOUT", "Timed out waiting for Volli.")));
    }, options.timeoutMs);

    socket.once("connect", () => {
      connected = true;
      socket.end(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        finish(() =>
          reject(new AgentClientError("SOCKET_PROTOCOL", "The app response is too large.")),
        );
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = parseResponse(buffer.slice(0, newline));
        finish(() => resolve(response));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("error", (error) => {
      // A pre-connect failure (no listener, permission denied, ...) means the
      // app itself is unreachable — the retryable exit-3 class. An error
      // after "connect" fired (e.g. ECONNRESET mid-response) means the app
      // was there but the exchange broke, which is a protocol-level failure,
      // not an app-availability one.
      finish(() =>
        reject(
          connected
            ? new AgentClientError(
                "SOCKET_PROTOCOL",
                `The connection to Volli broke: ${error.message}`,
              )
            : new AgentClientError(
                "APP_UNREACHABLE",
                `Volli is not reachable at ${socketPath}: ${error.message}`,
              ),
        ),
      );
    });
    socket.once("end", () => {
      /* v8 ignore next -- a settled request destroys the socket before a meaningful late end event */
      if (settled || buffer.includes("\n")) return;
      finish(() =>
        reject(new AgentClientError("SOCKET_PROTOCOL", "The app closed without a response.")),
      );
    });
  });
}
