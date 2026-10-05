import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Exercise the installed patch, not a second implementation of it. Fake the
// kernel boundary: libuv reports EOF while read(2) still has the shell's tail.
// The constructor regression runs unchanged on macOS and Linux without loading
// the native addon. The real-shell contract is covered by manager.pty.test.ts.
const require = createRequire(import.meta.url);
const lib = dirname(require.resolve("node-pty"));
const packageRequire = createRequire(join(lib, "unixTerminal.js"));
const sockets: Readable[] = [];

const errno = (code: string) => Object.assign(new Error(code), { code });
function kernel(...chunks: Array<Buffer | Error>) {
  const readSync = vi.fn(
    (_fd: number, buffer: Buffer, offset: number, length: number, _position: null) => {
      const next = chunks.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) return 0;
      const count = Math.min(next.length, length);
      next.copy(buffer, offset, 0, count);
      if (count < next.length) chunks.unshift(next.subarray(count));
      return count;
    },
  );
  return { readSync };
}

function stream() {
  const socket = new Readable({ read() {} });
  sockets.push(socket);
  return socket;
}

function evaluate(file: string, load: (id: string) => unknown): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(join(lib, file), "utf8"), {
    exports,
    require: load,
    __dirname: lib,
    Buffer,
    Date,
    process: { platform: "linux", env: {}, cwd: () => "/project" },
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
    setImmediate,
    clearImmediate,
    console,
  });
  return exports;
}

type Guard = (socket: Readable, fd: number) => () => void;
function guard(raw: ReturnType<typeof kernel>): Guard {
  return evaluate("linuxPtyEof.js", (id) => {
    if (id !== "fs") throw new Error(`unexpected dependency: ${id}`);
    return raw;
  }).guardLinuxPtyEof as Guard;
}

const tick = () => new Promise<void>((done) => setImmediate(done));
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  vi.useRealTimers();
});

