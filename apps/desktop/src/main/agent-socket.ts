import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";

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

type SetSocketMode = (socketPath: string, mode: number) => Promise<void>;

export type ShutdownAgentSocket = () => Promise<void>;

export interface AgentSocketLifecycle {
  start(options: AgentSocketOptions): Promise<void>;
  shutdown(): Promise<void>;
}

/** Owns socket startup, publication, and idempotent process-lifetime shutdown. */
export function createAgentSocketLifecycle(options: {
  start(
    options: AgentSocketOptions,
    claim: (server: AgentSocketServer) => void,
  ): Promise<AgentSocketServer>;
  reportFailure(error: unknown): void;
}): AgentSocketLifecycle {
  let server: AgentSocketServer | undefined;
  let ownershipReady: Promise<void> | undefined;
  let startCompletion: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;

  return {
    start(socketOptions): Promise<void> {
      if (shutdown !== undefined) return shutdown;
      if (startCompletion !== undefined) return startCompletion;

      let settleOwnership!: () => void;
      ownershipReady = new Promise<void>((resolve) => {
        settleOwnership = resolve;
      });
      let claimed = false;
      const claim = (created: AgentSocketServer): void => {
        if (claimed) return;
        claimed = true;
        server = created;
        settleOwnership();
      };
      let pending: Promise<AgentSocketServer>;
      try {
        pending = options.start(socketOptions, claim);
      } catch (error) {
        settleOwnership();
        startCompletion = Promise.reject(error);
        return startCompletion;
      }
      startCompletion = pending.then(
        (created) => {
          claim(created);
        },
        (error: unknown) => {
          settleOwnership();
          throw error;
        },
      );
      return startCompletion;
    },
    shutdown(): Promise<void> {
      if (shutdown !== undefined) return shutdown;

      const ready = ownershipReady;
      shutdown = (async () => {
        await ready;
        const created = server;
        server = undefined;
        await created?.close();
      })().catch((error: unknown) => {
        options.reportFailure(error);
      });
      return shutdown;
    },
  };
}

interface AgentSocketAppLifecycle {
  on(event: "will-quit", listener: (event: { preventDefault(): void }) => void): void;
  exit(code: number): void;
}

/** Lets a normal Electron will-quit wait for the same bounded socket shutdown. */
export function registerAgentSocketWillQuit(options: {
  lifecycle: AgentSocketAppLifecycle;
  shutdownAgentSocket: ShutdownAgentSocket;
}): void {
  let shutdownStarted = false;
  options.lifecycle.on("will-quit", (event) => {
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void options.shutdownAgentSocket().then(
      () => options.lifecycle.exit(0),
      () => options.lifecycle.exit(0),
    );
  });
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

function writeResponse(socket: Socket, response: AgentResponse, responseFlushed: () => void): void {
  if (!socket.writable) return;
  socket.end(`${JSON.stringify(response)}\n`, responseFlushed);
}

function handleConnection(
  socket: Socket,
  execute: AgentSocketOptions["execute"],
  requestTimeoutMs: number,
  acceptExecution: (run: () => Promise<void>) => boolean,
  responseFlushed: () => void,
): void {
  socket.setEncoding("utf8");
  let body = "";
  let receivedBytes = 0;
  let handled = false;
  socket.setTimeout(requestTimeoutMs, () => {
    if (handled) return;
    handled = true;
    writeResponse(socket, socketFailure("Request timed out."), responseFlushed);
  });
  socket.on("data", (chunk: string) => {
    if (handled) return;
    body += chunk;
    receivedBytes += Buffer.byteLength(chunk);
    if (receivedBytes > MAX_REQUEST_BYTES) {
      handled = true;
      socket.setTimeout(0);
      writeResponse(
        socket,
        socketFailure("Request exceeds the one-megabyte limit."),
        responseFlushed,
      );
      return;
    }
    const newline = body.indexOf("\n");
    if (newline === -1) return;
    handled = true;
    socket.setTimeout(0);
    const request = parseRequest(body.slice(0, newline));
    if (!("cmd" in request)) {
      writeResponse(socket, request, responseFlushed);
      return;
    }
    const accepted = acceptExecution(() =>
      Promise.resolve()
        .then(() => execute(request))
        .then((response) => writeResponse(socket, response, responseFlushed))
        .catch((error: unknown) =>
          writeResponse(
            socket,
            {
              v: 1,
              ok: false,
              error: {
                code: "MUTATION_FAILED",
                message: errorMessage(error),
              },
            },
            responseFlushed,
          ),
        ),
    );
    if (!accepted) socket.destroy();
  });
  socket.on("end", () => {
    // A probe (`socketIsReachable`) connects and destroys with no request.
    // With half-open on, that would otherwise sit until the 10s timeout and
    // pin `server.close()`. A real client half-closes AFTER the line, which
    // already set `handled` in `data`, so this must not end the writable
    // before `writeResponse`.
    if (handled) return;
    handled = true;
    socket.setTimeout(0);
    if (socket.writable) socket.end();
  });
  socket.on("error", () => {
    // Individual client failures do not take down the listening socket.
  });
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

async function socketIdentity(socketPath: string): Promise<SocketIdentity | null> {
  try {
    const entry = await lstat(socketPath);
    if (!entry.isSocket()) {
      throw new Error(`Refusing to replace non-socket path ${socketPath}`);
    }
    return { dev: entry.dev, ino: entry.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function socketIsReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      action();
    };
    socket.setTimeout(500, () =>
      finish(() => reject(new Error(`Timed out probing existing socket ${socketPath}`))),
    );
    socket.once("connect", () => finish(() => resolve(true)));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        finish(() => resolve(false));
        return;
      }
      finish(() => reject(error));
    });
  });
}

