import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { BrowserWindow, WebContents } from "electron";
import type {
  CreateTerminalSessionResult,
  Project,
  TerminalBusyResult,
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
const { handlers, listeners, appHandlers, spawn, showMessageBoxSync, appQuit } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, (...args: never[]) => unknown>(),
  appHandlers: new Map<string, (event: { preventDefault: () => void }) => void>(),
  spawn: vi.fn(),
  showMessageBoxSync: vi.fn(),
  appQuit: vi.fn(),
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
    on(event: string, handler: (event: { preventDefault: () => void }) => void) {
      appHandlers.set(event, handler);
    },
    quit: appQuit,
  },
  dialog: {
    showMessageBoxSync,
  },
}));

// The whole point of the lazy import in pty.ts: this mock stands in for the
// Electron-ABI native binary, which never loads under plain-Node vitest.
vi.mock("node-pty", () => ({ spawn }));

import { confirmDestructiveClose, PtyManager, registerTerminalIpcHandlers } from "./pty";
import type { ParkConfig, ProcessInspector } from "./park";
import { listTicketEvents } from "./db/events-repo";
import { insertProject } from "./db/projects-repo";
import { listSessions, listTicketSessions } from "./db/sessions-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "./db/test-helpers";
import { deleteTicket, insertTicket } from "./db/tickets-repo";
import { syncProjectRoots } from "./project-roots";

let ptyPidSeq = 1000;
/** A distinct fake pid per session, so park-tree assertions can't collide. */
function nextPid(): number {
  ptyPidSeq += 1;
  return ptyPidSeq;
}