describe("node-pty Linux EOF drain (VC-639)", () => {
  it.each(["EOF first", "native exit first"])(
    "delivers the shell's final bytes before exit after premature EOF (%s)",
    async (order) => {
      const socket = stream();
      const raw = kernel(Buffer.from("bye-8\r\n"), errno("EIO"));
      let nativeExit: ((code: number, signal: number) => void) | undefined;
      const patched = evaluate("unixTerminal.js", (id) => {
        if (id === "fs") return { ...fs, ...raw };
        if (id === "tty")
          return {
            ReadStream: function () {
              return socket;
            },
          };
        if (id === "./linuxPtyEof") return { guardLinuxPtyEof: guard(raw) };
        if (id === "./utils") {
          return {
            assign: Object.assign,
            loadNativeModule: () => ({
              dir: "/native",
              module: {
                fork: (...args: unknown[]) => {
                  nativeExit = args[10] as typeof nativeExit;
                  return { fd: 42, pid: 123, pty: "/dev/pts/1" };
                },
              },
            }),
          };
        }
        return packageRequire(id);
      });
      const Pty = patched.UnixTerminal as new (
        file: string,
        args: string[],
        options: object,
      ) => {
        onData(listener: (data: string) => void): void;
        onExit(listener: (event: { exitCode: number }) => void): void;
      };
      const pty = new Pty("/bin/sh", [], { cwd: "/project", env: {} });
      const events: Array<string | number> = [];
      pty.onData((data) => events.push(data));
      const exited = new Promise<void>((done) => {
        pty.onExit(({ exitCode }) => {
          events.push(exitCode);
          done();
        });
      });
      socket.push(Buffer.from("echo bye-$((4+4)); exit 3\r\n"));
      if (order === "native exit first") nativeExit?.(3, 0);
      socket.push(null); // libuv's false EOF; the kernel tail is still readable.
      if (order === "EOF first") nativeExit?.(3, 0);
      await exited;
      expect(events).toEqual(["echo bye-$((4+4)); exit 3\r\n", "bye-8\r\n", 3]);
      expect(raw.readSync).toHaveBeenCalledWith(42, expect.any(Buffer), 0, 65536, null);
    },
  );

  it("preserves a UTF-8 character split across the last libuv read and the raw tail", async () => {
    const socket = stream();
    socket.setEncoding("utf8");
    const emoji = Buffer.from("😀");
    const raw = kernel(emoji.subarray(2), errno("EIO"));
    guard(raw)(socket, 42);
    const data: string[] = [];
    socket.on("data", (chunk: string) => data.push(chunk));
    socket.push(emoji.subarray(0, 2));
    socket.push(null);
    await tick();
    expect(data.join("")).toBe("😀");
  });

  it("copies raw chunks retained by a paused stream instead of reusing its read buffer", () => {
    const socket = stream();
    const raw = kernel(Buffer.from("first"), Buffer.from("second"));
    guard(raw)(socket, 42);
    socket.push(null);
    expect(socket.read()?.toString()).toBe("firstsecond");
  });

  it.each(["EAGAIN", "EWOULDBLOCK"])(
    "retries %s without flushing EOF or the decoder early",
    async (code) => {
      vi.useFakeTimers();
      const socket = stream();
      const raw = kernel(errno(code), Buffer.from("tail"), errno("EIO"));
      guard(raw)(socket, 42);
      const data: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => data.push(chunk));
      socket.push(null);
      socket.push(null);
      expect(raw.readSync).toHaveBeenCalledTimes(1);
      expect(socket.readableEnded).toBe(false);
      await vi.runAllTimersAsync();
      expect(Buffer.concat(data).toString()).toBe("tail");
      expect(raw.readSync).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a fd that never reaches EOF", async () => {
    vi.useFakeTimers();
    const socket = stream();
    const raw = kernel();
    raw.readSync.mockImplementation(() => {
      throw errno("EAGAIN");
    });
    guard(raw)(socket, 42);
    socket.resume();
    socket.push(null);
    await vi.runAllTimersAsync();
    expect(socket.readableEnded).toBe(true);
    expect(raw.readSync).toHaveBeenCalledTimes(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds bytes from a descendant that keeps writing after hangup", () => {
    const socket = stream();
    const raw = kernel();
    raw.readSync.mockImplementation((_fd, buffer, offset, length) => {
      buffer.fill("x", offset, offset + length);
      return length;
    });
    guard(raw)(socket, 42);
    socket.push(null);
    expect(raw.readSync).toHaveBeenCalledTimes(16);
    expect((socket.read() as Buffer).length).toBe(1024 * 1024);
  });

  it("counts ordinary libuv data against the post-exit byte bound, even if a descendant keeps writing", async () => {
    const socket = stream();
    const raw = kernel();
    const onExit = guard(raw)(socket, 42);
    const data: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      data.push(chunk);
      socket.pause();
    });
    onExit();
    for (let i = 0; i < 32; i++) socket.push(Buffer.alloc(65536, "x"));
    await tick();
    expect(Buffer.concat(data).length).toBe(1024 * 1024);
    expect(socket.readableEnded).toBe(true);
    expect(raw.readSync).not.toHaveBeenCalled();
  });

  it("does not extend the native-exit watchdog when EOF arrives later", async () => {
    vi.useFakeTimers();
    const socket = stream();
    const raw = kernel();
    raw.readSync.mockImplementation(() => {
      throw errno("EAGAIN");
    });
    const onExit = guard(raw)(socket, 42);
    onExit();
    await vi.advanceTimersByTimeAsync(150);
    socket.push(null);
    await vi.advanceTimersByTimeAsync(49);
    expect(socket.readableEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.readableEnded).toBe(true);
    expect(raw.readSync.mock.calls.length).toBeLessThanOrEqual(51);
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels retries on explicit destruction and never reads a closed/reused fd", async () => {
    vi.useFakeTimers();
    const socket = stream();
    const raw = kernel(errno("EAGAIN"));
    guard(raw)(socket, 42);
    socket.push(null);
    socket.destroy();
    await vi.runAllTimersAsync();
    expect(raw.readSync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps backpressure while running, but resumes and drains it at native process death", async () => {
    const socket = stream();
    const pause = vi.spyOn(socket, "pause");
    const raw = kernel(Buffer.from("tail"), errno("EIO"));
    const onExit = guard(raw)(socket, 42);
    socket.pause();
    const data: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      data.push(chunk);
      socket.pause();
    });
    onExit();
    socket.push(null);
    await tick();
    expect(Buffer.concat(data).toString()).toBe("tail");
    expect(socket.readableEnded).toBe(true);
    expect(pause).toHaveBeenCalledOnce();
  });

  it("retries EINTR in bounded turns and surfaces unexpected read errors", async () => {
    vi.useFakeTimers();
    const socket = stream();
    const raw = kernel(...Array.from({ length: 33 }, () => errno("EINTR")), errno("EBADF"));
    const errors: Error[] = [];
    socket.on("error", (error: Error) => errors.push(error));
    guard(raw)(socket, 42);
    socket.push(null);
    await vi.runAllTimersAsync();
    expect(raw.readSync).toHaveBeenCalledTimes(34);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("EBADF");
    expect(socket.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
