import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AgentRequest } from "@volli/shared";

import { AgentClientError, requestAgent } from "./client";

const scratch: string[] = [];

const request: AgentRequest = {
  v: 1,
  cmd: "project.list",
  args: {},
  ctx: { cwd: "/work/volli", env: {} },
};

async function withSocketServer(
  handler: (socket: Socket) => void,
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "volli-cli-client-"));
  scratch.push(dir);
  const socketPath = join(dir, "volli.sock");
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await run(socketPath);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("requestAgent", () => {
  it("performs one newline-delimited request and returns the one response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "volli-cli-client-"));
    scratch.push(dir);
    const socketPath = join(dir, "volli.sock");
    let received = "";
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received += chunk;
        if (received.endsWith("\n")) {
          socket.end(`${JSON.stringify({ v: 1, ok: true, data: { projects: 2 } })}\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const result = await requestAgent(socketPath, request, { timeoutMs: 500 });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    expect(JSON.parse(received.trim())).toEqual(request);
    expect(result).toEqual({ v: 1, ok: true, data: { projects: 2 } });
  });

  it("classifies a missing socket as retryable app infrastructure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "volli-cli-missing-"));
    scratch.push(dir);
    await expect(
      requestAgent(join(dir, "missing.sock"), request, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "APP_UNREACHABLE" } satisfies Partial<AgentClientError>);
  });

  it.each([
    ["malformed JSON", "not json\n", "The app returned malformed JSON."],
    ["a primitive", "null\n", "The app returned an invalid response."],
    ["an unsupported envelope", '{"v":2,"ok":true}\n', "The app returned an unsupported response."],
    [
      "success without data",
      '{"v":1,"ok":true}\n',
      "The app returned an invalid success response.",
    ],
    [
      "failure without a typed error",
      '{"v":1,"ok":false,"error":{"code":1,"message":"bad"}}\n',
      "The app returned an invalid error response.",
    ],
  ])("rejects %s as a protocol error", async (_label, response, message) => {
    await withSocketServer(
      (socket) => socket.end(response),
      async (socketPath) => {
        await expect(requestAgent(socketPath, request, { timeoutMs: 500 })).rejects.toMatchObject({
          code: "SOCKET_PROTOCOL",
          message,
        });
      },
    );
  });

  it("accepts a typed failure envelope without weakening the discriminant", async () => {
    const response = {
      v: 1,
      ok: false,
      error: { code: "DB_UNAVAILABLE", message: "Database failed to open." },
    } as const;
    await withSocketServer(
      (socket) => socket.end(`${JSON.stringify(response)}\n`),
      async (socketPath) => {
        await expect(requestAgent(socketPath, request, { timeoutMs: 500 })).resolves.toEqual(
          response,
        );
      },
    );
  });

  it("rejects oversized and missing responses", async () => {
    await withSocketServer(
      // Two UTF-16 code units but four UTF-8 bytes: this stays below a
      // character-count limit while exceeding the four-megabyte wire limit.
      (socket) => socket.end("💥".repeat(1024 * 1024 + 1)),
      async (socketPath) => {
        await expect(requestAgent(socketPath, request, { timeoutMs: 4_000 })).rejects.toMatchObject(
          {
            code: "SOCKET_PROTOCOL",
            message: "The app response is too large.",
          },
        );
      },
    );
    await withSocketServer(
      (socket) => socket.end(),
      async (socketPath) => {
        await expect(requestAgent(socketPath, request, { timeoutMs: 500 })).rejects.toMatchObject({
          code: "SOCKET_PROTOCOL",
          message: "The app closed without a response.",
        });
      },
    );
  });

  it("times out a connected app that never responds", async () => {
    await withSocketServer(
      () => undefined,
      async (socketPath) => {
        await expect(requestAgent(socketPath, request, { timeoutMs: 10 })).rejects.toMatchObject({
          code: "TIMEOUT",
        });
      },
    );
  });

  it("classifies a post-connect socket error as a protocol failure, not app-unreachable", async () => {
    await withSocketServer(
      (socket) => {
        // The server-side socket also emits "error" on a forced destroy; a
        // no-op listener here keeps that local instead of surfacing as an
        // unhandled test-run error — only the client side is under test.
        socket.on("error", () => undefined);
        socket.destroy(new Error("simulated ECONNRESET"));
      },
      async (socketPath) => {
        await expect(requestAgent(socketPath, request, { timeoutMs: 500 })).rejects.toMatchObject({
          code: "SOCKET_PROTOCOL",
        });
      },
    );
  });
});
