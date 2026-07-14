import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type {
  CreateTerminalSessionResult,
  Project,
  TerminalIoResult,
  VolliIpcChannel,
} from "@volli/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

// Hoisted above module evaluation, like ipc.test.ts, so the electron/node-pty
// mock factories can capture into them.
const { handlers, listeners, appHandlers, spawn } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, (...args: never[]) => unknown>(),
  appHandlers: new Map<string, () => void>(),
  spawn: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
    on(channel: string, listener: (...args: never[]) => unknown) {
      listeners.set(channel, listener);
    },
  },
  app: {
    on(event: string, handler: () => void) {
      appHandlers.set(event, handler);
    },
  },
}));

// The whole point of the lazy import in pty.ts: this mock stands in for the
// Electron-ABI native binary, which never loads under plain-Node vitest.
vi.mock("node-pty", () => ({ spawn }));

import { registerTerminalIpcHandlers } from "./pty";
import { listTicketEvents } from "./db/events-repo";
import { insertProject } from "./db/projects-repo";
import { listSessions, listTicketSessions } from "./db/sessions-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "./db/test-helpers";
import { deleteTicket, insertTicket } from "./db/tickets-repo";
import { syncProjectRoots } from "./project-roots";

/** A node-pty double whose onData/onExit callbacks can be fired on demand. */
function makeFakePty() {
  let dataCb: ((data: string) => void) | undefined;
  let exitCb: ((event: { exitCode: number }) => void) | undefined;
  return {
    onData: (cb: (data: string) => void) => {
      dataCb = cb;
    },
    onExit: (cb: (event: { exitCode: number }) => void) => {
      exitCb = cb;
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    emitData: (data: string) => dataCb?.(data),
    emitExit: (exitCode: number) => exitCb?.({ exitCode }),
  };
}

/** A WebContents double; `destroyed` listener and destroyed-state are steerable. */
function makeWebContents() {
  const eventListeners = new Map<string, () => void>();
  return {
    send: vi.fn(),
    destroyed: false,
    isDestroyed(): boolean {
      return this.destroyed;
    },
    once: vi.fn(function (this: unknown, event: string, cb: () => void) {
      eventListeners.set(event, cb);
    }),
    removeListener: vi.fn(),
    fireDestroyed() {
      eventListeners.get("destroyed")?.();
    },
  };
}

type WebContentsDouble = ReturnType<typeof makeWebContents>;

const invokeCreate = (sender: WebContentsDouble, req: unknown) =>
  (handlers.get("volli:terminal-create" satisfies VolliIpcChannel) as (...a: unknown[]) => unknown)(
    { sender },
    req,
  ) as Promise<CreateTerminalSessionResult>;

const invokeWrite = (sessionId: unknown, data: unknown) =>
  (handlers.get("volli:terminal-write" satisfies VolliIpcChannel) as (...a: unknown[]) => unknown)(
    { sender: {} },
    sessionId,
    data,
  ) as TerminalIoResult;

const invokeResize = (sessionId: unknown, cols: unknown, rows: unknown) =>
  (handlers.get("volli:terminal-resize" satisfies VolliIpcChannel) as (...a: unknown[]) => unknown)(
    { sender: {} },
    sessionId,
    cols,
    rows,
  ) as TerminalIoResult;

const invokeKill = (sessionId: unknown) =>
  (handlers.get("volli:terminal-kill" satisfies VolliIpcChannel) as (...a: unknown[]) => unknown)(
    { sender: {} },
    sessionId,
  ) as TerminalIoResult;

// The ack channel is send-based (ipcMain.on), not invoke-based; it returns
// nothing and identifies the caller only by the event's sender.
const sendAck = (sender: unknown, sessionId: unknown, chars: unknown) =>
  (listeners.get("volli:terminal-ack" satisfies VolliIpcChannel) as (...a: unknown[]) => unknown)(
    { sender },
    sessionId,
    chars,
  );

/** Runs the pending batch timer so buffered output flushes (fake timers on). */
const flushBatchWindow = () => vi.advanceTimersByTime(8);

let root: string;
let outside: string;
let manager: ReturnType<typeof registerTerminalIpcHandlers>;
let testDb: TestDb;
let project: Project;

/** Spawns a session and returns its id plus the fake pty backing it. */
async function createSession(sender = makeWebContents()) {
  const pty = makeFakePty();
  spawn.mockReturnValueOnce(pty);
  const result = await invokeCreate(sender, {
    workspaceId: "w",
    cwd: root,
    cols: 80,
    rows: 24,
  });
  if (!result.ok) throw new Error(`expected session, got ${result.error}`);
  return { sessionId: result.sessionId, pty, sender };
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-pty-")));
  outside = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-pty-outside-")));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  // Every session persists a durable record, so the manager needs a real,
  // migrated db. The workspace ("w") must be a real project row (FK), rooted at
  // `root` so scratch cwds and resolved ticket cwds land inside the synced root.
  testDb = openTestDb();
  project = testProject({ id: "w", path: root, ticketPrefix: "VC" });
  insertProject(testDb.db, project);
  // Fresh manager + handlers each test (Map overwrites); reset roots.
  manager = registerTerminalIpcHandlers({ ok: true, db: testDb.db });
  syncProjectRoots([root]);
});

