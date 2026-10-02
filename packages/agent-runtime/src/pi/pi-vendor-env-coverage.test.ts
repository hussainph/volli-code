import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "./vendor/pi-harness/context";
import { applyShellOutputUpdate } from "./vendor/pi-harness/execution/output-capture";
import type { NodeExecutionEnv } from "./vendor/pi-harness/env/nodejs";
import {
  type FileError,
  getOrThrow,
  type Result,
  type ShellExecOptions,
  type ShellOutputView,
} from "./vendor/pi-harness/types";

const context = BACKGROUND_CONTEXT;
const scratchRoot = resolve(process.cwd(), "../../.bench-tmp/pi-migration-vc496");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let scratch: string;
const environments: NodeExecutionEnv[] = [];

beforeEach(async () => {
  // Bash -c is noninteractive, but BASH_ENV can still load an ambient startup file.
  vi.stubEnv("BASH_ENV", undefined);
  vi.stubEnv("ENV", undefined);
  await fs.mkdir(scratchRoot, { recursive: true });
  scratch = await fs.mkdtemp(join(scratchRoot, "env-followup-"));
});
afterEach(async () => {
  for (const env of environments.splice(0)) await env.cleanup(context);
  Object.defineProperty(process, "platform", originalPlatform);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const module of ["node:fs/promises", "node:fs", "node:os", "node:child_process"])
    vi.doUnmock(module);
  vi.resetModules();
  await fs.rm(scratch, { recursive: true, force: true });
});

// Each import owns its mock graph. Neither platform selection nor failure injection
// can leak into the authority/scoped-environment suites that also use this vendor.
async function environment(
  options: {
    files?: Record<string, unknown>;
    streams?: Record<string, unknown>;
    spawn?: (...args: unknown[]) => ChildProcess;
    platform?: string;
    shellPath?: string;
    shellEnv?: NodeJS.ProcessEnv;
  } = {},
): Promise<NodeExecutionEnv> {
  for (const module of ["node:fs/promises", "node:fs", "node:os", "node:child_process"])
    vi.doUnmock(module);
  vi.resetModules();
  if (options.platform)
    Object.defineProperty(process, "platform", { ...originalPlatform, value: options.platform });
  vi.doMock("node:os", () => ({
    ...os,
    tmpdir: () => scratch,
    homedir: () => join(scratch, "home"),
  }));
  if (options.files) vi.doMock("node:fs/promises", () => ({ ...fs, ...options.files }));
  if (options.streams) vi.doMock("node:fs", () => ({ ...nodeFs, ...options.streams }));
  if (options.spawn) {
    if (!vi.isMockFunction(process.kill)) vi.spyOn(process, "kill").mockReturnValue(true);
    vi.doMock("node:child_process", () => ({ spawn: options.spawn }));
  }
  const { NodeExecutionEnv: Env } = await import("./vendor/pi-harness/env/nodejs");
  const env = new Env({ cwd: scratch, shellPath: options.shellPath, shellEnv: options.shellEnv });
  environments.push(env);
  return env;
}

function cancelled() {
  const controller = new AbortController();
  controller.abort();
  return withAbortSignal(controller.signal, context);
}
function nodeError(code: string, path?: unknown): Error {
  return Object.assign(new Error(`fixture ${code}`), { code, path });
}
function failure(result: Result<unknown, Error>, code: string, path?: string) {
  expect(result).toMatchObject({
    ok: false,
    error: {
      name: expect.stringMatching(/^(File|Execution)Error$/),
      code,
      ...(path === undefined ? {} : { path }),
    },
  });
  if (result.ok) throw new Error("Expected a typed failure");
  return result.error;
}
function collected(options: ShellExecOptions = {}) {
  let view: ShellOutputView | undefined;
  const execOptions: ShellExecOptions = {
    ...options,
    onUpdate: (update) => {
      view = applyShellOutputUpdate(view, update);
    },
  };
  return { options: execOptions, text: () => view?.text ?? "" };
}

