import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { CreateTerminalSessionResult, TerminalIoResult, VolliIpcChannel } from "@volli/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Hoisted above module evaluation, like ipc.test.ts, so the electron/node-pty
// mock factories can capture into them.
const { handlers, appHandlers, spawn } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  appHandlers: new Map<string, () => void>(),
  spawn: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
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
    emitData: (data: string) => dataCb?.(data),
    emitExit: (exitCode: number) => exitCb?.({ exitCode }),
  };
}

/** A WebContents double; `destroyed` listener and destroyed-state are steerable. */
function makeWebContents() {
  const listeners = new Map<string, () => void>();
  return {
    send: vi.fn(),
    destroyed: false,
    isDestroyed(): boolean {
      return this.destroyed;
    },
    once: vi.fn(function (this: unknown, event: string, cb: () => void) {
      listeners.set(event, cb);
    }),
    removeListener: vi.fn(),
    fireDestroyed() {
      listeners.get("destroyed")?.();
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

let root: string;
let outside: string;

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
  // Fresh manager + handlers each test (Map overwrites); reset roots.
  registerTerminalIpcHandlers();
  syncProjectRoots([root]);
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
    const { sessionId, pty, sender } = await createSession();
    pty.emitData("hello world");
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
  ])("rejects %s request without spawning", async (_label, req) => {
    const result = await invokeCreate(makeWebContents(), req);
    expect(result).toEqual({ ok: false, error: "Invalid terminal request" });
    expect(spawn).not.toHaveBeenCalled();
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