afterEach(() => {
  vi.useRealTimers();
  testDb.cleanup();
});

describe("volli:terminal-create", () => {
  it("spawns a login shell in the requested cwd with a 256-color TERM", async () => {
    const { sessionId } = await createSession();
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawn.mock.calls[0] as [
      string,
      string[],
      { name: string; cwd: string; cols: number; rows: number; env: Record<string, string> },
    ];
    expect(typeof file).toBe("string");
    expect(args).toEqual(["-l"]);
    expect(options).toMatchObject({ name: "xterm-256color", cwd: root, cols: 80, rows: 24 });
    expect(options.env["TERM"]).toBe("xterm-256color");
  });

  it("routes pty output to the creating window's webContents with the session id", async () => {
    vi.useFakeTimers();
    const { sessionId, pty, sender } = await createSession();
    pty.emitData("hello world");
    flushBatchWindow();
    expect(sender.send).toHaveBeenCalledWith("volli:terminal-data", {
      sessionId,
      data: "hello world",
    });
  });

  it("routes pty exit to the creating window's webContents with the session id", async () => {
    const { sessionId, pty, sender } = await createSession();
    pty.emitExit(7);
    expect(sender.send).toHaveBeenCalledWith("volli:terminal-exit", { sessionId, exitCode: 7 });
  });

  it("gives each session a distinct id", async () => {
    const a = await createSession();
    const b = await createSession();
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("drops data/exit events once the creating window is destroyed", async () => {
    const { pty, sender } = await createSession();
    sender.destroyed = true;
    pty.emitData("late output");
    pty.emitExit(0);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("forgets the session after it exits", async () => {
    const { sessionId, pty } = await createSession();
    pty.emitExit(0);
    expect(invokeWrite(sessionId, "x")).toEqual({
      ok: false,
      error: "Unknown terminal session",
    });
  });

  it("rejects a cwd outside the project roots without spawning", async () => {
    const result = await invokeCreate(makeWebContents(), {
      workspaceId: "w",
      cwd: outside,
      cols: 80,
      rows: 24,
    });
    expect(result).toEqual({ ok: false, error: "cwd is outside known projects" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn when the window is destroyed during the lazy node-pty import", async () => {
    const sender = makeWebContents();
    // The handler suspends at `await import("node-pty")`; flipping destroyed
    // before awaiting the result models the window closing mid-import.
    const pending = invokeCreate(sender, { workspaceId: "w", cwd: root, cols: 80, rows: 24 });
    sender.destroyed = true;
    const result = await pending;
    expect(result).toEqual({
      ok: false,
      error: "Window was closed before the terminal could start",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(sender.once).not.toHaveBeenCalled();
  });

  it("kills the fresh pty when the window is destroyed during spawn", async () => {
    const sender = makeWebContents();
    const pty = makeFakePty();
    spawn.mockImplementationOnce(() => {
      sender.destroyed = true;
      return pty;
    });
    const result = await invokeCreate(sender, { workspaceId: "w", cwd: root, cols: 80, rows: 24 });
    expect(result).toEqual({
      ok: false,
      error: "Window was closed before the terminal could start",
    });
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(sender.once).not.toHaveBeenCalled();
  });

  it("returns a typed error instead of throwing when spawn fails", async () => {
    spawn.mockImplementationOnce(() => {
      throw new Error("ptsname failed");
    });
    const result = await invokeCreate(makeWebContents(), {
      workspaceId: "w",
      cwd: root,
      cols: 80,
      rows: 24,
    });
    expect(result).toEqual({ ok: false, error: "ptsname failed" });
  });

  it.each([
    ["a non-object", 42],
    ["null", null],
    ["a missing cwd", { workspaceId: "w", cols: 80, rows: 24 }],
    ["a non-string workspaceId", { workspaceId: 1, cwd: "/x", cols: 80, rows: 24 }],
    ["a non-number cols", { workspaceId: "w", cwd: "/x", cols: "80", rows: 24 }],
    ["a non-number rows", { workspaceId: "w", cwd: "/x", cols: 80, rows: "24" }],
    ["a non-object ticket", { workspaceId: "w", cwd: "/x", cols: 80, rows: 24, ticket: 42 }],
    ["a null ticket", { workspaceId: "w", cwd: "/x", cols: 80, rows: 24, ticket: null }],
    ["a ticket without ticketId", { workspaceId: "w", cwd: "/x", cols: 80, rows: 24, ticket: {} }],
  ])("rejects %s request without spawning", async (_label, req) => {
    const result = await invokeCreate(makeWebContents(), req);
    expect(result).toEqual({ ok: false, error: "Invalid terminal request" });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("PtyManager.workspaceIdFor", () => {
  it("reports the workspaceId a live session was created for", async () => {
    const { sessionId } = await createSession();
    expect(manager.workspaceIdFor(sessionId)).toBe("w");
  });

  it("returns undefined for an unknown session", () => {
    expect(manager.workspaceIdFor("nope")).toBeUndefined();
  });
});

describe("output batching", () => {
  it("coalesces chunks within the batch window into one send with the joined payload", async () => {
    vi.useFakeTimers();
    const { sessionId, pty, sender } = await createSession();
    pty.emitData("foo");
    pty.emitData("bar");
    pty.emitData("baz");
    expect(sender.send).not.toHaveBeenCalled();
    flushBatchWindow();
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith("volli:terminal-data", {
      sessionId,
      data: "foobarbaz",
    });
  });

  it("flushes immediately when the buffer reaches 256k chars, without a stale second flush", async () => {
    vi.useFakeTimers();
    const { sessionId, pty, sender } = await createSession();
    pty.emitData("x".repeat(255_999));
    expect(sender.send).not.toHaveBeenCalled();
    pty.emitData("yz");
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith("volli:terminal-data", {
      sessionId,
      data: `${"x".repeat(255_999)}yz`,
    });
    // The pending timer was cleared by the size-triggered flush.
    vi.advanceTimersByTime(100);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it("flushes buffered output before the exit event", async () => {
    vi.useFakeTimers();
    const { sessionId, pty, sender } = await createSession();
    pty.emitData("final ");
    pty.emitData("bytes");
    pty.emitExit(0);
    expect(sender.send.mock.calls).toEqual([
      ["volli:terminal-data", { sessionId, data: "final bytes" }],
      ["volli:terminal-exit", { sessionId, exitCode: 0 }],
    ]);
  });

  it("drops buffered output and its timer on kill", async () => {
    vi.useFakeTimers();
    const { sessionId, pty, sender } = await createSession();
    pty.emitData("never delivered");
    expect(invokeKill(sessionId)).toEqual({ ok: true });
    vi.advanceTimersByTime(100);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("ignores chunks emitted after the session was killed", async () => {
    vi.useFakeTimers();
    const { sessionId, pty, sender } = await createSession();
    expect(invokeKill(sessionId)).toEqual({ ok: true });
    // node-pty can deliver a final read after kill; the session is forgotten,
    // so the chunk must not buffer, schedule a flush, or send.
    pty.emitData("posthumous");
    vi.advanceTimersByTime(100);
    expect(sender.send).not.toHaveBeenCalled();
  });
});

describe("flow control", () => {
  /** Boots a session and pushes one over-watermark payload through a flush. */
  async function createPausedSession() {
    const session = await createSession();
    session.pty.emitData("x".repeat(100_001));
    flushBatchWindow();
    expect(session.pty.pause).toHaveBeenCalledTimes(1);
    return session;
  }

  it("pauses the pty once unacked output exceeds the 100k high watermark", async () => {
    vi.useFakeTimers();
    const { pty } = await createSession();
    pty.emitData("x".repeat(100_000));
    flushBatchWindow();
    // Exactly at the watermark: not yet over it.
    expect(pty.pause).not.toHaveBeenCalled();
    pty.emitData("y");
    flushBatchWindow();
    expect(pty.pause).toHaveBeenCalledTimes(1);
  });

  it("resumes only after acks drain unacked output to the 5k low watermark", async () => {
    vi.useFakeTimers();
    const { sessionId, pty, sender } = await createPausedSession();
    sendAck(sender, sessionId, 50_000); // 50_001 unacked — still above low water.
    expect(pty.resume).not.toHaveBeenCalled();
    sendAck(sender, sessionId, 46_000); // 4_001 unacked — below low water.
    expect(pty.resume).toHaveBeenCalledTimes(1);
  });

  it("ignores acks from a webContents that does not own the session", async () => {
    vi.useFakeTimers();
    const { sessionId, pty } = await createPausedSession();
    const intruder = makeWebContents();
    sendAck(intruder, sessionId, 100_001);
    expect(pty.resume).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-string session id", 42, 100_001],
    ["non-number chars", "SESSION", "100001"],
    ["NaN chars", "SESSION", Number.NaN],
    ["infinite chars", "SESSION", Number.POSITIVE_INFINITY],
    ["zero chars", "SESSION", 0],
    ["negative chars", "SESSION", -5],
  ])("ignores an ack with %s", async (_label, badSessionId, badChars) => {
    vi.useFakeTimers();
    const { sessionId, pty, sender } = await createPausedSession();
    // "SESSION" is a placeholder for the real (per-test) session id.
    const sid = badSessionId === "SESSION" ? sessionId : badSessionId;
    expect(() => sendAck(sender, sid, badChars)).not.toThrow();
    expect(pty.resume).not.toHaveBeenCalled();
    // The session still resumes on a subsequent valid ack.
    sendAck(sender, sessionId, 100_001);
    expect(pty.resume).toHaveBeenCalledTimes(1);
  });

  it("ignores an ack for an unknown session", () => {
    expect(() => sendAck(makeWebContents(), "nope", 10)).not.toThrow();
  });
});

describe("volli:terminal-write", () => {
  it("writes to a live session", async () => {
    const { sessionId, pty } = await createSession();
    expect(invokeWrite(sessionId, "ls\r")).toEqual({ ok: true });
    expect(pty.write).toHaveBeenCalledWith("ls\r");
  });

  it("rejects an unknown session", () => {
    expect(invokeWrite("nope", "x")).toEqual({ ok: false, error: "Unknown terminal session" });
  });

  it.each([
    ["a non-string session id", 42, "x"],
    ["non-string data", "id", 42],
  ])("rejects %s", (_label, sessionId, data) => {
    expect(invokeWrite(sessionId, data)).toEqual({ ok: false, error: "Invalid terminal write" });
  });

  it("returns a typed error when the pty throws", async () => {
    const { sessionId, pty } = await createSession();
    pty.write.mockImplementationOnce(() => {
      throw new Error("EIO");
    });
    expect(invokeWrite(sessionId, "x")).toEqual({ ok: false, error: "EIO" });
  });
});

describe("volli:terminal-resize", () => {
  it("resizes a live session", async () => {
    const { sessionId, pty } = await createSession();
    expect(invokeResize(sessionId, 120, 40)).toEqual({ ok: true });
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
  });

  it("rejects an unknown session", () => {
    expect(invokeResize("nope", 80, 24)).toEqual({
      ok: false,
      error: "Unknown terminal session",
    });
  });

  it.each([
    ["a non-string session id", 42, 80, 24],
    ["non-number cols", "id", "80", 24],
    ["non-number rows", "id", 80, "24"],
  ])("rejects %s", (_label, sessionId, cols, rows) => {
    expect(invokeResize(sessionId, cols, rows)).toEqual({
      ok: false,
      error: "Invalid terminal resize",
    });
  });

  it("returns a typed error when the pty throws", async () => {
    const { sessionId, pty } = await createSession();
    pty.resize.mockImplementationOnce(() => {
      throw new Error("bad size");
    });
    expect(invokeResize(sessionId, 1, 1)).toEqual({ ok: false, error: "bad size" });
  });
});

describe("volli:terminal-kill", () => {
  it("kills a live session and forgets it", async () => {
    const { sessionId, pty, sender } = await createSession();
    expect(invokeKill(sessionId)).toEqual({ ok: true });
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(sender.removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function));
    // Second kill sees an unknown session.
    expect(invokeKill(sessionId)).toEqual({ ok: false, error: "Unknown terminal session" });
  });

  it("rejects an unknown session", () => {
    expect(invokeKill("nope")).toEqual({ ok: false, error: "Unknown terminal session" });
  });

  it("rejects a non-string session id", () => {
    expect(invokeKill(42)).toEqual({ ok: false, error: "Invalid terminal kill" });
  });

  it("returns a typed error when the pty throws", async () => {
    const { sessionId, pty } = await createSession();
    pty.kill.mockImplementationOnce(() => {
      throw new Error("ESRCH");
    });
    expect(invokeKill(sessionId)).toEqual({ ok: false, error: "ESRCH" });
  });

  it("tolerates the pty firing onExit after an explicit kill", async () => {
    const { sessionId, pty } = await createSession();
    expect(invokeKill(sessionId)).toEqual({ ok: true });
    // node-pty delivers onExit asynchronously after kill(); the second
    // forget() must be a harmless no-op on the already-dropped session.
    expect(() => pty.emitExit(0)).not.toThrow();
  });
});

describe("lifecycle teardown", () => {
  it("kills every live session on before-quit", async () => {
    const a = await createSession();
    const b = await createSession();
    appHandlers.get("before-quit")?.();
    expect(a.pty.kill).toHaveBeenCalledTimes(1);
    expect(b.pty.kill).toHaveBeenCalledTimes(1);
    expect(invokeKill(a.sessionId)).toEqual({ ok: false, error: "Unknown terminal session" });
    expect(invokeKill(b.sessionId)).toEqual({ ok: false, error: "Unknown terminal session" });
  });

  it("kills a session when its owning window is destroyed", async () => {
    const { sessionId, pty, sender } = await createSession();
    sender.fireDestroyed();
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(invokeKill(sessionId)).toEqual({ ok: false, error: "Unknown terminal session" });
  });

  it("skips removeListener when the owning window is already destroyed", async () => {
    const { sessionId, pty, sender } = await createSession();
    sender.destroyed = true;
    // Exit path runs forget() against a destroyed webContents.
    pty.emitExit(0);
    expect(sender.removeListener).not.toHaveBeenCalled();
    expect(invokeKill(sessionId)).toEqual({ ok: false, error: "Unknown terminal session" });
  });
});

/** The env captured by the most recent spawn call. */
function lastSpawnEnv(): Record<string, string> {
  const [, , options] = spawn.mock.calls.at(-1) as [
    string,
    string[],
    { env: Record<string, string> },
  ];
  return options.env;
}

/** Spawns a ticket session for `ticketId` and returns its result + fake pty. */
async function createTicketSession(ticketId: string, sender = makeWebContents()) {
  const pty = makeFakePty();
  spawn.mockReturnValueOnce(pty);
  const result = await invokeCreate(sender, {
    workspaceId: "w",
    cwd: root,
    cols: 80,
    rows: 24,
    ticket: { ticketId },
  });
  return { result, pty };
}

describe("ticket sessions", () => {
  beforeEach(() => {
    insertTicket(testDb.db, testTicket("w", { id: "tk1", ticketNumber: 12, harnessId: "codex" }));
  });

  it("persists a ticket-scoped record, records session_started, and injects ticket env", async () => {
    const { result } = await createTicketSession("tk1");
    if (!result.ok) throw new Error(`expected session, got ${result.error}`);

    // VOLLI_TICKET / VOLLI_TICKET_DIR always point at the MAIN repo's .volli;
    // ticket sessions run at the project root; TERM is still forced.
    const env = lastSpawnEnv();
    expect(env["VOLLI_TICKET"]).toBe("VC-12");
    expect(env["VOLLI_TICKET_DIR"]).toBe(`${root}/.volli/tickets/VC-12`);
    expect(env["TERM"]).toBe("xterm-256color");
    const [, , options] = spawn.mock.calls[0] as [string, string[], { cwd: string }];
    expect(options.cwd).toBe(root);

    // ensureTicketDir ran up front so an agent can write artifacts immediately.
    await expect(fs.stat(`${root}/.volli/tickets/VC-12/artifacts`)).resolves.toBeDefined();

    // Durable record: ticket-scoped, the ticket's harness, per-ticket title.
    expect(result.session).toMatchObject({
      id: result.sessionId,
      projectId: "w",
      ticketId: "tk1",
      harnessId: "codex",
      title: "Session 1",
      endedAt: null,
    });
    const rows = listTicketSessions(testDb.db, "tk1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: result.sessionId, ticketId: "tk1", title: "Session 1" });

    // session_started event in the same transaction.
    const started = listTicketEvents(testDb.db, "tk1").filter(
      (event) => event.payload.kind === "session_started",
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.payload).toEqual({
      kind: "session_started",
      sessionId: result.sessionId,
      title: "Session 1",
      harnessId: "codex",
    });
  });

  it("numbers ticket session titles per-ticket from the existing count", async () => {
    const first = await createTicketSession("tk1");
    const second = await createTicketSession("tk1");
    if (!first.result.ok || !second.result.ok) throw new Error("expected two sessions");
    expect(first.result.session.title).toBe("Session 1");
    expect(second.result.session.title).toBe("Session 2");
  });

  it("ends the record and records session_ended when a ticket session exits", async () => {
    const { result, pty } = await createTicketSession("tk1");
    if (!result.ok) throw new Error(`expected session, got ${result.error}`);

    pty.emitExit(0);

    expect(listTicketSessions(testDb.db, "tk1")[0]?.endedAt).not.toBeNull();
    const ended = listTicketEvents(testDb.db, "tk1").filter(
      (event) => event.payload.kind === "session_ended",
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toEqual({ kind: "session_ended", sessionId: result.sessionId });
  });

  it("rejects a ticket request naming an unknown ticket without spawning", async () => {
    const result = await invokeCreate(makeWebContents(), {
      workspaceId: "w",
      cwd: root,
      cols: 80,
      rows: 24,
      ticket: { ticketId: "ghost" },
    });
    expect(result).toEqual({ ok: false, error: "Unknown ticket" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("survives its ticket being deleted before exit: ends the row, records no event, still notifies + forgets", async () => {
    const sender = makeWebContents();
    const { result, pty } = await createTicketSession("tk1", sender);
    if (!result.ok) throw new Error(`expected session, got ${result.error}`);

    // Ticket deleted while the session is live → sessions.ticket_id is SET NULL
    // and the ticket's events are cascade-deleted. The stale in-memory ticketId
    // must NOT be used to record session_ended (that would violate the FK and
    // roll back the whole close-out, stranding the row as falsely-live).
    deleteTicket(testDb.db, "tk1");

    expect(() => pty.emitExit(0)).not.toThrow();

    const row = listSessions(testDb.db, "w").find((session) => session.id === result.sessionId);
    expect(row?.endedAt).not.toBeNull();
    expect(listTicketEvents(testDb.db, "tk1")).toEqual([]);
    expect(sender.send).toHaveBeenCalledWith("volli:terminal-exit", {
      sessionId: result.sessionId,
      exitCode: 0,
    });
    // Forgotten from the live map.
    expect(invokeKill(result.sessionId)).toEqual({
      ok: false,
      error: "Unknown terminal session",
    });
  });

  it("does not throw and still notifies + forgets when the whole close-out fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sender = makeWebContents();
    const { result, pty } = await createTicketSession("tk1", sender);
    if (!result.ok) throw new Error(`expected session, got ${result.error}`);

    // Close the db so the close-out transaction AND the catch's bare endSession
    // both throw. The exit path must swallow it and still notify + forget.
    testDb.db.close();

    expect(() => pty.emitExit(0)).not.toThrow();
    expect(sender.send).toHaveBeenCalledWith("volli:terminal-exit", {
      sessionId: result.sessionId,
      exitCode: 0,
    });
    expect(invokeKill(result.sessionId)).toEqual({
      ok: false,
      error: "Unknown terminal session",
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("scratch session persistence", () => {
  it("persists a project-scoped record with ticketId null and no ticket env", async () => {
    const { sessionId } = await createSession();

    expect(lastSpawnEnv()["VOLLI_TICKET"]).toBeUndefined();

    const rows = listSessions(testDb.db, "w");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: sessionId,
      ticketId: null,
      harnessId: "claude-code",
      title: "Terminal 1",
      endedAt: null,
    });
  });

  it("ends a scratch record on exit without recording any ticket event", async () => {
    const { sessionId, pty } = await createSession();
    pty.emitExit(0);
    const row = listSessions(testDb.db, "w").find((session) => session.id === sessionId);
    expect(row?.endedAt).not.toBeNull();
  });

  it("kills the pty and errors when persistence fails (workspace is not a real project)", async () => {
    const pty = makeFakePty();
    spawn.mockReturnValueOnce(pty);
    const result = await invokeCreate(makeWebContents(), {
      workspaceId: "ghost", // no project row → the session insert violates its FK
      cwd: root,
      cols: 80,
      rows: 24,
    });
    expect(result.ok).toBe(false);
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });
});

describe("degraded database", () => {
  it("reports the db-open error and never spawns when the database is unavailable", async () => {
    registerTerminalIpcHandlers({ ok: false, error: "disk full" });
    const result = await invokeCreate(makeWebContents(), {
      workspaceId: "w",
      cwd: root,
      cols: 80,
      rows: 24,
    });
    expect(result).toEqual({ ok: false, error: "disk full" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