// A detached process model, not a host PID. Every kill in injected-process tests
// is intercepted; only real children started by this test are ever signalled.
function child(...args: [pid?: number]) {
  const pid = args.length === 0 ? 424242 : args[0];
  const process = new EventEmitter() as ChildProcess & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  Object.assign(process, {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return process;
}
function complete(
  process: ChildProcess,
  code: number | null = 0,
  signal: NodeJS.Signals | null = null,
) {
  process.stdout?.emit("end");
  process.stderr?.emit("end");
  process.emit("exit", code, signal);
  process.emit("close", code, signal);
}
async function launched(spawn: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled(), { timeout: 1000, interval: 1 });
}

describe("vendored Node filesystem contract", () => {
  it("normalizes relative, file URL, home and Windows home paths without touching profiles", async () => {
    const env = await environment({ platform: "win32" });
    for (const [path, expected] of [
      ["a/../file.txt", join(scratch, "file.txt")],
      [join(scratch, "absolute.txt"), join(scratch, "absolute.txt")],
      [pathToFileURL(join(scratch, "space 文.txt")).href, join(scratch, "space 文.txt")],
      ["~", join(scratch, "home")],
      ["~/child", join(scratch, "home", "child")],
      ["~\\child", join(scratch, "home", "child")],
      ["file://%", resolve(scratch, "file://%")],
    ])
      expect(getOrThrow(await env.absolutePath(path!, context))).toBe(expected);
    expect(getOrThrow(await env.joinPath(["one", "two", "..", "three"], context))).toBe(
      join("one", "three"),
    );
  });

  it("creates parents, preserves binary/UTF-8 bytes, appends, renames and reports symlinks explicitly", async () => {
    const env = await environment();
    expect(await env.writeFile("nested/file", "文😀\r\n", context)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await env.appendFile("nested/file", new Uint8Array([0x61, 0x0a]), context)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(getOrThrow(await env.readTextFile("nested/file", context))).toBe("文😀\r\na\n");
    expect([...getOrThrow(await env.readBinaryFile("nested/file", context))]).toEqual([
      ...Buffer.from("文😀\r\na\n"),
    ]);
    expect(await env.appendFile("other/new", "first", context)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await env.renameFile("nested/file", "nested/renamed", context)).toEqual({
      ok: true,
      value: undefined,
    });
    await fs.symlink(join(scratch, "nested/renamed"), join(scratch, "alias"));
    expect(getOrThrow(await env.fileInfo("alias", context))).toMatchObject({
      kind: "symlink",
      name: "alias",
      path: join(scratch, "alias"),
    });
    expect(getOrThrow(await env.canonicalPath("alias", context))).toBe(
      await fs.realpath(join(scratch, "nested/renamed")),
    );
    expect(getOrThrow(await env.fileInfo("nested/renamed", context))).toMatchObject({
      kind: "file",
      size: 11,
      mtimeMs: expect.any(Number),
    });
    expect(getOrThrow(await env.fileInfo("nested", context)).kind).toBe("directory");
    expect(
      getOrThrow(await env.listDir(".", context))
        .map(({ name, kind }) => [name, kind])
        .toSorted(),
    ).toEqual([
      ["alias", "symlink"],
      ["nested", "directory"],
      ["other", "directory"],
    ]);
    expect(await env.exists("nested/file", context)).toEqual({ ok: true, value: false });
    expect(await env.exists("alias", context)).toEqual({ ok: true, value: true });
    expect(await env.createDir("deep/child", undefined, context)).toEqual({
      ok: true,
      value: undefined,
    });
    failure(await env.createDir("missing/child", { recursive: false }, context), "not_found");
    expect(await env.createDir("single", { recursive: false }, context)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await env.remove("nested/renamed", undefined, context)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await env.remove("deep", { recursive: true, force: true }, context)).toEqual({
      ok: true,
      value: undefined,
    });
    failure(await env.remove("missing", undefined, context), "not_found");
  });

  it("preserves strict LF termination, CRs, empty lines and multibyte characters split at 64 KiB", async () => {
    const env = await environment();
    const long = "a".repeat(65535) + "😀";
    getOrThrow(await env.writeFile("lines", `${long}\n\r\n\nunterminated`, context));
    const reader = getOrThrow(await env.openTextLineReader("lines", context));
    for (const value of [
      { text: long, terminated: true },
      { text: "\r", terminated: true },
      { text: "", terminated: true },
      { text: "unterminated", terminated: false },
      undefined,
      undefined,
    ]) {
      expect(await reader.readLine(context)).toEqual({ ok: true, value });
    }
    await reader.close(context);
    await reader.close(context);
    failure(await reader.readLine(context), "invalid", join(scratch, "lines"));
    expect(getOrThrow(await env.readTextLines("lines", { maxLines: 2 }, context))).toEqual([
      long,
      "\r",
    ]);
    expect(getOrThrow(await env.readTextLines("lines", undefined, context))).toEqual([
      long,
      "\r",
      "",
      "unterminated",
    ]);
    expect(await env.readTextLines("missing", { maxLines: 0 }, context)).toEqual({
      ok: true,
      value: [],
    });
    getOrThrow(await env.writeFile("empty", "", context));
    expect(await env.readTextLines("empty", {}, context)).toEqual({ ok: true, value: [] });
    getOrThrow(await env.writeFile("torn-utf8", new Uint8Array([0xf0, 0x9f]), context));
    expect(await env.readTextLines("torn-utf8", undefined, context)).toEqual({
      ok: true,
      value: ["�"],
    });
  });

  it("returns missing and wrong-kind failures instead of rejecting", async () => {
    const env = await environment();
    for (const result of [
      await env.readTextFile("missing", context),
      await env.readBinaryFile("missing", context),
      await env.openTextLineReader("missing", context),
      await env.readTextLines("missing", undefined, context),
      await env.fileInfo("missing", context),
      await env.listDir("missing", context),
      await env.canonicalPath("missing", context),
      await env.renameFile("missing", "destination", context),
    ])
      failure(result, "not_found", join(scratch, "missing"));
    getOrThrow(await env.writeFile("file", "data", context));
    failure(await env.listDir("file", context), "not_directory", join(scratch, "file"));
    failure(await env.readTextFile(".", context), "is_directory", scratch);
    failure(await env.writeFile("file/child", "no", context), "unknown"); // mkdir's EEXIST is intentionally not an authority failure.
  });

  it("does not mutate, open or remove anything under a pre-aborted context", async () => {
    const env = await environment();
    getOrThrow(await env.writeFile("keep", "unchanged", context));
    const stopped = cancelled();
    for (const result of [
      await env.openTextLineReader("keep", stopped),
      await env.readTextFile("keep", stopped),
      await env.readBinaryFile("keep", stopped),
      await env.writeFile("keep", "changed", stopped),
      await env.appendFile("keep", "changed", stopped),
      await env.renameFile("keep", "renamed", stopped),
      await env.fileInfo("keep", stopped),
      await env.listDir(".", stopped),
      await env.canonicalPath("keep", stopped),
      await env.exists("keep", stopped),
      await env.createDir("new", undefined, stopped),
      await env.remove("keep", undefined, stopped),
      await env.createTempDir(undefined, stopped),
      await env.createTempFile(undefined, stopped),
    ])
      failure(result, "aborted");
    const reader = getOrThrow(await env.openTextLineReader("keep", context));
    failure(await reader.readLine(stopped), "aborted");
    expect(await reader.readLine(context)).toEqual({
      ok: true,
      value: { text: "unchanged", terminated: false },
    });
    await reader.close(stopped);
    expect(await fs.readdir(scratch)).toEqual(["keep"]);
    expect(await fs.readFile(join(scratch, "keep"), "utf8")).toBe("unchanged");
  });

  it.each([
    ["ABORT_ERR", "aborted"],
    ["EACCES", "permission_denied"],
    ["EPERM", "permission_denied"],
    ["ENOENT", "not_found"],
    ["ENOTDIR", "not_directory"],
    ["EISDIR", "is_directory"],
    ["EINVAL", "invalid"],
    ["EIO", "unknown"],
  ])("maps %s to stable %s with addressed path and original cause", async (nodeCode, code) => {
    const cause = nodeError(nodeCode, join(scratch, "reported-path"));
    const env = await environment({ files: { readFile: vi.fn().mockRejectedValue(cause) } });
    const error = failure(
      await env.readTextFile("requested-path", context),
      code,
      join(scratch, "reported-path"),
    );
    expect(error.cause).toBe(cause);
  });

  it("preserves an existing FileError and handles non-Node failures and non-string paths", async () => {
    const readFile = vi.fn();
    const env = await environment({ files: { readFile } });
    const { FileError: LoadedFileError } = await import("./vendor/pi-harness/types");
    const typed = new LoadedFileError("permission_denied", "authority refusal", "typed-path");
    readFile
      .mockRejectedValueOnce(typed)
      .mockRejectedValueOnce("backend failed")
      .mockRejectedValueOnce(nodeError("EACCES", 42));
    expect(failure(await env.readTextFile("first", context), "permission_denied")).toBe(typed);
    expect(
      failure(await env.readBinaryFile("second", context), "unknown", join(scratch, "second"))
        .cause,
    ).toEqual(new Error("backend failed"));
    failure(await env.readTextFile("third", context), "permission_denied", join(scratch, "third"));
  });

  it("encodes each filesystem backend failure and does not hide non-missing exists failures", async () => {
    const io = nodeError("EIO");
    const env = await environment({
      files: Object.fromEntries(
        [
          "writeFile",
          "appendFile",
          "rename",
          "lstat",
          "readdir",
          "realpath",
          "mkdir",
          "rm",
          "mkdtemp",
        ].map((name) => [name, vi.fn().mockRejectedValue(io)]),
      ),
    });
    for (const result of [
      await env.writeFile("f", "x", context),
      await env.appendFile("f", "x", context),
      await env.renameFile("f", "g", context),
      await env.fileInfo("f", context),
      await env.listDir(".", context),
      await env.canonicalPath("f", context),
      await env.exists("f", context),
      await env.createDir("f", {}, context),
      await env.remove("f", {}, context),
      await env.createTempDir("prefix-", context),
      await env.createTempFile({}, context),
    ]) {
      expect(failure(result, "unknown").cause).toBe(io);
    }
  });

  it("checks cancellation after parent creation and after append without losing the committed bytes", async () => {
    const controller = new AbortController();
    const stopped = withAbortSignal(controller.signal, context);
    const mkdir = vi.fn(async () => {
      controller.abort();
    });
    const env = await environment({ files: { mkdir } });
    failure(await env.writeFile("write", "no", stopped), "aborted");
    const other = new AbortController();
    mkdir.mockImplementation(async () => {
      other.abort();
    });
    failure(
      await env.appendFile("append", "no", withAbortSignal(other.signal, context)),
      "aborted",
    );
    expect(await fs.readdir(scratch)).toEqual([]);
    const appended = new AbortController();
    const appendEnv = await environment({
      files: {
        mkdir: fs.mkdir,
        appendFile: async (path: string, content: string) => {
          await fs.appendFile(path, content);
          appended.abort();
        },
      },
    });
    failure(
      await appendEnv.appendFile("committed", "saved", withAbortSignal(appended.signal, context)),
      "aborted",
    );
    expect(await fs.readFile(join(scratch, "committed"), "utf8")).toBe("saved");
  });

  it("closes an opened handle after cancellation, even if close itself fails", async () => {
    const controller = new AbortController();
    let closed = false;
    const env = await environment({
      files: {
        open: async () => {
          controller.abort();
          return {
            close: async () => {
              closed = true;
              throw new Error("already closed");
            },
          };
        },
      },
    });
    failure(
      await env.openTextLineReader("f", withAbortSignal(controller.signal, context)),
      "aborted",
      join(scratch, "f"),
    );
    expect(closed).toBe(true);
  });

  it("retries an aborted line read at the same byte position and tolerates close failures", async () => {
    const controller = new AbortController();
    const positions: number[] = [];
    const handle = {
      read: async (buffer: Uint8Array, _offset: number, _length: number, position: number) => {
        positions.push(position);
        if (positions.length === 1) controller.abort();
        buffer.set(Buffer.from("saved\n"));
        return { bytesRead: 6 };
      },
      close: async () => {
        throw new Error("close failed");
      },
    };
    const env = await environment({ files: { open: async () => handle } });
    const reader = getOrThrow(await env.openTextLineReader("f", context));
    failure(await reader.readLine(withAbortSignal(controller.signal, context)), "aborted");
    expect(await reader.readLine(context)).toEqual({
      ok: true,
      value: { text: "saved", terminated: true },
    });
    expect(positions).toEqual([0, 0]);
    await expect(reader.close(context)).resolves.toBeUndefined();
    await expect(reader.close(context)).resolves.toBeUndefined();
  });

  it("returns reader I/O failures and always closes readTextLines' handle", async () => {
    const io = nodeError("EIO");
    let closed = false;
    const env = await environment({
      files: {
        open: async () => ({
          read: async () => {
            throw io;
          },
          close: async () => {
            closed = true;
          },
        }),
      },
    });
    expect(
      failure(await env.readTextLines("f", {}, context), "unknown", join(scratch, "f")).cause,
    ).toBe(io);
    expect(closed).toBe(true);
  });

  it("rejects unsupported stat kinds, skips them in listings, and reports raced-away entries", async () => {
    const unsupported = {
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      size: 0,
      mtimeMs: 0,
    };
    const lstat = vi.fn().mockResolvedValue(unsupported);
    const env = await environment({ files: { lstat, readdir: async () => [{ name: "socket" }] } });
    failure(await env.fileInfo("socket", context), "invalid", join(scratch, "socket"));
    expect(await env.listDir(".", context)).toEqual({ ok: true, value: [] });
    lstat.mockRejectedValue(nodeError("ENOENT"));
    failure(await env.listDir(".", context), "not_found", join(scratch, "socket"));
  });

  it("stops listing if cancellation arrives while directory entries are being read", async () => {
    const controller = new AbortController();
    const env = await environment({
      files: {
        readdir: async () => {
          controller.abort();
          return [{ name: "unvisited" }];
        },
      },
    });
    failure(
      await env.listDir(".", withAbortSignal(controller.signal, context)),
      "aborted",
      scratch,
    );
  });

  it("creates unique empty temporary files with optional names entirely inside the test workspace", async () => {
    const env = await environment();
    const defaultDir = getOrThrow(await env.createTempDir(undefined, context));
    const namedDir = getOrThrow(await env.createTempDir("custom-", context));
    expect(defaultDir).toMatch(new RegExp(`${scratch}/tmp-`));
    expect(namedDir).toMatch(new RegExp(`${scratch}/custom-`));
    for (const options of [undefined, { prefix: "prefix-", suffix: ".log" }]) {
      const file = getOrThrow(await env.createTempFile(options, context));
      expect(dirname(file).startsWith(join(scratch, "tmp-"))).toBe(true);
      expect(await fs.readFile(file, "utf8")).toBe("");
      if (options) expect(file).toMatch(/\/prefix-[^/]+\.log$/);
    }
  });

  it("returns temp-file creation errors with the exact attempted filename", async () => {
    const env = await environment({
      files: {
        writeFile: async () => {
          throw nodeError("EACCES");
        },
      },
    });
    const result = await env.createTempFile({ prefix: "denied-", suffix: ".log" }, context);
    const error = failure(result, "permission_denied") as FileError;
    expect(error.path).toMatch(/\/tmp-[^/]+\/denied-[^/]+\.log$/);
  });
});

describe("vendored Node shell contract", () => {
  it("uses caller cwd, explicit environment and nonzero exit codes without reading shell profiles", async () => {
    const env = await environment({
      shellPath: "/bin/bash",
      shellEnv: { PI_TEST_BASE: "base", PI_TEST_OVERRIDE: "base" },
    });
    vi.stubEnv("PI_TEST_HOST", "host");
    await fs.mkdir(join(scratch, "child"));
    const inherited = collected({ cwd: "child", env: { PI_TEST_OVERRIDE: "caller" } });
    expect(
      getOrThrow(
        await env.exec(
          'printf "%s|%s|%s|%s" "$PI_TEST_HOST" "$PI_TEST_BASE" "$PI_TEST_OVERRIDE" "$PWD"; exit 7',
          inherited.options,
          context,
        ),
      ).exitCode,
    ).toBe(7);
    expect(inherited.text()).toBe(`host|base|caller|${scratch}/child`);
    const explicit = collected({ inheritEnv: false, env: { PI_TEST_OVERRIDE: "only" } });
    getOrThrow(
      await env.exec(
        'printf "%s|%s|%s" "$PI_TEST_HOST" "$PI_TEST_BASE" "$PI_TEST_OVERRIDE"',
        explicit.options,
        context,
      ),
    );
    expect(explicit.text()).toBe("||only");
    vi.unstubAllEnvs();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2147483.648])(
    "rejects invalid timeout %s before starting a child",
    async (timeout) => {
      const env = await environment();
      failure(await env.exec("touch should-not-exist", { timeout }, context), "timeout");
      expect(await fs.readdir(scratch)).toEqual([]);
    },
  );

  it("returns unavailable-shell, missing-cwd and pre-aborted failures without spawning", async () => {
    const env = await environment({ shellPath: join(scratch, "missing-shell") });
    failure(await env.exec("true", undefined, context), "shell_unavailable");
    failure(await env.exec("true", undefined, cancelled()), "aborted");
    const valid = await environment({ shellPath: "/bin/bash" });
    const error = failure(await valid.exec("true", { cwd: "missing" }, context), "spawn_error");
    expect(error.message).toContain(join(scratch, "missing"));
    expect(error.cause).toBeInstanceOf(Error);
    failure(
      await valid.exec("true", { capture: { limits: { maxBytes: 0, maxLines: 1 } } }, context),
      "unknown",
    );
  });

  it("kills a real sleeping process on timeout and removes it from cleanup's active set", async () => {
    const env = await environment({ shellPath: "/bin/bash" });
    const result = await env.exec(
      "printf started; exec /bin/sleep 30",
      { timeout: 0.02, inheritEnv: false },
      context,
    );
    failure(result, "timeout");
    const kill = vi.spyOn(process, "kill");
    await env.cleanup(context);
    expect(kill).not.toHaveBeenCalled();
  });

  it("cancels a running process and reports callback failures ahead of cancellation", async () => {
    const env = await environment({ shellPath: "/bin/bash" });
    const controller = new AbortController();
    failure(
      await env.exec(
        "printf ready; exec /bin/sleep 30",
        { onUpdate: () => controller.abort(), inheritEnv: false },
        withAbortSignal(controller.signal, context),
      ),
      "aborted",
    );
    const cause = new Error("consumer rejected progress");
    const result = await env.exec(
      "printf ready; exec /bin/sleep 30",
      {
        onUpdate: () => {
          throw cause;
        },
        inheritEnv: false,
      },
      context,
    );
    expect(failure(result, "callback_error").cause).toBe(cause);
  });

  it("cleanup kills only its active child and is idempotent", async () => {
    const env = await environment({ shellPath: "/bin/bash" });
    const capture = collected({ inheritEnv: false, onUpdate: undefined });
    let ready!: () => void;
    const started = new Promise<void>((resolveReady) => {
      ready = resolveReady;
    });
    const execution = env.exec(
      "printf ready; exec /bin/sleep 30",
      {
        ...capture.options,
        onUpdate: (update, current) => {
          capture.options.onUpdate!(update, current);
          ready();
        },
      },
      context,
    );
    await started;
    await env.cleanup(context);
    expect(getOrThrow(await execution).exitCode).toBe(137);
    expect(capture.text()).toBe("ready");
    const kill = vi.spyOn(process, "kill");
    await env.cleanup(context);
    expect(kill).not.toHaveBeenCalled();
  });

  it("preserves complete spilled output while bounding the published view", async () => {
    const env = await environment({
      shellPath: "/bin/bash",
      streams: {
        createWriteStream: (path: string, options: nodeFs.WriteStreamOptions) =>
          nodeFs.createWriteStream(path, { ...options, highWaterMark: 16 }),
      },
    });
    const capture = collected({
      capture: { spill: true, limits: { maxBytes: 16, maxLines: 2 } },
      inheritEnv: false,
    });
    const result = getOrThrow(
      await env.exec(
        "printf 'first\\n'; /bin/sleep 0.02; printf 'abcdefghijklmnopqrstuvwxyz\\n'; /bin/sleep 0.02; printf 'last\\n'",
        capture.options,
        context,
      ),
    );
    expect(result.truncation.truncated).toBe(true);
    expect(result.spillPath?.startsWith(scratch)).toBe(true);
    expect(await fs.readFile(result.spillPath!, "utf8")).toBe(
      "first\nabcdefghijklmnopqrstuvwxyz\nlast\n",
    );
    expect(capture.text()).toBe("last");
  });

  it("returns spawn exceptions and asynchronous process errors as spawn_error", async () => {
    const cause = new Error("spawn refused");
    const spawn = vi.fn<(...args: unknown[]) => ChildProcess>(() => {
      throw cause;
    });
    const env = await environment({ spawn, files: { access: async () => {} } });
    expect(failure(await env.exec("true", undefined, context), "spawn_error").cause).toBe(cause);
    const process = child(undefined);
    spawn.mockImplementation(() => process);
    const execution = env.exec("true", undefined, context);
    await launched(spawn);
    // The second spawn follows two asynchronous access checks.
    await vi.waitFor(() => expect(process.listenerCount("error")).toBe(1), { interval: 1 });
    process.emit("error", cause);
    expect(failure(await execution, "spawn_error").cause).toBe(cause);
    expect(process.listenerCount("exit")).toBe(0);
  });

  it("maps signalled exits and absent status to conventional failure codes", async () => {
    const processes = [child(), child(undefined), child()];
    const spawn = vi.fn(() => processes.shift()!);
    const env = await environment({ spawn, files: { access: async () => {} } });
    for (const [signal, expected] of [
      ["SIGTERM", 143],
      [null, 1],
      ["UNRECOGNIZED", 128],
    ] as const) {
      const execution = env.exec("true", undefined, context);
      await vi.waitFor(
        () => expect(spawn.mock.results.at(-1)?.value.listenerCount("exit")).toBe(1),
        { interval: 1 },
      );
      complete(spawn.mock.results.at(-1)!.value, null, signal as NodeJS.Signals | null);
      expect(getOrThrow(await execution).exitCode).toBe(expected);
    }
  });

  it("falls back to killing the single PID if the detached group is already gone", async () => {
    const processChild = child();
    const spawn = vi.fn(() => processChild);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("gone");
    });
    const env = await environment({ spawn, files: { access: async () => {} } });
    const controller = new AbortController();
    const execution = env.exec("true", undefined, withAbortSignal(controller.signal, context));
    await launched(spawn);
    controller.abort();
    expect(kill.mock.calls).toEqual([
      [-424242, "SIGKILL"],
      [424242, "SIGKILL"],
    ]);
    complete(processChild);
    failure(await execution, "aborted");
  });
});