async function removeStaleSocket(socketPath: string): Promise<boolean> {
  const initial = await socketIdentity(socketPath);
  if (initial === null) return true;
  if (await socketIsReachable(socketPath)) return false;

  const current = await socketIdentity(socketPath);
  if (current === null) return true;
  if (current.dev !== initial.dev || current.ino !== initial.ino) return false;
  await unlink(socketPath);
  return true;
}

interface LiveAgentServer {
  server: Server;
  close(): Promise<void>;
}

function agentServer(options: AgentSocketOptions): LiveAgentServer {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const connections = new Map<Socket, { executionAccepted: boolean; responseFlushed: boolean }>();
  const executions = new Set<Promise<void>>();
  let closing = false;
  // The client writes one line and half-closes (`socket.end(request+"\n")`).
  // Node's default `allowHalfOpen: false` then ends the writable side on FIN,
  // so any `await` in `execute` — `realpath` in doctorFacts, a future
  // `doctor --fix` — loses the race and the CLI sees SOCKET_PROTOCOL
  // "closed without a response." Client tests already create the peer with
  // half-open on; the production server must too.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    const connection = { executionAccepted: false, responseFlushed: false };
    connections.set(socket, connection);
    socket.once("close", () => connections.delete(socket));
    handleConnection(
      socket,
      options.execute,
      requestTimeoutMs,
      (run) => {
        if (closing) return false;
        connection.executionAccepted = true;
        const execution = run();
        executions.add(execution);
        void execution.then(
          () => executions.delete(execution),
          () => executions.delete(execution),
        );
        return true;
      },
      () => {
        connection.responseFlushed = true;
        if (closing) socket.destroy();
      },
    );
  });
  server.maxConnections = MAX_CONNECTIONS;
  return {
    server,
    async close(): Promise<void> {
      closing = true;
      const closed = closeListeningServer(server);
      for (const [socket, connection] of connections) {
        if (!connection.executionAccepted || connection.responseFlushed) socket.destroy();
      }

      // One socket policy bounds both incomplete requests and shutdown drain.
      let deadline: NodeJS.Timeout | undefined;
      const timedOut = new Promise<"timed-out">((resolve) => {
        deadline = setTimeout(() => resolve("timed-out"), requestTimeoutMs);
      });
      try {
        const drained = Promise.all([closed, Promise.all(executions)]).then(
          () => "drained" as const,
        );
        if ((await Promise.race([drained, timedOut])) === "timed-out") {
          for (const socket of connections.keys()) socket.destroy();
          await closed;
        }
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
      }
    },
  };
}

function closeListeningServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/** Starts the private, one-request-per-connection NDJSON agent surface. */
export async function startAgentSocket(
  options: AgentSocketOptions,
  claim: (server: AgentSocketServer) => void = () => undefined,
  setSocketMode: SetSocketMode = chmod,
): Promise<AgentSocketServer> {
  let liveServer = agentServer(options);
  // Belt-and-braces against the create-then-chmod race: `listen()` creates the
  // socket file with umask-default perms, and another local process could open
  // it in the window before the `chmod` below lands. A restrictive umask makes
  // the file arrive at 0o600 already; the process-global umask is restored
  // (both success and error paths) the instant `listen` resolves so it never
  // leaks into unrelated file creation elsewhere in the process.
  const previousUmask = process.umask(0o077);
  try {
    try {
      await listen(liveServer.server, options.socketPath);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EADDRINUSE" ||
        !(await removeStaleSocket(options.socketPath))
      ) {
        throw error;
      }
      // One retry only: concurrent stale-socket recovery may have produced a
      // live winner, and a second cleanup attempt must never replace it.
      liveServer = agentServer(options);
      await listen(liveServer.server, options.socketPath);
    }
  } finally {
    process.umask(previousUmask);
  }
  const server = agentSocketHandle(liveServer);
  // The lifecycle owns the listening socket before the post-listen chmod can
  // yield, so quit can close and unlink it without waiting for publication.
  claim(server);
  try {
    await setSocketMode(options.socketPath, 0o600);
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
  return server;
}

function agentSocketHandle(liveServer: LiveAgentServer): AgentSocketServer {
  let closePromise: Promise<void> | undefined;
  return {
    close(): Promise<void> {
      closePromise ??= liveServer.close();
      return closePromise;
    },
  };
}
