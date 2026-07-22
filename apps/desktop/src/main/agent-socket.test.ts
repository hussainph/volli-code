import { connect } from "node:net";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRequest, AgentResponse } from "@volli/shared";

import { createAgentCommandService } from "./agent-commands";
import { startAgentSocket, type AgentSocketServer } from "./agent-socket";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, type TestDb } from "./db/test-helpers";

let ctx: TestDb;
let server: AgentSocketServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  ctx?.cleanup();
});

function roundTrip(socketPath: string, request: AgentRequest): Promise<AgentResponse> {
  return rawRoundTrip(socketPath, JSON.stringify(request));
}

function rawRoundTrip(socketPath: string, line: string): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${line}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(JSON.parse(response.trim()) as AgentResponse));
  });
}

describe("agent socket", () => {
  it("serves a real create-move-comment-board round trip on a private Unix socket", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    let timestamp = 100;
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => timestamp++,
      newId: () => "ticket-internal",
    });
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    server = await startAgentSocket({ socketPath, execute: (request) => service.execute(request) });
    const request = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
      roundTrip(socketPath, {
        v: 1,
        cmd,
        args,
        ctx: { cwd: "/repo/volli", env: {} },
      });

    expect(await request("ticket.create", { title: "Ship CLI" })).toMatchObject({
      ok: true,
      data: { ticket: { id: "VC-1" } },
    });
    expect(await request("ticket.move", { id: "VC-1", to: "doing" })).toMatchObject({
      ok: true,
      data: { ticket: { status: "doing" } },
    });
    expect(await request("ticket.comment", { id: "VC-1", message: "Working" })).toMatchObject({
      ok: true,
      data: { comment: { ticket: "VC-1", body: "Working" } },
    });
    expect(await request("board", {})).toMatchObject({
      ok: true,
      data: { columns: { doing: [{ id: "VC-1" }] } },
    });
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects malformed protocol input and preserves a degraded database response", async () => {
    ctx = openTestDb();
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    server = await startAgentSocket({
      socketPath,
      execute: async () => ({
        v: 1,
        ok: false,
        error: { code: "DB_UNAVAILABLE", message: "Database failed to open." },
      }),
    });

    expect(await rawRoundTrip(socketPath, "not-json")).toMatchObject({
      ok: false,
      error: { code: "SOCKET_PROTOCOL" },
    });
    expect(
      await roundTrip(socketPath, {
        v: 1,
        cmd: "board",
        args: {},
        ctx: { cwd: "/repo/volli", env: {} },
      }),
    ).toEqual({
      v: 1,
      ok: false,
      error: { code: "DB_UNAVAILABLE", message: "Database failed to open." },
    });
  });

  it("times out clients that hold a connection open without completing a request", async () => {
    ctx = openTestDb();
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    server = await startAgentSocket({
      socketPath,
      requestTimeoutMs: 20,
      execute: async () => ({ v: 1, ok: true, data: {} }),
    });

    const response = await new Promise<AgentResponse>((resolve, reject) => {
      const socket = connect(socketPath);
      let body = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        body += chunk;
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(JSON.parse(body.trim()) as AgentResponse));
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "SOCKET_PROTOCOL", message: "Request timed out." },
    });
  });

  it("restores the process umask after the socket is created (chmod-race belt-and-braces)", async () => {
    ctx = openTestDb();
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    const before = process.umask();

    server = await startAgentSocket({
      socketPath,
      execute: async () => ({ v: 1, ok: true, data: {} }),
    });

    expect(process.umask()).toBe(before);
  });

  it("restores the process umask even when the socket fails to bind", async () => {
    const before = process.umask();
    // The parent directory doesn't exist, so `listen()` rejects with ENOENT
    // before ever reaching the post-listen chmod.
    const badPath = join(tmpdir(), "volli-agent-socket-test-missing-dir", "volli.sock");

    await expect(
      startAgentSocket({
        socketPath: badPath,
        execute: async () => ({ v: 1, ok: true, data: {} }),
      }),
    ).rejects.toThrow();

    expect(process.umask()).toBe(before);
  });
});