function discovery(
  allowed: string[],
  lookup: { text?: string; status?: number | null; error?: Error; throws?: boolean } = {},
) {
  const spawn = vi.fn((...args: unknown[]) => {
    const processChild = child();
    if (args[0] === "which" || args[0] === "where") {
      if (lookup.throws) throw lookup.error;
      queueMicrotask(() => {
        if (lookup.error) processChild.emit("error", lookup.error);
        else {
          if (lookup.text !== undefined) processChild.stdout?.emit("data", lookup.text);
          processChild.emit("close", lookup.status === undefined ? 0 : lookup.status);
        }
      });
    } else {
      queueMicrotask(() => {
        processChild.stdout?.emit("data", Buffer.from("selected"));
        complete(processChild);
      });
    }
    return processChild;
  });
  const access = async (path: string) => {
    if (path !== scratch && !allowed.includes(path)) throw nodeError("ENOENT", path);
  };
  return { spawn, access };
}

describe("vendored Node shell discovery and platform transport", () => {
  it.each([
    { text: "/test/bash\n/other/bash\n", status: 0, allowed: ["/test/bash"], shell: "/test/bash" },
    { text: "/missing/bash\n", status: 0, allowed: [], shell: "sh" },
    { text: "", status: 0, allowed: [], shell: "sh" },
    { text: "\n", status: 0, allowed: [], shell: "sh" },
    { text: "/test/bash\n", status: 1, allowed: [], shell: "sh" },
    { text: "/test/bash\n", status: null, allowed: [], shell: "sh" },
  ])(
    "uses $shell for POSIX discovery result $text/$status",
    async ({ text, status, allowed, shell }) => {
      const { spawn, access } = discovery(allowed, { text, status });
      const env = await environment({ platform: "linux", spawn, files: { access } });
      const output = collected({ inheritEnv: false });
      expect(getOrThrow(await env.exec("fixture-command", output.options, context)).exitCode).toBe(
        0,
      );
      expect(output.text()).toBe("selected");
      expect(spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
        ["which", ["bash"]],
        [shell, ["-c", "fixture-command"]],
      ]);
    },
  );

  it.each([false, true])(
    "falls back to sh after lookup failure (synchronous=%s)",
    async (throws) => {
      const { spawn, access } = discovery([], { error: new Error("lookup failed"), throws });
      const env = await environment({ platform: "linux", spawn, files: { access } });
      expect(getOrThrow(await env.exec("true", { inheritEnv: false }, context)).exitCode).toBe(0);
      expect(spawn.mock.calls.at(-1)?.slice(0, 2)).toEqual(["sh", ["-c", "true"]]);
    },
  );

  it.each(["ProgramFiles", "ProgramFiles(x86)"])(
    "prefers installed Git Bash under %s",
    async (variable) => {
      vi.stubEnv("ProgramFiles", "C:\\Programs");
      vi.stubEnv("ProgramFiles(x86)", "C:\\Programs-x86");
      const shell = `${process.env[variable]}\\Git\\bin\\bash.exe`;
      const { spawn, access } = discovery([shell]);
      const env = await environment({ platform: "win32", spawn, files: { access } });
      const output = collected({ inheritEnv: false });
      getOrThrow(await env.exec("git-bash-command", output.options, context));
      expect(output.text()).toBe("selected");
      expect(spawn.mock.calls).toEqual([
        [
          shell,
          ["-c", "git-bash-command"],
          expect.objectContaining({
            detached: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: {},
          }),
        ],
      ]);
    },
  );

  it("uses where's first existing bash when no Git installation is configured", async () => {
    vi.stubEnv("ProgramFiles", undefined);
    vi.stubEnv("ProgramFiles(x86)", undefined);
    const { spawn, access } = discovery(["C:\\MSYS\\bash.exe"], {
      text: "C:\\MSYS\\bash.exe\r\nC:\\other\\bash.exe\r\n",
    });
    const env = await environment({ platform: "win32", spawn, files: { access } });
    expect(getOrThrow(await env.exec("true", { inheritEnv: false }, context)).exitCode).toBe(0);
    expect(spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["where", ["bash.exe"]],
      ["C:\\MSYS\\bash.exe", ["-c", "true"]],
    ]);
  });

  it("explains unavailable Windows shells including both searched installation paths", async () => {
    vi.stubEnv("ProgramFiles", "C:\\Programs");
    vi.stubEnv("ProgramFiles(x86)", "C:\\Programs-x86");
    const { spawn, access } = discovery([], { status: 1 });
    const env = await environment({ platform: "win32", spawn, files: { access } });
    const error = failure(await env.exec("true", undefined, context), "shell_unavailable");
    expect(error.message).toContain("C:\\Programs\\Git\\bin\\bash.exe");
    expect(error.message).toContain("C:\\Programs-x86\\Git\\bin\\bash.exe");
    expect(error.message).toContain("Configure an explicit shellPath");
    expect(spawn.mock.calls.map(([command]) => command)).toEqual(["where"]);
  });

  it.each(["C:\\Windows\\System32\\bash.exe", "c:/windows/sysnative/bash.exe"])(
    "transports legacy WSL commands on stdin for %s",
    async (shell) => {
      const processChild = child();
      const spawn = vi.fn(() => processChild);
      const env = await environment({
        platform: "win32",
        shellPath: shell,
        spawn,
        files: { access: async () => {} },
      });
      const execution = env.exec("printf 文", { inheritEnv: false }, context);
      await launched(spawn);
      expect(spawn).toHaveBeenCalledWith(
        shell,
        ["-s"],
        expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
      );
      expect(processChild.stdin?.read()?.toString()).toBe("printf 文");
      // A shell may close its command pipe before the parent finishes writing.
      expect(() => processChild.stdin?.emit("error", nodeError("EPIPE"))).not.toThrow();
      complete(processChild);
      expect(getOrThrow(await execution).exitCode).toBe(0);
    },
  );

  it.each([undefined, "D:\\Windows"])(
    "uses taskkill with SystemRoot=%s and consumes asynchronous launch errors",
    async (root) => {
      vi.stubEnv("SystemRoot", root);
      const processChild = child();
      const taskkill = child(undefined);
      const spawn = vi.fn((...args: unknown[]) =>
        args[0] === "/fixture/bash" ? processChild : taskkill,
      );
      const env = await environment({
        platform: "win32",
        shellPath: "/fixture/bash",
        spawn,
        files: { access: async () => {} },
      });
      const controller = new AbortController();
      const execution = env.exec("true", undefined, withAbortSignal(controller.signal, context));
      await launched(spawn);
      controller.abort();
      expect(spawn).toHaveBeenLastCalledWith(
        join(root ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", "424242"],
        { stdio: "ignore", detached: true, windowsHide: true },
      );
      expect(() => taskkill.emit("error", new Error("taskkill unavailable"))).not.toThrow();
      complete(processChild);
      failure(await execution, "aborted");
    },
  );

  it("tolerates a synchronous taskkill failure without turning abort into an uncaught error", async () => {
    const processChild = child();
    const spawn = vi.fn((...args: unknown[]) => {
      if (args[0] !== "/fixture/bash") throw new Error("taskkill unavailable");
      return processChild;
    });
    const env = await environment({
      platform: "win32",
      shellPath: "/fixture/bash",
      spawn,
      files: { access: async () => {} },
    });
    const controller = new AbortController();
    const execution = env.exec("true", undefined, withAbortSignal(controller.signal, context));
    await launched(spawn);
    controller.abort();
    complete(processChild);
    failure(await execution, "aborted");
  });

  it.each([424242, undefined])("bounds a hung shell lookup (pid=%s)", async (pid) => {
    vi.useFakeTimers();
    const lookup = child(pid);
    const selected = child();
    const spawn = vi.fn((...args: unknown[]) => (args[0] === "which" ? lookup : selected));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const env = await environment({
      platform: "linux",
      spawn,
      files: {
        access: async (path: string) => {
          if (path === "/bin/bash") throw nodeError("ENOENT");
        },
      },
    });
    const execution = env.exec("true", { inheritEnv: false }, context);
    await launched(spawn);
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill.mock.calls).toEqual(pid === undefined ? [] : [[-pid, "SIGKILL"]]);
    lookup.emit("close", null);
    await vi.waitFor(() => expect(selected.listenerCount("exit")).toBe(1), { interval: 1 });
    complete(selected);
    expect(getOrThrow(await execution).exitCode).toBe(0);
    expect(spawn.mock.calls.at(-1)?.slice(0, 2)).toEqual(["sh", ["-c", "true"]]);
  });
});

