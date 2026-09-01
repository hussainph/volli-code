import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { lstat, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeAgentError } from "@volli/shared";
import type { AgentRequest, AgentResponse } from "@volli/shared";

import { createAgentCommandService } from "./agent-commands";
import {
  createAgentSocketLifecycle,
  registerAgentSocketWillQuit,
  startAgentSocket,
  type AgentSocketServer,
} from "./agent-socket";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, testSession, type TestDb } from "./db/test-helpers";
import { createDesktopSessionEngine } from "./session-control";
import { insertSession } from "./session-control/test-support";
import { createSessionTokenRegistry } from "./session-tokens";

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
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response.trim()) as AgentResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function leaveStaleSocket(socketPath: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const {createServer}=require('node:net');const server=createServer();server.listen(process.argv[1],()=>process.send('ready'));",
      socketPath,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  try {
    await once(child, "message");
    child.kill("SIGKILL");
    await once(child, "exit");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  expect((await lstat(socketPath)).isSocket()).toBe(true);
}

describe("agent socket", () => {
  it("waits for an in-flight startup to publish, then closes it exactly once", async () => {
    let finishStartup!: (created: AgentSocketServer) => void;
    const startup = new Promise<AgentSocketServer>((resolve) => {
      finishStartup = resolve;
    });
    let finishClose!: () => void;
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
          markCloseStarted();
        }),
    );
    const start = vi.fn(
      (
        _options: unknown,
        claim?: (created: AgentSocketServer) => void,
      ): Promise<AgentSocketServer> => {
        claim?.({ close });
        return startup;
      },
    );
    const reportFailure = vi.fn();
    const lifecycle = createAgentSocketLifecycle({ start, reportFailure });
    const socketOptions = {
      socketPath: "/tmp/volli-lifecycle-test.sock",
      execute: async () => ({ v: 1 as const, ok: true as const, data: {} }),
    };

    let startupSettled = false;
    const firstStart = lifecycle.start(socketOptions).then(() => {
      startupSettled = true;
    });
    const secondStart = lifecycle.start(socketOptions);
    let shutdownSettled = false;
    const firstShutdown = lifecycle.shutdown().then(() => {
      shutdownSettled = true;
    });
    const secondShutdown = lifecycle.shutdown();

    await closeStarted;
    expect(close).toHaveBeenCalledTimes(1);
    expect(shutdownSettled).toBe(false);

    finishClose();
    await expect(Promise.all([firstShutdown, secondShutdown])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(startupSettled).toBe(false);

    finishStartup({ close });
    await expect(Promise.all([firstStart, secondStart])).resolves.toEqual([undefined, undefined]);
    await expect(lifecycle.shutdown()).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toBe(socketOptions);
    expect(close).toHaveBeenCalledTimes(1);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("closes and unlinks the production socket before startup publication settles", async () => {
    ctx = openTestDb();
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publishSocketMode = vi.fn(async () => {
      await publicationGate;
    });
    let close: ReturnType<typeof vi.fn<AgentSocketServer["close"]>> | undefined;
    const lifecycle = createAgentSocketLifecycle({
      start: (options, claim) =>
        startAgentSocket(
          options,
          (created) => {
            server = created;
            close = vi.fn(async () => {
              await created.close();
              if (server === created) server = undefined;
            });
            claim({ close });
          },
          publishSocketMode,
        ),
      reportFailure: vi.fn(),
    });

    let startupSettled = false;
    const startPromise = lifecycle
      .start({
        socketPath,
        execute: async () => ({ v: 1, ok: true, data: {} }),
      })
      .then(() => {
        startupSettled = true;
      });
    try {
      await vi.waitFor(
        () => expect(publishSocketMode).toHaveBeenCalledExactlyOnceWith(socketPath, 0o600),
        { timeout: 200 },
      );
      expect((await lstat(socketPath)).isSocket()).toBe(true);

      let shutdownSettled = false;
      const shutdownPromise = lifecycle.shutdown().then(() => {
        shutdownSettled = true;
      });
      await vi.waitFor(() => expect(shutdownSettled).toBe(true), { timeout: 500 });

      expect(close).toHaveBeenCalledTimes(1);
      expect(startupSettled).toBe(false);
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lifecycle.shutdown()).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      await shutdownPromise;
    } finally {
      releasePublication();
      await startPromise;
    }
  });

  // The Settings → CLI pane reads this at call time: it must track the server's
  // actual ownership, not latch the boot's answer (VC-52 review N1).
  it("measures liveness — false before a server is claimed, true while owned, false after shutdown", async () => {
    const close = vi.fn(async () => {});
    const lifecycle = createAgentSocketLifecycle({
      start: vi.fn(async (_options: unknown, claim?: (created: AgentSocketServer) => void) => {
        const created = { close };
        claim?.(created);
        return created;
      }),
      reportFailure: vi.fn(),
    });

    expect(lifecycle.live()).toBe(false);
    await lifecycle.start({
      socketPath: "/tmp/volli-lifecycle-test.sock",
      execute: async () => ({ v: 1, ok: true as const, data: {} }),
    });
    expect(lifecycle.live()).toBe(true);
    await lifecycle.shutdown();
    expect(lifecycle.live()).toBe(false);
  });

  it("settles shutdown when an in-flight startup rejects without publishing a server", async () => {
    const failure = new Error("listen failed");
    let rejectStartup!: (error: unknown) => void;
    const startup = new Promise<AgentSocketServer>((_resolve, reject) => {
      rejectStartup = reject;
    });
    const reportFailure = vi.fn();
    const lifecycle = createAgentSocketLifecycle({
      start: vi.fn(() => startup),
      reportFailure,
    });
    const startPromise = lifecycle.start({
      socketPath: "/tmp/volli-lifecycle-test.sock",
      execute: async () => ({ v: 1, ok: true as const, data: {} }),
    });
    const startupOutcome = expect(startPromise).rejects.toBe(failure);

    const shutdownPromise = lifecycle.shutdown();
    rejectStartup(failure);

    await startupOutcome;
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("does not start a server after shutdown has settled without one", async () => {
    const start = vi.fn(() => Promise.reject(new Error("must not start")));
    const lifecycle = createAgentSocketLifecycle({ start, reportFailure: vi.fn() });

    await expect(lifecycle.shutdown()).resolves.toBeUndefined();
    await expect(
      lifecycle.start({
        socketPath: "/tmp/volli-lifecycle-test.sock",
        execute: async () => ({ v: 1, ok: true as const, data: {} }),
      }),
    ).resolves.toBeUndefined();

    expect(start).not.toHaveBeenCalled();
  });

  it("closes a published server exactly once", async () => {
    let finishClose: (() => void) | undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const reportFailure = vi.fn();
    const lifecycle = createAgentSocketLifecycle({
      start: vi.fn(() => Promise.resolve({ close })),
      reportFailure,
    });
    await lifecycle.start({
      socketPath: "/tmp/volli-lifecycle-test.sock",
      execute: async () => ({ v: 1, ok: true as const, data: {} }),
    });

    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    finishClose?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(lifecycle.shutdown()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("reports a socket close failure without rejecting shutdown", async () => {
    const failure = new Error("close failed");
    const close = vi.fn(() => Promise.reject(failure));
    const reportFailure = vi.fn();
    const lifecycle = createAgentSocketLifecycle({
      start: vi.fn(() => Promise.resolve({ close })),
      reportFailure,
    });
    await lifecycle.start({
      socketPath: "/tmp/volli-lifecycle-test.sock",
      execute: async () => ({ v: 1, ok: true as const, data: {} }),
    });

    await expect(lifecycle.shutdown()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("holds will-quit until socket shutdown completes", async () => {
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
    let finishClose: (() => void) | undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const agentSocket = createAgentSocketLifecycle({
      start: vi.fn(() => Promise.resolve({ close })),
      reportFailure: vi.fn(),
    });
    await agentSocket.start({
      socketPath: "/tmp/volli-lifecycle-test.sock",
      execute: async () => ({ v: 1, ok: true as const, data: {} }),
    });
    const exit = vi.fn();

    registerAgentSocketWillQuit({
      lifecycle: {
        on(event, listener) {
          handlers.set(event, listener);
        },
        exit,
      },
      shutdownAgentSocket: agentSocket.shutdown,
      reportFailure: vi.fn(),
    });

    const event = { preventDefault: vi.fn() };
    handlers.get("will-quit")?.(event);

    expect(event.preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(exit).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    finishClose?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
  });

  it("forces one will-quit after the shutdown deadline and observes a late rejection", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
      let failShutdown!: (error: unknown) => void;
      const shutdownAgentSocket = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            failShutdown = reject;
          }),
      );
      const reportFailure = vi.fn();
      const exit = vi.fn();
      registerAgentSocketWillQuit({
        lifecycle: {
          on(event, listener) {
            handlers.set(event, listener);
          },
          exit,
        },
        shutdownAgentSocket,
        shutdownDeadlineMs: 25,
        reportFailure,
      });

      const first = { preventDefault: vi.fn() };
      const repeated = { preventDefault: vi.fn() };
      handlers.get("will-quit")?.(first);
      handlers.get("will-quit")?.(repeated);
      await vi.advanceTimersByTimeAsync(0);

      expect(first.preventDefault).toHaveBeenCalledExactlyOnceWith();
      expect(repeated.preventDefault).toHaveBeenCalledExactlyOnceWith();
      expect(shutdownAgentSocket).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25);

      expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
        new Error("Application shutdown did not settle within 25ms."),
      );
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);

      failShutdown(new Error("late socket failure"));
      await vi.advanceTimersByTimeAsync(0);
      handlers.get("will-quit")?.({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(25);

      expect(reportFailure).toHaveBeenNthCalledWith(2, new Error("late socket failure"));
      expect(reportFailure).toHaveBeenCalledTimes(2);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(shutdownAgentSocket).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a will-quit shutdown rejection before exiting", async () => {
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
    const failure = new Error("socket shutdown rejected");
    const reportFailure = vi.fn();
    const exit = vi.fn();
    registerAgentSocketWillQuit({
      lifecycle: {
        on(event, listener) {
          handlers.set(event, listener);
        },
        exit,
      },
      shutdownAgentSocket: () => Promise.reject(failure),
      reportFailure,
    });

    const event = { preventDefault: vi.fn() };
    handlers.get("will-quit")?.(event);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(event.preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("serves a real create-move-comment-board round trip on a private Unix socket", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    let timestamp = 100;
    // A real Session on the other end of the real socket: these are
    // coordination-tier writes, so the caller carries the token Volli exported
    // into its attachment (VC-163). The wire field is what makes the round trip
    // end to end — the token has to survive JSON, the socket and the parse, not
    // just the in-process call.
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(ctx.db, testSession("project-one", null, { id: sessionId }));
    const tokens = createSessionTokenRegistry();
    const service = createAgentCommandService({
      db: ctx.db,
      sessionEngine: createDesktopSessionEngine(ctx.db),
      appVersion: "1.2.3",
      now: () => timestamp++,
      newId: () => "ticket-internal",
      verifySessionToken: tokens.verify,
    });
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    server = await startAgentSocket({ socketPath, execute: (request) => service.execute(request) });
    const env = {
      session: sessionId,
      token: tokens.mint({ sessionId, attachmentId: "attachment-1" }),
    };
    const request = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
      roundTrip(socketPath, { v: 1, cmd, args, ctx: { cwd: "/repo/volli", env } });

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
        error: makeAgentError("DB_UNAVAILABLE", "Database failed to open."),
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
      error: makeAgentError("DB_UNAVAILABLE", "Database failed to open."),
    });
  });

  it("still writes the reply after the client half-closes, even when execute awaits", async () => {
    ctx = openTestDb();
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    server = await startAgentSocket({
      socketPath,
      execute: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        return { v: 1, ok: true, data: { delayed: true } };
      },
    });

    await expect(
      roundTrip(socketPath, {
        v: 1,
        cmd: "identify",
        args: {},
        ctx: { cwd: "/repo/volli", env: {} },
      }),
    ).resolves.toEqual({ v: 1, ok: true, data: { delayed: true } });
  });

  it("drains an accepted execution and flushes its reply before shutdown settles", async () => {
    ctx = openTestDb();
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    let markExecuteStarted!: () => void;
    const executeStarted = new Promise<void>((resolve) => {
      markExecuteStarted = resolve;
    });
    let finishExecute!: (response: AgentResponse) => void;
    const execution = new Promise<AgentResponse>((resolve) => {
      finishExecute = resolve;
    });
    server = await startAgentSocket({
      socketPath,
      requestTimeoutMs: 1_000,
      execute: () => {
        markExecuteStarted();
        return execution;
      },
    });
    const responsePromise = roundTrip(socketPath, {
      v: 1,
      cmd: "identify",
      args: {},
      ctx: { cwd: "/repo/volli", env: {} },
    }).then(
      (response) => ({ ok: true as const, response }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await executeStarted;

    let shutdownSettled = false;
    const shutdownPromise = server.close().then(() => {
      shutdownSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeExecution = shutdownSettled;
    finishExecute({ v: 1, ok: true, data: { receipt: "persisted" } });

    const response = await responsePromise;
    await shutdownPromise;
    server = undefined;
    expect(settledBeforeExecution).toBe(false);
    expect(response).toEqual({
      ok: true,
      response: { v: 1, ok: true, data: { receipt: "persisted" } },
    });
  });

  it("closes a flushed response connection without waiting for the peer to half-close", async () => {
    ctx = openTestDb();
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    server = await startAgentSocket({
      socketPath,
      requestTimeoutMs: 1_000,
      execute: async () => ({ v: 1, ok: true, data: { receipt: "persisted" } }),
    });
    const client = connect({ path: socketPath, allowHalfOpen: true });
    let response = "";
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      response += chunk;
    });
    await once(client, "connect");
    client.write(
      `${JSON.stringify({
        v: 1,
        cmd: "identify",
        args: {},
        ctx: { cwd: "/repo/volli", env: {} },
      } satisfies AgentRequest)}\n`,
    );
    await once(client, "end");

    const closePromise = server.close();
    const outcome = await Promise.race([
      closePromise.then(() => "closed" as const),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 200);
      }),
    ]);

    client.destroy();
    await closePromise;
    server = undefined;
    expect(JSON.parse(response.trim())).toEqual({
      v: 1,
      ok: true,
      data: { receipt: "persisted" },
    });
    expect(outcome).toBe("closed");
  });

  it("refuses to replace a live agent socket and leaves its owner reachable", async () => {
    ctx = openTestDb();
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    server = await startAgentSocket({
      socketPath,
      execute: async () => ({ v: 1, ok: true, data: { owner: "first" } }),
    });

    let replacement: AgentSocketServer | undefined;
    let startupError: unknown;
    try {
      try {
        replacement = await startAgentSocket({
          socketPath,
          execute: async () => ({ v: 1, ok: true, data: { owner: "second" } }),
        });
      } catch (error) {
        startupError = error;
      }

      expect(startupError).toMatchObject({ code: "EADDRINUSE" });
      expect(replacement).toBeUndefined();
      await expect(
        roundTrip(socketPath, {
          v: 1,
          cmd: "identify",
          args: {},
          ctx: { cwd: "/repo/volli", env: {} },
        }),
      ).resolves.toMatchObject({ ok: true, data: { owner: "first" } });
    } finally {
      await replacement?.close();
    }
  });

  it("recovers a stale socket left behind by a crashed owner", async () => {
    ctx = openTestDb();
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    await leaveStaleSocket(socketPath);

    server = await startAgentSocket({
      socketPath,
      execute: async () => ({ v: 1, ok: true, data: { owner: "recovered" } }),
    });

    await expect(
      roundTrip(socketPath, {
        v: 1,
        cmd: "identify",
        args: {},
        ctx: { cwd: "/repo/volli", env: {} },
      }),
    ).resolves.toMatchObject({ ok: true, data: { owner: "recovered" } });
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

  it("closes an idle client without waiting for the shutdown deadline", async () => {
    ctx = openTestDb();
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    server = await startAgentSocket({
      socketPath,
      requestTimeoutMs: 1_000,
      execute: async () => ({ v: 1, ok: true, data: {} }),
    });
    const client = connect(socketPath);
    await once(client, "connect");

    const closePromise = server.close();
    const outcome = await Promise.race([
      closePromise.then(() => "closed" as const),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 200);
      }),
    ]);

    client.destroy();
    await closePromise;
    server = undefined;
    expect(outcome).toBe("closed");
  });

  it("force-closes a hung accepted execution at the shutdown deadline", async () => {
    ctx = openTestDb();
    const socketPath = join(dirname(ctx.dbPath), "volli.sock");
    let markExecuteStarted: (() => void) | undefined;
    const executeStarted = new Promise<void>((resolve) => {
      markExecuteStarted = resolve;
    });
    server = await startAgentSocket({
      socketPath,
      requestTimeoutMs: 20,
      execute: () => {
        markExecuteStarted?.();
        return new Promise<AgentResponse>(() => undefined);
      },
    });
    const client = connect(socketPath);
    await once(client, "connect");
    client.write(
      `${JSON.stringify({
        v: 1,
        cmd: "identify",
        args: {},
        ctx: { cwd: "/repo/volli", env: {} },
      } satisfies AgentRequest)}\n`,
    );
    await executeStarted;

    const closePromise = server.close();
    const outcome = await Promise.race([
      closePromise.then(() => "closed" as const),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 500);
      }),
    ]);

    client.destroy();
    await closePromise;
    server = undefined;
    expect(outcome).toBe("closed");
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
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
