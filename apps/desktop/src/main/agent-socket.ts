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

export interface AgentSocketOptions {
  socketPath: string;
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

function handleConnection(socket: Socket, execute: AgentSocketOptions["execute"]): void {
  socket.setEncoding("utf8");
  let body = "";
  let handled = false;
  socket.on("data", (chunk: string) => {
    if (handled) return;
    body += chunk;
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      handled = true;
      writeResponse(socket, socketFailure("Request exceeds the one-megabyte limit."));
      return;
    }
    const newline = body.indexOf("\n");
    if (newline === -1) return;
    handled = true;
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
  const server = createServer((socket) => handleConnection(socket, options.execute));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(options.socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  await chmod(options.socketPath, 0o600);
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