describe("vendored Node process/stdio lifecycle", () => {
  it("finishes an empty successful process without fabricating output metadata", async () => {
    const env = await environment({ shellPath: "/bin/bash" });
    const result = getOrThrow(await env.exec("true", undefined, context));
    expect(result.exitCode).toBe(0);
    expect(result).not.toHaveProperty("spillPath");
    expect(result).not.toHaveProperty("lastLineBytes");
  });

  it("finishes on close even when exit/end events were not observed", async () => {
    const processChild = child(undefined);
    Object.assign(processChild, { stdout: null, stderr: null });
    const spawn = vi.fn(() => processChild);
    const env = await environment({ spawn, files: { access: async () => {} } });
    const execution = env.exec("true", undefined, context);
    await launched(spawn);
    processChild.emit("close", 2, null);
    expect(getOrThrow(await execution).exitCode).toBe(2);
    expect(processChild.listenerCount("error")).toBe(0);
    expect(processChild.listenerCount("exit")).toBe(0);
  });

  it("allows inherited pipes to drain after shell exit and finalizes once both end", async () => {
    const processChild = child();
    const spawn = vi.fn(() => processChild);
    const env = await environment({ spawn, files: { access: async () => {} } });
    const capture = collected();
    const execution = env.exec("true", capture.options, context);
    await launched(spawn);
    processChild.emit("exit", 0, null);
    processChild.stdout?.emit("data", Buffer.from("late stdout"));
    processChild.stdout?.emit("end");
    processChild.stderr?.emit("data", Buffer.from(" + late stderr"));
    processChild.stderr?.emit("end");
    expect(getOrThrow(await execution).exitCode).toBe(0);
    expect(capture.text()).toBe("late stdout + late stderr");
    expect(processChild.stdout?.destroyed).toBe(true);
    expect(processChild.stderr?.destroyed).toBe(true);
  });

  it("resets the post-exit grace period on late data and destroys pipes that never close", async () => {
    vi.useFakeTimers();
    const processChild = child();
    const spawn = vi.fn(() => processChild);
    const env = await environment({ spawn, files: { access: async () => {} } });
    const capture = collected();
    const execution = env.exec("true", capture.options, context);
    await launched(spawn);
    let done = false;
    void execution.then(() => {
      done = true;
    });
    processChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(90);
    processChild.stdout?.emit("data", Buffer.from("last inherited output"));
    await vi.advanceTimersByTimeAsync(90);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(getOrThrow(await execution).exitCode).toBe(0);
    expect(capture.text()).toBe("last inherited output");
    expect(processChild.stdout?.destroyed).toBe(true);
  });

  it("handles abort racing shell discovery and does not attach a stale abort listener", async () => {
    const controller = new AbortController();
    const processChild = child();
    const spawn = vi.fn(() => processChild);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const env = await environment({
      spawn,
      files: {
        access: async (path: string) => {
          if (path === scratch) controller.abort();
        },
      },
    });
    const execution = env.exec("true", undefined, withAbortSignal(controller.signal, context));
    await launched(spawn);
    expect(kill).toHaveBeenCalledWith(-424242, "SIGKILL");
    complete(processChild);
    failure(await execution, "aborted");
  });

  it("handles an error after exit but before pipe closure", async () => {
    const processChild = child();
    const spawn = vi.fn(() => processChild);
    const env = await environment({ spawn, files: { access: async () => {} } });
    const execution = env.exec("true", undefined, context);
    await launched(spawn);
    processChild.emit("exit", 0, null);
    const cause = new Error("stdio failed");
    processChild.emit("error", cause);
    expect(failure(await execution, "spawn_error").cause).toBe(cause);
    expect(processChild.listenerCount("close")).toBe(0);
  });

  it("returns a failure from the final progress flush without needing more output", async () => {
    const processChild = child();
    const spawn = vi.fn(() => processChild);
    vi.spyOn(process, "kill").mockReturnValue(true);
    const env = await environment({ spawn, files: { access: async () => {} } });
    const cause = new Error("final update failed");
    const execution = env.exec(
      "true",
      {
        onUpdate: () => {
          throw cause;
        },
      },
      context,
    );
    await launched(spawn);
    // An incomplete codepoint publishes nothing until capture.finish flushes the decoder.
    processChild.stdout.emit("data", new Uint8Array([0xf0, 0x9f]));
    complete(processChild);
    expect(failure(await execution, "callback_error").cause).toBe(cause);
  });

  it("keeps the first callback failure when already-buffered output triggers another, without inventing a PID", async () => {
    const processChild = child(undefined);
    const spawn = vi.fn(() => processChild);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const env = await environment({ spawn, files: { access: async () => {} } });
    let attempts = 0;
    const first = new Error("first callback failure");
    const execution = env.exec(
      "true",
      {
        onUpdate: () => {
          attempts++;
          throw attempts === 1 ? first : new Error("later callback failure");
        },
      },
      context,
    );
    await launched(spawn);
    processChild.stdout.emit("data", Buffer.from("first"));
    processChild.stdout.emit("data", new Uint8Array([0xf0, 0x9f]));
    complete(processChild);
    expect(failure(await execution, "callback_error").cause).toBe(first);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(kill).not.toHaveBeenCalled();
  });

  it("reports the byte size of a truncated, unterminated UTF-8 line", async () => {
    const env = await environment({ shellPath: "/bin/bash" });
    const capture = collected({
      capture: { limits: { maxBytes: 8, maxLines: 2 } },
      inheritEnv: false,
    });
    const result = getOrThrow(await env.exec("printf '0123456789文😀'", capture.options, context));
    expect(result.lastLineBytes).toBe(17);
    expect(result.truncation).toMatchObject({
      truncated: true,
      lastLinePartial: true,
      totalBytes: 17,
    });
    expect(capture.text()).toBe("9文😀");
  });
});

