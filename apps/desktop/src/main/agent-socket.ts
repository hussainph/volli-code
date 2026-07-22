import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";

import {
  AGENT_COMMANDS,
  errorMessage,
  type AgentCommand,
  type AgentRequest,
  type AgentResponse,
} from "@volli/shared";

const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 64;

export interface AgentSocketOptions {
  socketPath: string;
  requestTimeoutMs?: number;
  execute(request: AgentRequest): Promise<AgentResponse>;
}

export interface AgentSocketServer {
  close(): Promise<void>;
}

function socketFailure(message: string): AgentResponse {
  return { v: 1, ok: false, error: { code: "SOCKET_PROTOCOL", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentCommand(value: unknown): value is AgentCommand {
  return typeof value === "string" && (AGENT_COMMANDS as readonly string[]).includes(value);
}

function parseRequest(line: string): AgentRequest | AgentResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return socketFailure("Request must be one line of valid JSON.");
  }
  if (
    !isRecord(parsed) ||
    parsed["v"] !== 1 ||
    !isAgentCommand(parsed["cmd"]) ||
    !isRecord(parsed["args"]) ||
    !isRecord(parsed["ctx"]) ||
    typeof parsed["ctx"]["cwd"] !== "string" ||
    !isRecord(parsed["ctx"]["env"])
  ) {
    return socketFailure("Request does not match the v1 agent protocol.");
  }
  const env = parsed["ctx"]["env"];
  if (
    [env["session"], env["ticket"], env["socket"]].some(
      (value) => value !== undefined && typeof value !== "string",
    )
  ) {
    return socketFailure("Request environment values must be strings.");
  }
  return parsed as unknown as AgentRequest;
}

function writeResponse(socket: Socket, response: AgentResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function handleConnection(
  socket: Socket,
  execute: AgentSocketOptions["execute"],
  requestTimeoutMs: number,
): void {
  socket.setEncoding("utf8");
  let body = "";
  let receivedBytes = 0;
  let handled = false;
  socket.setTimeout(requestTimeoutMs, () => {
    if (handled) return;
    handled = true;
    writeResponse(socket, socketFailure("Request timed out."));
  });
  socket.on("data", (chunk: string) => {
    if (handled) return;
    body += chunk;
    receivedBytes += Buffer.byteLength(chunk);
    if (receivedBytes > MAX_REQUEST_BYTES) {
      handled = true;
      socket.setTimeout(0);
      writeResponse(socket, socketFailure("Request exceeds the one-megabyte limit."));
      return;
    }
    const newline = body.indexOf("\n");
    if (newline === -1) return;
    handled = true;
    socket.setTimeout(0);
    const request = parseRequest(body.slice(0, newline));
    if (!("cmd" in request)) {
      writeResponse(socket, request);
      return;
    }
    void execute(request)
      .then((response) => writeResponse(socket, response))
      .catch((error: unknown) =>
        writeResponse(socket, {
          v: 1,
          ok: false,
          error: {
            code: "MUTATION_FAILED",
            message: errorMessage(error),
          },
        }),
      );
  });
  socket.on("error", () => {
    // Individual client failures do not take down the listening socket.
  });
}

async function unlinkSocket(socketPath: string): Promise<void> {
  try {
    const entry = await lstat(socketPath);
    if (!entry.isSocket()) {
      throw new Error(`Refusing to replace non-socket path ${socketPath}`);
    }
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Starts the private, one-request-per-connection NDJSON agent surface. */
export async function startAgentSocket(options: AgentSocketOptions): Promise<AgentSocketServer> {
  await unlinkSocket(options.socketPath);
  const server = createServer((socket) =>
    handleConnection(
      socket,
      options.execute,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ),
  );
  server.maxConnections = MAX_CONNECTIONS;
  // Belt-and-braces against the create-then-chmod race: `listen()` creates the
  // socket file with umask-default perms, and another local process could open
  // it in the window before the `chmod` below lands. A restrictive umask makes
  // the file arrive at 0o600 already; the process-global umask is restored
  // (both success and error paths) the instant `listen` resolves so it never
  // leaks into unrelated file creation elsewhere in the process.
  const previousUmask = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(options.socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } finally {
    process.umask(previousUmask);
  }
  try {
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    await unlinkSocket(options.socketPath).catch(() => undefined);
    throw error;
  }
  return {
    async close(): Promise<void> {
      await closeServer(server);
      await unlinkSocket(options.socketPath);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