/** A node-pty double whose onData/onExit callbacks can be fired on demand. */
function makeFakePty(pid = nextPid()) {
  let dataCb: ((data: string) => void) | undefined;
  let exitCb: ((event: { exitCode: number }) => void) | undefined;
  return {
    pid,
    onData: (cb: (data: string) => void) => {
      dataCb = cb;
    },
    onExit: (cb: (event: { exitCode: number }) => void) => {
      exitCb = cb;
    },
    // Foreground-process title `busy()` reads. A plain settable property, not
    // a getter — most tests never touch it; busy-probe tests assign it
    // directly, and use Object.defineProperty to make it throw.
    process: "",
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

/** Casts a WebContents double for the direct manager methods that take one. */
const asWc = (double: WebContentsDouble): WebContents => double as unknown as WebContents;

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

const invokeBusy = (sessionId: unknown) =>
  (handlers.get("volli:terminal-busy" satisfies VolliIpcChannel) as (...a: unknown[]) => unknown)(
    { sender: {} },
    sessionId,
  ) as TerminalBusyResult;

/** Casts a WebContents double to the real type for calls typed against it directly (not through IPC). */
const asWebContents = (sender: WebContentsDouble) => sender as unknown as WebContents;

/** A `before-quit` event double with a spyable `preventDefault`. */
const makeQuitEvent = () => ({ preventDefault: vi.fn() });

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

/** A `now` comfortably past the warm-park idle threshold from a fresh session. */
const idleNow = () => Date.now() + 10_000;
/** Real-time pause; mid-window actions land inside the 5ms breathe window. */
const tick = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

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

let priorParkDisable: string | undefined;

beforeAll(async () => {
  // The suite's registerTerminalIpcHandlers-built managers must not start a
  // real warm-park sweep against the real inspector; disable parking for them.
  // The dedicated "warm park" block constructs managers with explicit config.
  priorParkDisable = process.env["VOLLI_PARK_DISABLE"];
  process.env["VOLLI_PARK_DISABLE"] = "1";
  root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-pty-")));
  outside = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-pty-outside-")));
});

afterAll(async () => {
  if (priorParkDisable === undefined) delete process.env["VOLLI_PARK_DISABLE"];
  else process.env["VOLLI_PARK_DISABLE"] = priorParkDisable;
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
  vi.unstubAllEnvs();
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

describe("PtyManager.busy", () => {
  it("reports not busy for an unknown session", () => {
    expect(manager.busy("nope")).toEqual({ ok: true, busy: false, process: null });
  });

  it.each([
    ["the bare shell name", "zsh"],
    ["a login shell's leading dash", "-zsh"],
    ["the full spawned path (basename)", "/bin/zsh"],
  ])("treats %s as idle", async (_label, title) => {
    vi.stubEnv("SHELL", "/bin/zsh");
    const { sessionId, pty } = await createSession();
    pty.process = title;
    expect(manager.busy(sessionId)).toEqual({ ok: true, busy: false, process: null });
  });

  it.each([
    ["the bare process name", "claude", "claude"],
    ["a login-shell-style dash prefix", "-claude", "claude"],
  ])("reports busy for %s", async (_label, title, expectedProcess) => {
    vi.stubEnv("SHELL", "/bin/zsh");
    const { sessionId, pty } = await createSession();
    pty.process = title;
    expect(manager.busy(sessionId)).toEqual({ ok: true, busy: true, process: expectedProcess });
  });

  it("returns a typed error instead of throwing when the process getter throws", async () => {
    const { sessionId, pty } = await createSession();
    Object.defineProperty(pty, "process", {
      configurable: true,
      get() {
        throw new Error("ECHILD");
      },
    });
    expect(manager.busy(sessionId)).toEqual({ ok: false, error: "ECHILD" });
  });
});

describe("PtyManager.busySessions", () => {
  it("returns only sessions with a foreground process beyond their shell", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    await createSession(); // idle — contributes no entry below.
    const busy = await createSession();
    busy.pty.process = "claude";
    expect(manager.busySessions()).toEqual([{ sessionId: busy.sessionId, process: "claude" }]);
  });

  it("filters to one webContents' sessions when an owner is passed", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    const senderA = makeWebContents();
    const senderB = makeWebContents();
    const a = await createSession(senderA);
    const b = await createSession(senderB);
    a.pty.process = "claude";
    b.pty.process = "vim";
    expect(manager.busySessions(asWebContents(senderA))).toEqual([
      { sessionId: a.sessionId, process: "claude" },
    ]);
  });

  it("skips a session whose probe throws, without blocking enumeration of the rest", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    const throwing = await createSession();
    const busy = await createSession();
    Object.defineProperty(throwing.pty, "process", {
      configurable: true,
      get() {
        throw new Error("EIO");
      },
    });
    busy.pty.process = "claude";
    expect(manager.busySessions()).toEqual([{ sessionId: busy.sessionId, process: "claude" }]);
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

describe("volli:terminal-busy", () => {
  it("rejects a non-string session id", () => {
    expect(invokeBusy(42)).toEqual({ ok: false, error: "Invalid terminal busy query" });
  });

  it("reports not busy for an unknown session", () => {
    expect(invokeBusy("nope")).toEqual({ ok: true, busy: false, process: null });
  });

  it("routes a valid session id to the manager", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    const { sessionId, pty } = await createSession();
    pty.process = "claude";
    expect(invokeBusy(sessionId)).toEqual({ ok: true, busy: true, process: "claude" });
  });
});

describe("confirmDestructiveClose", () => {
  it("returns true when the user picks the confirm button (choice 0)", () => {
    showMessageBoxSync.mockReturnValueOnce(0);
    const confirmed = confirmDestructiveClose([{ process: "claude" }], {
      message: "Quit Volli?",
      confirmLabel: "Quit",
    });
    expect(confirmed).toBe(true);
  });

  it("returns false for any other choice (Cancel)", () => {
    showMessageBoxSync.mockReturnValueOnce(1);
    const confirmed = confirmDestructiveClose([{ process: "claude" }], {
      message: "Quit Volli?",
      confirmLabel: "Quit",
    });
    expect(confirmed).toBe(false);
  });

  it('passes [confirmLabel, "Cancel"] as buttons with Cancel as default/cancel id', () => {
    showMessageBoxSync.mockReturnValueOnce(1);
    confirmDestructiveClose([{ process: "claude" }], {
      message: "Quit Volli?",
      confirmLabel: "Quit",
    });
    const [options] = showMessageBoxSync.mock.calls[0] as [
      { buttons: string[]; defaultId: number; cancelId: number },
    ];
    expect(options.buttons).toEqual(["Quit", "Cancel"]);
    expect(options.defaultId).toBe(1);
    expect(options.cancelId).toBe(1);
  });

  it("details a single running process in the singular", () => {
    showMessageBoxSync.mockReturnValueOnce(1);
    confirmDestructiveClose([{ process: "claude" }], {
      message: "Quit Volli?",
      confirmLabel: "Quit",
    });
    const [options] = showMessageBoxSync.mock.calls[0] as [{ detail: string }];
    expect(options.detail).toBe("A terminal is still running “claude”. Closing will end it.");
  });

  it("details multiple running processes in the plural, deduped", () => {
    showMessageBoxSync.mockReturnValueOnce(1);
    confirmDestructiveClose([{ process: "claude" }, { process: "claude" }, { process: "vim" }], {
      message: "Quit Volli?",
      confirmLabel: "Quit",
    });
    const [options] = showMessageBoxSync.mock.calls[0] as [{ detail: string }];
    expect(options.detail).toBe(
      "3 terminals are still running (claude, vim). Closing will end them.",
    );
  });

  it("passes the window through to showMessageBoxSync when provided", () => {
    showMessageBoxSync.mockReturnValueOnce(1);
    const window = {} as unknown as BrowserWindow;
    confirmDestructiveClose([{ process: "claude" }], {
      message: "Quit Volli?",
      confirmLabel: "Quit",
      window,
    });
    expect(showMessageBoxSync).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ message: "Quit Volli?" }),
    );
  });

  it("proceeds without a dialog under VOLLI_SKIP_CLOSE_CONFIRM (e2e automation seam)", () => {
    vi.stubEnv("VOLLI_SKIP_CLOSE_CONFIRM", "1");
    try {
      const confirmed = confirmDestructiveClose([{ process: "claude" }], {
        message: "Quit Volli?",
        confirmLabel: "Quit",
      });
      expect(confirmed).toBe(true);
      expect(showMessageBoxSync).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("lifecycle teardown", () => {
  it("kills every live session on before-quit when nothing is busy, without a dialog", async () => {
    const a = await createSession();
    const b = await createSession();
    const event = makeQuitEvent();
    appHandlers.get("before-quit")?.(event);
    expect(a.pty.kill).toHaveBeenCalledTimes(1);
    expect(b.pty.kill).toHaveBeenCalledTimes(1);
    expect(invokeKill(a.sessionId)).toEqual({ ok: false, error: "Unknown terminal session" });
    expect(invokeKill(b.sessionId)).toEqual({ ok: false, error: "Unknown terminal session" });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(showMessageBoxSync).not.toHaveBeenCalled();
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

describe("before-quit gate", () => {
  it("prevents quit, shows a dialog, and kills nothing when the user cancels", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    showMessageBoxSync.mockReturnValueOnce(1); // Cancel
    const { pty } = await createSession();
    pty.process = "claude";
    const event = makeQuitEvent();
    appHandlers.get("before-quit")?.(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(showMessageBoxSync).toHaveBeenCalledTimes(1);
    expect(pty.kill).not.toHaveBeenCalled();
    expect(appQuit).not.toHaveBeenCalled();
  });

  it("confirms and kills everything in the same pass — the original quit stays in flight", async () => {
    vi.stubEnv("SHELL", "/bin/zsh");
    showMessageBoxSync.mockReturnValueOnce(0); // Quit
    const { pty } = await createSession();
    pty.process = "claude";

    const event = makeQuitEvent();
    appHandlers.get("before-quit")?.(event);
    expect(showMessageBoxSync).toHaveBeenCalledTimes(1);
    // The quit must neither be prevented nor re-issued: a quit re-called from
    // inside before-quit is swallowed by Electron and the app never exits.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(appQuit).not.toHaveBeenCalled();
    expect(pty.kill).toHaveBeenCalledTimes(1);
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
    insertTicket(testDb.db, testTicket("w", { id: "tk1", ticketNumber: 12 }));
  });

  it("persists a ticket-scoped record, records session_started, and injects ticket env", async () => {
    const { result } = await createTicketSession("tk1");
    if (!result.ok) throw new Error(`expected session, got ${result.error}`);

    // VOLLI_TICKET / VOLLI_ARTIFACTS_DIR always point at the MAIN repo's .volli;
    // ticket sessions run at the project root; TERM is still forced.
    const env = lastSpawnEnv();
    expect(env["VOLLI_TICKET"]).toBe("VC-12");
    expect(env["VOLLI_ARTIFACTS_DIR"]).toBe(`${root}/.volli/artifacts`);
    expect(env["TERM"]).toBe("xterm-256color");
    const [, , options] = spawn.mock.calls[0] as [string, string[], { cwd: string }];
    expect(options.cwd).toBe(root);

    // The project's .volli/artifacts dir was ensured up front so an agent can
    // write artifacts immediately.
    await expect(fs.stat(`${root}/.volli/artifacts`)).resolves.toBeDefined();

    // Durable record: ticket-scoped, the default harness (harness is no longer a
    // ticket property — migration 004), per-ticket title.
    expect(result.session).toMatchObject({
      id: result.sessionId,
      projectId: "w",
      ticketId: "tk1",
      harnessId: "claude-code",
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
      harnessId: "claude-code",
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

  it("fails with a surfaced error (never resurrecting the root) when the project folder is gone", async () => {
    // A project whose root path is within a registered root but does not exist
    // on disk (moved/deleted repo). ensureProjectArtifactsDir must NOT recreate it.
    const gonePath = join(root, "gone-repo");
    insertProject(testDb.db, testProject({ id: "p-gone", path: gonePath, ticketPrefix: "GO" }));
    insertTicket(testDb.db, testTicket("p-gone", { id: "tk-gone", ticketNumber: 1 }));
    syncProjectRoots([root]);

    const result = await invokeCreate(makeWebContents(), {
      workspaceId: "p-gone",
      cwd: gonePath,
      cols: 80,
      rows: 24,
      ticket: { ticketId: "tk-gone" },
    });
    expect(result).toEqual({
      ok: false,
      error: `Project folder no longer exists at ${gonePath}`,
    });
    expect(spawn).not.toHaveBeenCalled();
    await expect(fs.stat(gonePath)).rejects.toThrow();
  });

  it("fails when the project root path is a file, not a directory", async () => {
    const filePath = join(root, "root-is-a-file");
    await fs.writeFile(filePath, "not a dir", "utf8");
    insertProject(testDb.db, testProject({ id: "p-file", path: filePath, ticketPrefix: "FI" }));
    insertTicket(testDb.db, testTicket("p-file", { id: "tk-file", ticketNumber: 1 }));
    syncProjectRoots([root]);

    const result = await invokeCreate(makeWebContents(), {
      workspaceId: "p-file",
      cwd: filePath,
      cols: 80,
      rows: 24,
      ticket: { ticketId: "tk-file" },
    });
    expect(result).toEqual({
      ok: false,
      error: `Project folder no longer exists at ${filePath}`,
    });
    expect(spawn).not.toHaveBeenCalled();
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
  it("persists a project-scoped record with ticketId null, no VOLLI_TICKET, but the artifacts env", async () => {
    const { sessionId } = await createSession();

    // Scratch sessions get no VOLLI_TICKET, but DO get VOLLI_ARTIFACTS_DIR
    // (decision #9) pointing at the project's main-repo .volli/artifacts.
    const env = lastSpawnEnv();
    expect(env["VOLLI_TICKET"]).toBeUndefined();
    expect(env["VOLLI_ARTIFACTS_DIR"]).toBe(`${root}/.volli/artifacts`);

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

// ---- warm park (issue #51) ------------------------------------------------

/** A fake ProcessInspector: no `ps`/`pgrep`/`lsof` spawning, no real signals. */
function makeInspector() {
  const descendants = vi.fn(async (_pid: number): Promise<number[]> => []);
  const cpuPercents = vi.fn(async (_pids: readonly number[]) => new Map<number, number>());
  const listeningPids = vi.fn(async (_pids: readonly number[]) => new Set<number>());
  const signal = vi.fn((_pid: number, _sig: "SIGSTOP" | "SIGCONT"): boolean => true);
  const inspector: ProcessInspector = { descendants, cpuPercents, listeningPids, signal };
  return { inspector, descendants, cpuPercents, listeningPids, signal };
}

const ENABLED_CONFIG: ParkConfig = {
  idleThresholdMs: 1000,
  sweepIntervalMs: 1000,
  cpuBusyPercent: 0.5,
  quietSamplesRequired: 2,
  breatheWindowMs: 5,
  enabled: true,
};

describe("warm park", () => {
  let parts: ReturnType<typeof makeInspector>;
  let parkManager: PtyManager;

  beforeEach(() => {
    parts = makeInspector();
    parkManager = new PtyManager(testDb.db, "", parts.inspector, ENABLED_CONFIG);
  });

  /** Spawns a session on `parkManager` and returns its id, fake pty, and window. */
  async function createParkSession(pid?: number) {
    const pty = makeFakePty(pid);
    spawn.mockReturnValueOnce(pty);
    const sender = makeWebContents();
    const result = await parkManager.create(asWc(sender), {
      workspaceId: "w",
      cwd: root,
      cols: 80,
      rows: 24,
    });
    if (!result.ok) throw new Error(`expected session, got ${result.error}`);
    return { sessionId: result.sessionId, pty, sender };
  }

  /** Pids sent a given signal, in call order. */
  const signalledWith = (sig: "SIGSTOP" | "SIGCONT"): number[] =>
    parts.signal.mock.calls.filter((call) => call[1] === sig).map((call) => call[0]);
  const stopCalls = () => signalledWith("SIGSTOP");
  const contCalls = () => signalledWith("SIGCONT");

  describe("park", () => {
    it("stops parent first, then descendants, and re-collects a newly spawned child", async () => {
      const { sessionId, pty } = await createParkSession();
      parts.descendants
        .mockResolvedValueOnce([200]) // initial collect
        .mockResolvedValueOnce([200, 300]) // round 0: 300 appeared
        .mockResolvedValueOnce([200, 300]); // round 1: stable → break
      expect(await parkManager.park(sessionId, { manual: true })).toEqual({ ok: true });
      expect(stopCalls()).toEqual([pty.pid, 200, 300]);
    });

    it("bounds the re-collect loop at three rounds", async () => {
      const { sessionId, pty } = await createParkSession();
      parts.descendants
        .mockResolvedValueOnce([200])
        .mockResolvedValueOnce([200, 300])
        .mockResolvedValueOnce([200, 300, 400])
        .mockResolvedValueOnce([200, 300, 400, 500]);
      await parkManager.park(sessionId, { manual: true });
      expect(stopCalls()).toEqual([pty.pid, 200, 300, 400, 500]);
    });

    it("pushes a park-state event on park", async () => {
      const { sessionId, sender } = await createParkSession();
      await parkManager.park(sessionId, { manual: true });
      expect(sender.send).toHaveBeenCalledWith("volli:terminal-park-state", {
        sessionId,
        parked: true,
        keepAwake: false,
      });
    });

    it("skips the park-state push when the window is destroyed", async () => {
      const { sessionId, sender } = await createParkSession();
      sender.destroyed = true;
      await parkManager.park(sessionId, { manual: true });
      expect(sender.send).not.toHaveBeenCalled();
    });

    it("is a no-op on an already-parked session", async () => {
      const { sessionId } = await createParkSession();
      await parkManager.park(sessionId, { manual: true });
      parts.signal.mockClear();
      expect(await parkManager.park(sessionId, { manual: true })).toEqual({ ok: true });
      expect(parts.signal).not.toHaveBeenCalled();
    });

    it("an auto park request on an already-parked session stays auto (still breathes)", async () => {
      const { sessionId, pty } = await createParkSession();
      await parkManager.park(sessionId, { manual: false });
      parts.signal.mockClear();
      expect(await parkManager.park(sessionId, { manual: false })).toEqual({ ok: true });
      await parkManager.sweep(idleNow()); // not upgraded to manual: the duty cycle touches it
      expect(contCalls()).toEqual([pty.pid]);
    });

    it("auto-park refuses a visible session", async () => {
      const { sessionId, sender } = await createParkSession();
      parkManager.setVisible(asWc(sender), sessionId, true);
      expect(await parkManager.park(sessionId, { manual: false })).toEqual({
        ok: false,
        error: "Session is visible or kept awake",
      });
    });

    it("auto-park refuses a kept-awake session", async () => {
      const { sessionId } = await createParkSession();
      parkManager.setKeepAwake(sessionId, true);
      expect(await parkManager.park(sessionId, { manual: false })).toEqual({
        ok: false,
        error: "Session is visible or kept awake",
      });
    });

    it("auto-park refuses, before any SIGSTOP, a session whose PTY output landed mid-collect", async () => {
      const { sessionId, pty } = await createParkSession();
      parts.descendants.mockImplementationOnce(async () => {
        await tick(2); // let the ms clock advance past the entry baseline
        pty.emitData("resumed work");
        return [200];
      });
      expect(await parkManager.park(sessionId, { manual: false })).toEqual({
        ok: false,
        error: "Session became active while parking",
      });
      expect(stopCalls()).toEqual([]);
    });

    it("CONTs the half-stopped tree when buffered output drains during a rescan round", async () => {
      const { sessionId, pty } = await createParkSession();
      parts.descendants
        .mockResolvedValueOnce([200]) // initial collect: quiet
        .mockImplementationOnce(async () => {
          await tick(2);
          pty.emitData("late buffered bytes"); // drains after the SIGSTOPs
          return [200];
        });
      expect(await parkManager.park(sessionId, { manual: false })).toEqual({
        ok: false,
        error: "Session became active while parking",
      });
      expect(stopCalls()).toEqual([pty.pid, 200]);
      expect(contCalls()).toEqual([200, pty.pid]); // reverse stop order
    });

    it("CONTs the stopped tree and propagates when a rescan round itself fails", async () => {
      const { sessionId, pty } = await createParkSession();
      parts.descendants
        .mockResolvedValueOnce([200])
        .mockRejectedValueOnce(new Error("pgrep unavailable"));
      await expect(parkManager.park(sessionId, { manual: true })).rejects.toThrow(
        "pgrep unavailable",
      );
      expect(stopCalls()).toEqual([pty.pid, 200]);
      expect(contCalls()).toEqual([200, pty.pid]); // no frozen-tree leak
    });

    it("manual park bypasses the visible and keep-awake guards", async () => {
      const { sessionId, sender, pty } = await createParkSession();
      parkManager.setVisible(asWc(sender), sessionId, true);
      parkManager.setKeepAwake(sessionId, true);
      expect(await parkManager.park(sessionId, { manual: true })).toEqual({ ok: true });
      expect(stopCalls()).toEqual([pty.pid]);
    });

    it("errors on an unknown session", async () => {
      expect(await parkManager.park("nope", { manual: true })).toEqual({
        ok: false,
        error: "Unknown terminal session",
      });
    });

    it("refuses even a manual park when parking is disabled", async () => {
      const disabled = new PtyManager(testDb.db, "", parts.inspector, {
        ...ENABLED_CONFIG,
        enabled: false,
      });
      const pty = makeFakePty();
      spawn.mockReturnValueOnce(pty);
      const sender = makeWebContents();
      const created = await disabled.create(asWc(sender), {
        workspaceId: "w",
        cwd: root,
        cols: 80,
        rows: 24,
      });
      if (!created.ok) throw new Error(created.error);
      expect(await disabled.park(created.sessionId, { manual: true })).toEqual({
        ok: false,
        error: "Session parking is disabled",
      });
      expect(parts.signal).not.toHaveBeenCalled();
    });

    it("bails without stopping anything when the session is killed during the initial collect", async () => {
      const { sessionId } = await createParkSession();
      parts.descendants.mockImplementationOnce(async () => {
        parkManager.kill(sessionId);
        return [200];
      });
      expect(await parkManager.park(sessionId, { manual: true })).toEqual({
        ok: false,
        error: "Session ended while parking",
      });
      expect(stopCalls()).toEqual([]);
    });

    it("continues the already-stopped tree when the session is killed during a rescan", async () => {
      const { sessionId, pty } = await createParkSession();
      parts.descendants
        .mockResolvedValueOnce([200]) // initial collect
        .mockImplementationOnce(async () => {
          // Kill lands between the stop pass and the rescan: park must CONT
          // what it stopped so the kill's pending SIGHUP can act on the tree.
          parkManager.kill(sessionId);
          return [200];
        });
      expect(await parkManager.park(sessionId, { manual: true })).toEqual({
        ok: false,
        error: "Session ended while parking",
      });
      expect(stopCalls()).toEqual([pty.pid, 200]);
      expect(contCalls()).toEqual([200, pty.pid]);
    });
  });

  describe("wake", () => {
    it("continues the tree in reverse of the stop order", async () => {
      const { sessionId, pty } = await createParkSession();
      parts.descendants.mockResolvedValueOnce([200, 300]).mockResolvedValueOnce([200, 300]);
      await parkManager.park(sessionId, { manual: true });
      expect(stopCalls()).toEqual([pty.pid, 200, 300]);
      expect(parkManager.wake(sessionId)).toEqual({ ok: true });
      expect(contCalls()).toEqual([300, 200, pty.pid]);
    });

    it("pushes a park-state event on wake", async () => {
      const { sessionId, sender } = await createParkSession();
      await parkManager.park(sessionId, { manual: true });
      sender.send.mockClear();
      parkManager.wake(sessionId);
      expect(sender.send).toHaveBeenCalledWith("volli:terminal-park-state", {
        sessionId,
        parked: false,
        keepAwake: false,
      });
    });

    it("is a no-op on a running session", async () => {
      const { sessionId } = await createParkSession();
      expect(parkManager.wake(sessionId)).toEqual({ ok: true });
      expect(parts.signal).not.toHaveBeenCalled();
    });

    it("errors on an unknown session", () => {
      expect(parkManager.wake("nope")).toEqual({ ok: false, error: "Unknown terminal session" });
    });
  });

  describe("write / resize / kill interaction", () => {
    it("wakes a parked session before writing to it", async () => {
      const { sessionId, pty } = await createParkSession();
      await parkManager.park(sessionId, { manual: true });
      expect(pty.write).not.toHaveBeenCalled();
      expect(parkManager.write(sessionId, "ls\r")).toEqual({ ok: true });
      expect(contCalls()).toEqual([pty.pid]);
      expect(pty.write).toHaveBeenCalledWith("ls\r");
    });

    it("does not wake a parked session on resize", async () => {
      const { sessionId, pty } = await createParkSession();
      await parkManager.park(sessionId, { manual: true });
      expect(parkManager.resize(sessionId, 100, 40)).toEqual({ ok: true });
      expect(contCalls()).toEqual([]);
      expect(pty.resize).toHaveBeenCalledWith(100, 40);
    });

    it("continues a parked session before killing it", async () => {
      const { sessionId, pty } = await createParkSession();
      await parkManager.park(sessionId, { manual: true });
      expect(parkManager.kill(sessionId)).toEqual({ ok: true });
      expect(contCalls()).toEqual([pty.pid]);
      expect(pty.kill).toHaveBeenCalledTimes(1);
    });
  });

  describe("setVisible", () => {
    it("ignores a flip from a non-owning sender", async () => {
      const { sessionId } = await createParkSession();
      parkManager.setVisible(asWc(makeWebContents()), sessionId, true);
      // Visibility stayed false, so auto-park still proceeds.
      expect(await parkManager.park(sessionId, { manual: false })).toEqual({ ok: true });
    });

    it("wakes a parked session when its pane becomes visible", async () => {
      const { sessionId, sender, pty } = await createParkSession();
      await parkManager.park(sessionId, { manual: true });
      parkManager.setVisible(asWc(sender), sessionId, true);
      expect(contCalls()).toEqual([pty.pid]);
    });

    it("does not wake when a pane is hidden", async () => {
      const { sessionId, sender } = await createParkSession();
      await parkManager.park(sessionId, { manual: true });
      parkManager.setVisible(asWc(sender), sessionId, false);
      expect(contCalls()).toEqual([]);
    });

    it("ignores an unknown session", () => {
      expect(() => parkManager.setVisible(asWc(makeWebContents()), "nope", true)).not.toThrow();
    });
  });

  describe("setKeepAwake", () => {
    it("pushes a park-state event reflecting the pin", async () => {
      const { sessionId, sender } = await createParkSession();
      parkManager.setKeepAwake(sessionId, true);
      expect(sender.send).toHaveBeenCalledWith("volli:terminal-park-state", {
        sessionId,
        parked: false,
        keepAwake: true,
      });
    });

    it("wakes an already-parked session when pinned", async () => {
      const { sessionId, pty } = await createParkSession();
      await parkManager.park(sessionId, { manual: true });
      expect(parkManager.setKeepAwake(sessionId, true)).toEqual({ ok: true });
      expect(contCalls()).toEqual([pty.pid]);
    });

    it("clearing the pin never wakes", async () => {
      const { sessionId } = await createParkSession();
      await parkManager.park(sessionId, { manual: true });
      parts.signal.mockClear();
      parkManager.setKeepAwake(sessionId, false);
      expect(parts.signal).not.toHaveBeenCalled();
    });

    it("errors on an unknown session", () => {
      expect(parkManager.setKeepAwake("nope", true)).toEqual({
        ok: false,
        error: "Unknown terminal session",
      });
    });
  });

  describe("sweep", () => {
    it("does nothing when parking is disabled", async () => {
      const disabled = new PtyManager(testDb.db, "", parts.inspector, {
        ...ENABLED_CONFIG,
        enabled: false,
      });
      const pty = makeFakePty();
      spawn.mockReturnValueOnce(pty);
      await disabled.create(asWc(makeWebContents()), {
        workspaceId: "w",
        cwd: root,
        cols: 80,
        rows: 24,
      });
      await disabled.sweep(idleNow());
      expect(parts.descendants).not.toHaveBeenCalled();
    });

    it("skips a visible session at stage 1", async () => {
      const { sessionId, sender } = await createParkSession();
      parkManager.setVisible(asWc(sender), sessionId, true);
      await parkManager.sweep(idleNow());
      expect(stopCalls()).toEqual([]);
      expect(parts.descendants).not.toHaveBeenCalled();
    });

    it("skips a recently-active session at stage 1", async () => {
      await createParkSession();
      await parkManager.sweep(Date.now()); // within the idle threshold
      expect(stopCalls()).toEqual([]);
    });

    it("requires two consecutive CPU-quiet sweeps, and a busy sweep resets the streak", async () => {
      const { pty } = await createParkSession();
      await parkManager.sweep(idleNow()); // quiet sample 1
      expect(stopCalls()).toEqual([]);
      parts.cpuPercents.mockResolvedValueOnce(new Map([[pty.pid, 5]])); // busy
      await parkManager.sweep(idleNow()); // streak reset to 0
      expect(stopCalls()).toEqual([]);
      await parkManager.sweep(idleNow()); // quiet sample 1
      expect(stopCalls()).toEqual([]);
      await parkManager.sweep(idleNow()); // quiet sample 2 → park
      expect(stopCalls()).toEqual([pty.pid]);
    });

    it("never parks a tree holding a LISTEN socket, but retries once it clears", async () => {
      const { pty } = await createParkSession();
      parts.listeningPids.mockResolvedValue(new Set([pty.pid]));
      await parkManager.sweep(idleNow()); // sample 1
      await parkManager.sweep(idleNow()); // sample 2 → stage 3 → listener → skip
      expect(stopCalls()).toEqual([]);
      parts.listeningPids.mockResolvedValue(new Set());
      await parkManager.sweep(idleNow()); // listener gone → park
      expect(stopCalls()).toEqual([pty.pid]);
    });

    it("never parks a session whose PTY produced output during the sweep's async stages", async () => {
      const { pty } = await createParkSession();
      await parkManager.sweep(idleNow()); // quiet sample 1
      // Output lands during the final listener check — after eligibility was
      // judged, before park() runs. The stage-1 activity baseline must catch it.
      parts.listeningPids.mockImplementationOnce(async () => {
        await tick(2);
        pty.emitData("resumed work");
        return new Set<number>();
      });
      await parkManager.sweep(idleNow()); // quiet sample 2 → park attempt
      expect(stopCalls()).toEqual([]);
    });

    it("logs and parks nothing when inspection fails — never an unhandled rejection", async () => {
      await createParkSession();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        parts.cpuPercents.mockRejectedValue(new Error("ps unavailable"));
        await expect(parkManager.sweep(idleNow())).resolves.toBeUndefined();
        expect(stopCalls()).toEqual([]);
        expect(consoleError).toHaveBeenCalledOnce();
      } finally {
        consoleError.mockRestore();
      }
    });

    it("skips the overlapping tick while a slow sweep is still running", async () => {
      // Assigned synchronously when the first sweep calls descendants, before we
      // release it below.
      let release!: (pids: number[]) => void;
      parts.descendants.mockImplementationOnce(
        () =>
          new Promise<number[]>((resolve) => {
            release = resolve;
          }),
      );
      await createParkSession();
      const first = parkManager.sweep(idleNow()); // suspends at descendants
      await parkManager.sweep(idleNow()); // sweeping flag set → returns at once
      expect(parts.descendants).toHaveBeenCalledTimes(1);
      release([]);
      await first;
    });

    it("runs on its interval via startParkSweep and halts on stopParkSweep", async () => {
      const manager2 = new PtyManager(testDb.db, "", parts.inspector, {
        ...ENABLED_CONFIG,
        idleThresholdMs: 0,
        quietSamplesRequired: 1,
      });
      const pty = makeFakePty();
      spawn.mockReturnValueOnce(pty);
      const created = await manager2.create(asWc(makeWebContents()), {
        workspaceId: "w",
        cwd: root,
        cols: 80,
        rows: 24,
      });
      if (!created.ok) throw new Error("expected session");
      vi.useFakeTimers();
      manager2.startParkSweep();
      manager2.startParkSweep(); // idempotent: hits the already-running guard
      await vi.advanceTimersByTimeAsync(ENABLED_CONFIG.sweepIntervalMs);
      expect(stopCalls()).toEqual([pty.pid]);
      manager2.stopParkSweep();
      parts.signal.mockClear();
      await vi.advanceTimersByTimeAsync(ENABLED_CONFIG.sweepIntervalMs * 5);
      expect(parts.signal).not.toHaveBeenCalled();
    });

    it("startParkSweep is inert when disabled, and stopParkSweep tolerates no timer", () => {
      const disabled = new PtyManager(testDb.db, "", parts.inspector, {
        ...ENABLED_CONFIG,
        enabled: false,
      });
      expect(() => {
        disabled.startParkSweep();
        disabled.stopParkSweep();
      }).not.toThrow();
    });
  });

  describe("breathe", () => {
    /** Spawns a hidden session, auto-parks it, and clears signal/send history. */
    async function createAutoParked() {
      const created = await createParkSession();
      await parkManager.park(created.sessionId, { manual: false });
      parts.signal.mockClear();
      created.sender.send.mockClear();
      return created;
    }

    it("re-freezes a session whose breathe window stays quiet", async () => {
      const { sessionId, pty } = await createAutoParked();
      await parkManager.sweep(idleNow());
      expect(contCalls()).toEqual([pty.pid]);
      expect(stopCalls()).toEqual([pty.pid]);
      // Still parked: an explicit wake CONTs the re-frozen tree.
      parts.signal.mockClear();
      parkManager.wake(sessionId);
      expect(contCalls()).toEqual([pty.pid]);
    });

    it("wakes on output during the window instead of re-freezing", async () => {
      const { sessionId, pty, sender } = await createAutoParked();
      const sweepDone = parkManager.sweep(idleNow());
      await tick(1);
      pty.emitData("tick");
      await sweepDone;
      expect(stopCalls()).toEqual([]);
      expect(sender.send).toHaveBeenCalledWith("volli:terminal-park-state", {
        sessionId,
        parked: false,
        keepAwake: false,
      });
    });

    it("wakes when the tree shows CPU after the window", async () => {
      const { sessionId, pty, sender } = await createAutoParked();
      parts.cpuPercents.mockResolvedValue(new Map([[pty.pid, 5]]));
      await parkManager.sweep(idleNow());
      expect(stopCalls()).toEqual([]);
      expect(sender.send).toHaveBeenCalledWith("volli:terminal-park-state", {
        sessionId,
        parked: false,
        keepAwake: false,
      });
    });

    it("wakes when the tree forked a new child during the window", async () => {
      const { sessionId, sender } = await createAutoParked();
      parts.descendants.mockResolvedValue([999]);
      await parkManager.sweep(idleNow());
      expect(stopCalls()).toEqual([]);
      expect(sender.send).toHaveBeenCalledWith("volli:terminal-park-state", {
        sessionId,
        parked: false,
        keepAwake: false,
      });
    });

    it("wakes when a listener appeared in the tree", async () => {
      const { pty, sender, sessionId } = await createAutoParked();
      parts.listeningPids.mockResolvedValue(new Set([pty.pid]));
      await parkManager.sweep(idleNow());
      expect(stopCalls()).toEqual([]);
      expect(sender.send).toHaveBeenCalledWith("volli:terminal-park-state", {
        sessionId,
        parked: false,
        keepAwake: false,
      });
    });

    it("never breathes a manually parked session", async () => {
      const { sessionId } = await createParkSession();
      await parkManager.park(sessionId, { manual: true });
      parts.signal.mockClear();
      await parkManager.sweep(idleNow());
      expect(contCalls()).toEqual([]);
      expect(stopCalls()).toEqual([]);
    });

    it("a Park Now landing mid-window beats a busy verdict and stays manual", async () => {
      const { sessionId, pty } = await createAutoParked();
      parts.cpuPercents.mockResolvedValue(new Map([[pty.pid, 5]])); // would wake
      const sweepDone = parkManager.sweep(idleNow());
      await tick(1);
      expect(await parkManager.park(sessionId, { manual: true })).toEqual({ ok: true });
      await sweepDone;
      expect(stopCalls()).toEqual([pty.pid]); // re-frozen despite the busy tree
      parts.signal.mockClear();
      await parkManager.sweep(idleNow()); // now exempt from the duty cycle
      expect(contCalls()).toEqual([]);
    });

    it("leaves a session alone when it is killed during the window", async () => {
      const { sessionId, pty } = await createAutoParked();
      const sweepDone = parkManager.sweep(idleNow());
      await tick(1);
      parkManager.kill(sessionId); // CONT-before-kill wakes it first
      pty.emitExit(0); // the tree dies inside the window
      await sweepDone;
      expect(stopCalls()).toEqual([]);
      expect(pty.kill).toHaveBeenCalledTimes(1);
    });

    it("leaves a session running when explicitly woken during the window", async () => {
      const { sessionId } = await createAutoParked();
      const sweepDone = parkManager.sweep(idleNow());
      await tick(1);
      expect(parkManager.wake(sessionId)).toEqual({ ok: true });
      await sweepDone;
      expect(stopCalls()).toEqual([]);
    });

    it("skips a session woken during the sampling awaits", async () => {
      const { sessionId } = await createAutoParked();
      parts.cpuPercents.mockImplementationOnce(async () => {
        parkManager.wake(sessionId);
        return new Map<number, number>();
      });
      await parkManager.sweep(idleNow());
      expect(stopCalls()).toEqual([]);
    });

    it("fails open — wakes instead of re-freezing — when inspection dies mid-breathe", async () => {
      const { sessionId, pty, sender } = await createAutoParked();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        parts.descendants.mockRejectedValueOnce(new Error("pgrep unavailable"));
        await expect(parkManager.sweep(idleNow())).resolves.toBeUndefined();
        expect(stopCalls()).toEqual([]); // nothing re-frozen
        // CONT'd for the window, then CONT'd again by the fail-open wake.
        expect(contCalls()).toEqual([pty.pid, pty.pid]);
        expect(sender.send).toHaveBeenCalledWith("volli:terminal-park-state", {
          sessionId,
          parked: false,
          keepAwake: false,
        });
        expect(consoleError).toHaveBeenCalledOnce();
      } finally {
        consoleError.mockRestore();
      }
    });

    it("leaves a session killed during a failing breathe to the kill path", async () => {
      const { sessionId, pty } = await createAutoParked();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        parts.descendants.mockImplementationOnce(async () => {
          parkManager.kill(sessionId); // dies mid-inspection
          throw new Error("pgrep died");
        });
        await expect(parkManager.sweep(idleNow())).resolves.toBeUndefined();
        // kill() already woke and forgot it — the fail-open pass must not touch it.
        expect(pty.kill).toHaveBeenCalledTimes(1);
        expect(stopCalls()).toEqual([]);
      } finally {
        consoleError.mockRestore();
      }
    });

    it("syncs the badge when the re-freeze itself dies mid-park", async () => {
      const { sessionId, pty, sender } = await createAutoParked();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        parts.descendants
          .mockResolvedValueOnce([]) // breathe's tree walk: quiet verdict
          .mockResolvedValueOnce([]) // re-freeze park(): initial collect
          .mockRejectedValueOnce(new Error("pgrep died")); // park's rescan round
        await expect(parkManager.sweep(idleNow())).resolves.toBeUndefined();
        // The aborted park CONT'd its own SIGSTOPs — nothing left frozen…
        expect(contCalls()).toEqual([pty.pid, pty.pid]);
        // …and the badge reflects the awake reality despite the failure.
        expect(sender.send).toHaveBeenCalledWith("volli:terminal-park-state", {
          sessionId,
          parked: false,
          keepAwake: false,
        });
        expect(consoleError).toHaveBeenCalledOnce();
      } finally {
        consoleError.mockRestore();
      }
    });

    it("stays awake and syncs the badge when late activity refuses the re-freeze", async () => {
      const { sessionId, pty, sender } = await createAutoParked();
      parts.descendants
        .mockResolvedValueOnce([]) // breathe's tree walk: quiet verdict
        .mockImplementationOnce(async () => {
          await tick(2);
          pty.emitData("late output"); // lands inside the re-freeze park()
          return [];
        });
      await parkManager.sweep(idleNow());
      expect(stopCalls()).toEqual([]);
      expect(sender.send).toHaveBeenCalledWith("volli:terminal-park-state", {
        sessionId,
        parked: false,
        keepAwake: false,
      });
    });
  });
});

// The park/wake/keep-awake/set-visible IPC handlers validate their args and
// forward to the manager. Valid-arg paths use an unknown session id so the
// manager short-circuits before any (real) process inspection.
const invokePark = (sessionId: unknown) =>
  (handlers.get("volli:terminal-park" satisfies VolliIpcChannel) as (...a: unknown[]) => unknown)(
    { sender: {} },
    sessionId,
  ) as Promise<TerminalIoResult>;

const invokeWake = (sessionId: unknown) =>
  (handlers.get("volli:terminal-wake" satisfies VolliIpcChannel) as (...a: unknown[]) => unknown)(
    { sender: {} },
    sessionId,
  ) as TerminalIoResult;

const invokeKeepAwake = (sessionId: unknown, keepAwake: unknown) =>
  (
    handlers.get("volli:terminal-keep-awake" satisfies VolliIpcChannel) as (
      ...a: unknown[]
    ) => unknown
  )({ sender: {} }, sessionId, keepAwake) as TerminalIoResult;

const sendSetVisible = (sender: unknown, sessionId: unknown, visible: unknown) =>
  (
    listeners.get("volli:terminal-set-visible" satisfies VolliIpcChannel) as (
      ...a: unknown[]
    ) => unknown
  )({ sender }, sessionId, visible);

describe("park/wake/keep-awake/set-visible IPC", () => {
  it("park rejects a non-string session id", async () => {
    expect(await invokePark(42)).toEqual({ ok: false, error: "Invalid terminal park" });
  });

  it("park forwards a valid id to the manager", async () => {
    // The suite runs under VOLLI_PARK_DISABLE, so the registered manager's
    // park refuses before the unknown-session lookup — proving the handler
    // forwarded the id into the manager either way.
    expect(await invokePark("nope")).toEqual({ ok: false, error: "Session parking is disabled" });
  });

  it("wake rejects a non-string session id", () => {
    expect(invokeWake(42)).toEqual({ ok: false, error: "Invalid terminal wake" });
  });

  it("wake forwards a valid id to the manager", () => {
    expect(invokeWake("nope")).toEqual({ ok: false, error: "Unknown terminal session" });
  });

  it.each([
    ["a non-string session id", 42, true],
    ["a non-boolean flag", "id", "yes"],
  ])("keep-awake rejects %s", (_label, sessionId, keepAwake) => {
    expect(invokeKeepAwake(sessionId, keepAwake)).toEqual({
      ok: false,
      error: "Invalid terminal keep-awake",
    });
  });

  it("keep-awake forwards valid args to the manager", () => {
    expect(invokeKeepAwake("nope", true)).toEqual({ ok: false, error: "Unknown terminal session" });
  });

  it.each([
    ["a non-string session id", 42, true],
    ["a non-boolean flag", "id", "yes"],
  ])("set-visible ignores %s", (_label, sessionId, visible) => {
    expect(() => sendSetVisible({}, sessionId, visible)).not.toThrow();
  });

  it("set-visible forwards valid args to the manager", () => {
    expect(() => sendSetVisible({}, "nope", true)).not.toThrow();
  });
});