function deferred<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolveValue = resolvePromise;
  });
  return { promise, resolve: resolveValue };
}
async function spilling(options: Parameters<typeof environment>[0] = {}) {
  const processChild = child();
  const spawn = vi.fn(() => processChild);
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const env = await environment({
    ...options,
    spawn,
    files: { access: async () => {}, ...options.files },
  });
  const capture = collected({
    capture: { spill: true, limits: { maxBytes: 4, maxLines: 2 } },
    inheritEnv: false,
  });
  const execution = env.exec("fixture-output", capture.options, context);
  await launched(spawn);
  return { processChild, env, capture, execution, kill };
}

describe("vendored Node complete-output preservation", () => {
  it("surfaces temp-file creation failure rather than claiming a complete capture", async () => {
    const cause = nodeError("EACCES");
    const run = await spilling({
      files: {
        mkdtemp: async () => {
          throw cause;
        },
      },
    });
    run.processChild.stdout.emit("data", Buffer.from("long output"));
    await vi.waitFor(() => expect(run.kill).toHaveBeenCalledWith(-424242, "SIGKILL"), {
      interval: 1,
    });
    complete(run.processChild);
    const error = failure(await run.execution, "unknown");
    expect(error.message).toContain("Failed to preserve complete shell output: fixture EACCES");
    expect(error.cause).toMatchObject({ name: "FileError", code: "permission_denied", cause });
  });

  it("reports synchronous stream initialization failure and keeps the bounded view", async () => {
    const cause = new Error("stream initialization failed");
    const run = await spilling({
      streams: {
        createWriteStream: () => {
          throw cause;
        },
      },
    });
    run.processChild.stdout.emit("data", Buffer.from("long output"));
    await vi.waitFor(() => expect(run.kill).toHaveBeenCalled(), { interval: 1 });
    complete(run.processChild);
    expect(failure(await run.execution, "unknown").cause).toBe(cause);
    expect(run.capture.text()).toBe("tput");
  });

  it("keeps the first spill error while consuming follow-up stream errors", async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const run = await spilling({ streams: { createWriteStream: () => stream } });
    run.processChild.stdout.emit("data", Buffer.from("long output"));
    await vi.waitFor(() => expect(stream.listenerCount("error")).toBe(1), { interval: 1 });
    const cause = new Error("disk full");
    stream.emit("error", cause);
    stream.emit("error", new Error("secondary failure"));
    complete(run.processChild);
    expect(failure(await run.execution, "unknown").cause).toBe(cause);
    expect(run.kill.mock.calls).toEqual([[-424242, "SIGKILL"]]);
    stream.destroy();
  });

  it("waits through pending spill creation after process exit, then preserves all queued chunks", async () => {
    vi.useFakeTimers();
    const created = deferred<string>();
    const run = await spilling();
    const file = join(scratch, "delayed-output.log");
    await fs.writeFile(file, "");
    vi.spyOn(run.env, "createTempFile").mockImplementation(async () => ({
      ok: true,
      value: await created.promise,
    }));
    run.processChild.stdout.emit("data", Buffer.from("abc"));
    run.processChild.stdout.emit("data", Buffer.from("def"));
    run.processChild.stdout.emit("data", Buffer.from("ghi"));
    run.processChild.emit("exit", 0, null);
    let done = false;
    void run.execution.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(false);
    expect(run.processChild.stdout.destroyed).toBe(false);
    created.resolve(file);
    await vi.waitFor(() => expect(run.processChild.stdout.isPaused()).toBe(false), { interval: 1 });
    await vi.advanceTimersByTimeAsync(100);
    const result = getOrThrow(await run.execution);
    expect(result.spillPath).toBe(file);
    expect(await fs.readFile(file, "utf8")).toBe("abcdefghi");
    expect(run.capture.text()).toBe("fghi");
  });

  it("waits for backpressured output after shell exit rather than discarding accepted chunks", async () => {
    vi.useFakeTimers();
    const writes: Buffer[] = [];
    let release!: () => void;
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        writes.push(Buffer.from(chunk));
        release = () => callback();
      },
    });
    const run = await spilling({ streams: { createWriteStream: () => stream } });
    run.processChild.stdout.emit("data", Buffer.from("abcdef"));
    await vi.waitFor(() => expect(writes).toHaveLength(1), { interval: 1 });
    run.processChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(200);
    expect(run.processChild.stdout.destroyed).toBe(false);
    expect(run.processChild.stdout.isPaused()).toBe(true);
    release();
    await vi.waitFor(() => expect(run.processChild.stdout.isPaused()).toBe(false), { interval: 1 });
    await vi.advanceTimersByTimeAsync(100);
    expect(getOrThrow(await run.execution).exitCode).toBe(0);
    expect(Buffer.concat(writes).toString()).toBe("abcdef");
  });

  it("does not wait indefinitely for an already-destroyed spill stream", async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const run = await spilling({ streams: { createWriteStream: () => stream } });
    run.processChild.stdout.emit("data", Buffer.from("abcdef"));
    await vi.waitFor(() => expect(stream.listenerCount("error")).toBe(1), { interval: 1 });
    stream.destroy();
    complete(run.processChild);
    expect(getOrThrow(await run.execution).exitCode).toBe(0);
  });

  it("returns stream-finalization errors instead of hanging on the absent finish event", async () => {
    const cause = new Error("flush failed");
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        callback(cause);
      },
    });
    const run = await spilling({ streams: { createWriteStream: () => stream } });
    run.processChild.stdout.emit("data", Buffer.from("abcdef"));
    await vi.waitFor(() => expect(stream.listenerCount("error")).toBe(1), { interval: 1 });
    complete(run.processChild);
    expect(failure(await run.execution, "unknown").cause).toBe(cause);
  });

  it.each(["abort", "timeout", "callback_error"] as const)(
    "does not resume paused output after %s while spill creation completes",
    async (reason) => {
      vi.useFakeTimers();
      const created = deferred<string>();
      const processChild = child();
      const spawn = vi.fn(() => processChild);
      vi.spyOn(process, "kill").mockReturnValue(true);
      const controller = new AbortController();
      const env = await environment({ spawn, files: { access: async () => {} } });
      const file = join(scratch, "delayed-output.log");
      await fs.writeFile(file, "");
      vi.spyOn(env, "createTempFile").mockImplementation(async () => ({
        ok: true,
        value: await created.promise,
      }));
      let updates = 0;
      const execution = env.exec(
        "fixture-output",
        {
          capture: { spill: true, limits: { maxBytes: 4, maxLines: 2 } },
          ...(reason === "timeout" ? { timeout: 0.01 } : {}),
          onUpdate: () => {
            updates++;
            if (reason === "callback_error" && updates > 1) throw new Error("consumer failed");
          },
        },
        withAbortSignal(controller.signal, context),
      );
      await launched(spawn);
      processChild.stdout.emit("data", Buffer.from("abcdef"));
      if (reason === "abort") controller.abort();
      else if (reason === "timeout") await vi.advanceTimersByTimeAsync(10);
      else {
        await vi.advanceTimersByTimeAsync(100);
        processChild.stdout.emit("data", Buffer.from("ghi"));
      }
      created.resolve(file);
      await vi.waitFor(() => expect(updates).toBeGreaterThanOrEqual(2), { interval: 1 });
      expect(processChild.stdout.isPaused()).toBe(true);
      complete(processChild);
      failure(await execution, reason === "abort" ? "aborted" : reason);
    },
  );
});
