import { EventEmitter } from "node:events";
import type { SpawnOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it, vi } from "vite-plus/test";
import { ScopedExecutionEnv } from "./scoped-execution-env";

function roots() {
  const parent = mkdtempSync(join(tmpdir(), "volli-scoped-env-"));
  const worktree = join(parent, "worktree");
  const outside = join(parent, "outside.txt");
  mkdirSync(worktree);
  writeFileSync(join(worktree, "inside.txt"), "inside\n");
  writeFileSync(outside, "outside\n");
  return { worktree, outside };
}

function sandbox(overrides: Partial<Record<string, unknown>> = {}) {
  const calls = { checks: 0, initializes: 0, wraps: [] as unknown[], cleanups: 0 };
  let enabled = false;
  let config: SandboxRuntimeConfig | undefined;
  return {
    calls,
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => enabled,
    checkDependenciesAsync: async () => {
      calls.checks += 1;
      return { errors: [], warnings: [] };
    },
    initialize: async (next: SandboxRuntimeConfig) => {
      calls.initializes += 1;
      enabled = true;
      config = next;
    },
    getConfig: () => config,
    wrapWithSandboxArgv: async (...args: unknown[]) => {
      calls.wraps.push(args);
      return {
        argv: ["/usr/bin/true"],
        env: {
          PATH: "/Users/me/bin:/usr/bin:/bin",
          HOME: "/Users/me",
          GITHUB_TOKEN: "host-secret",
          BASH_ENV: "/tmp/hook",
          ENV: "/tmp/hook",
          NODE_OPTIONS: "--require=/tmp/hook",
          DYLD_INSERT_LIBRARIES: "/tmp/hook",
          LD_PRELOAD: "/tmp/hook",
          RUBYOPT: "-r/tmp/hook",
          PERL5OPT: "-M/tmp/hook",
          PYTHONPATH: "/tmp/hook",
          GIT_CONFIG_GLOBAL: "/tmp/hook",
        },
      };
    },
    cleanupAfterCommand: () => {
      calls.cleanups += 1;
    },
    ...overrides,
  };
}

function child() {
  const result = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  result.pid = 1234;
  result.stdout = new PassThrough();
  result.stderr = new PassThrough();
  result.kill = vi.fn();
  return result;
}

describe("ScopedExecutionEnv", () => {
  it("reads and writes ordinary files inside the Ticket worktree", async () => {
    const { worktree } = roots();
    const env = await ScopedExecutionEnv.create(worktree);

    expect(await env.absolutePath("inside.txt")).toEqual({
      ok: true,
      value: join(env.cwd, "inside.txt"),
    });
    expect(await env.exists("inside.txt")).toEqual({ ok: true, value: true });
    expect(await env.readTextFile("inside.txt")).toEqual({ ok: true, value: "inside\n" });
    expect(await env.readBinaryFile("inside.txt")).toMatchObject({ ok: true });
    expect(await env.fileInfo("inside.txt")).toMatchObject({
      ok: true,
      value: { kind: "file", path: join(env.cwd, "inside.txt") },
    });
    expect(await env.writeFile("written.txt", "written\n")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(readFileSync(join(worktree, "written.txt"), "utf8")).toBe("written\n");
    await env.cleanup();
  });

  it("rejects absolute, parent-relative, symlink, and aborted paths", async () => {
    const { worktree, outside } = roots();
    symlinkSync(outside, join(worktree, "escape-link"));
    const env = await ScopedExecutionEnv.create(worktree);

    for (const result of [
      await env.readTextFile(outside),
      await env.readBinaryFile(outside),
      await env.fileInfo(outside),
      await env.exists(outside),
      await env.writeFile("../escape.txt", "no"),
      await env.readTextFile("escape-link"),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    }

    const controller = new AbortController();
    controller.abort();
    expect(await env.absolutePath("inside.txt", controller.signal)).toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(await env.exists("missing.txt")).toEqual({ ok: true, value: false });
    expect(await env.absolutePath("inside.txt/child")).toMatchObject({
      ok: false,
      error: { code: "unknown" },
    });
  });

  it("does not expose unused filesystem or process capabilities", async () => {
    const { worktree } = roots();
    const env = await ScopedExecutionEnv.create(worktree);
    const unsupported = await Promise.all([
      env.joinPath(["a", "b"]),
      env.readTextLines("inside.txt"),
      env.renameFile("inside.txt", "other.txt"),
      env.listDir("."),
      env.canonicalPath("inside.txt"),
      env.createDir("dir"),
      env.remove("inside.txt"),
      env.createTempDir(),
    ]);
    for (const result of unsupported) {
      expect(result).toMatchObject({ ok: false, error: { code: "not_supported" } });
    }
    expect(await env.appendFile("inside.txt", "x")).toEqual({ ok: true, value: undefined });
    const spool = await env.createTempFile({ prefix: "bash-", suffix: ".log" });
    expect(spool).toMatchObject({ ok: true, value: expect.stringContaining(".volli-bash-") });
    if (spool.ok) expect(dirname(spool.value)).toContain(".volli-bash-");
    for (const fragment of [
      "../escape",
      "nested/file",
      "nested\\file",
      "..",
      "bad\0name",
      "line\nbreak",
    ]) {
      expect(await env.createTempFile({ prefix: fragment })).toMatchObject({
        ok: false,
        error: { code: "invalid" },
      });
      expect(await env.createTempFile({ suffix: fragment })).toMatchObject({
        ok: false,
        error: { code: "invalid" },
      });
    }
    if (spool.ok) {
      const spoolDirectory = dirname(spool.value);
      await env.cleanup();
      expect(existsSync(spoolDirectory)).toBe(false);
    }
    expect(await env.exec("pwd")).toMatchObject({
      ok: false,
      error: { code: "shell_unavailable" },
    });
  });

  it("preflights the process-global sandbox exactly once for concurrent Ticket environments", async () => {
    const { worktree } = roots();
    const srt = sandbox();
    const first = await ScopedExecutionEnv.create(worktree, { sandbox: srt });
    const second = await ScopedExecutionEnv.create(worktree, { sandbox: srt });

    await Promise.all([first.prepareProcessExecution(), second.prepareProcessExecution()]);

    expect(srt.calls).toMatchObject({ checks: 1, initializes: 1 });
  });

  it("fails closed and caches an unavailable sandbox without resetting process state", async () => {
    const { worktree } = roots();
    const srt = sandbox({ isSupportedPlatform: () => false });
    const env = await ScopedExecutionEnv.create(worktree, { sandbox: srt });

    expect(await env.prepareProcessExecution()).toMatchObject({
      ok: false,
      error: { code: "shell_unavailable" },
    });
    expect(await env.prepareProcessExecution()).toMatchObject({
      ok: false,
      error: { code: "shell_unavailable" },
    });
    await env.cleanup();

    expect(srt.calls).toMatchObject({ checks: 0, initializes: 0, cleanups: 0 });
  });

  it("fails closed when another caller initialized the process-global sandbox differently", async () => {
    const { worktree } = roots();
    const permissive = {
      network: { allowedDomains: ["*"], deniedDomains: [], strictAllowlist: false },
    };
    const srt = sandbox({
      isSandboxingEnabled: () => true,
      getConfig: () => permissive as unknown as SandboxRuntimeConfig,
    });
    const first = await ScopedExecutionEnv.create(worktree, { sandbox: srt });
    const second = await ScopedExecutionEnv.create(worktree, { sandbox: srt });

    await expect(
      Promise.all([first.prepareProcessExecution(), second.prepareProcessExecution()]),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "shell_unavailable" }),
      }),
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "shell_unavailable" }),
      }),
    ]);
    expect(srt.calls).toMatchObject({ checks: 1, initializes: 0 });
  });

  it("fails closed before initialization when a permissive process-global config remains", async () => {
    const { worktree } = roots();
    const permissive = {
      network: { allowedDomains: ["*"], deniedDomains: [], strictAllowlist: false },
    };
    const srt = sandbox({ getConfig: () => permissive as unknown as SandboxRuntimeConfig });
    const env = await ScopedExecutionEnv.create(worktree, { sandbox: srt });

    expect(await env.prepareProcessExecution()).toMatchObject({
      ok: false,
      error: { code: "shell_unavailable" },
    });
    expect(srt.calls).toMatchObject({ checks: 1, initializes: 0 });
  });

  it("runs a wrapped argv in the canonical Ticket worktree with a scrubbed environment", async () => {
    const { worktree } = roots();
    const homeDir = join(tmpdir(), "volli-home");
    const srt = sandbox();
    const running = child();
    const spawns: Array<{
      command: string;
      args: readonly string[];
      options: Record<string, unknown>;
    }> = [];
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: srt,
      homeDir,
      spawn: ((command: string, args: readonly string[], options: SpawnOptions) => {
        spawns.push({ command, args, options: options as Record<string, unknown> });
        return running;
      }) as never,
    });

    const progress: string[] = [];
    const execution = env.exec("echo safe", {
      env: { VOLLI_TEST_FLAG: "yes", GITHUB_TOKEN: "never-pass" },
      onStdout: (chunk) => progress.push(chunk),
    });
    await vi.waitFor(() => expect(spawns).toHaveLength(1));
    running.stdout.write("safe\\n");
    running.emit("close", 0);

    await expect(execution).resolves.toEqual({
      ok: true,
      value: { stdout: "safe\\n", stderr: "", exitCode: 0 },
    });
    expect(progress).toEqual(["safe\\n"]);
    expect(srt.calls.wraps[0]).toMatchObject([
      "echo safe",
      "/bin/bash",
      {
        network: {
          allowedDomains: [],
          deniedDomains: ["*"],
          allowUnixSockets: [],
          allowLocalBinding: false,
        },
        filesystem: {
          denyRead: [homeDir],
          allowRead: [env.cwd],
          allowWrite: [env.cwd],
          denyWrite: [
            join(homeDir, ".npm", "_logs"),
            join(homeDir, ".claude", "debug"),
            "/tmp/claude",
            "/private/tmp/claude",
          ],
        },
      },
      undefined,
      env.cwd,
    ]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      command: "/usr/bin/true",
      args: [],
      options: { cwd: env.cwd, shell: false },
    });
    expect(spawns[0]!.options.env).toMatchObject({ PATH: "/usr/bin:/bin" });
    expect(spawns[0]!.options.env).not.toHaveProperty("VOLLI_TEST_FLAG");
    expect(spawns[0]!.options.env).not.toHaveProperty("HOME");
    expect(spawns[0]!.options.env).not.toHaveProperty("GITHUB_TOKEN");
    for (const hook of [
      "BASH_ENV",
      "ENV",
      "NODE_OPTIONS",
      "DYLD_INSERT_LIBRARIES",
      "LD_PRELOAD",
      "RUBYOPT",
      "PERL5OPT",
      "PYTHONPATH",
      "GIT_CONFIG_GLOBAL",
    ]) {
      expect(spawns[0]!.options.env).not.toHaveProperty(hook);
    }
    expect(srt.calls.cleanups).toBe(1);
  });

  it("encodes callback failure and abort while terminating the host child group", async () => {
    const { worktree } = roots();
    const srt = sandbox();
    const callbackChild = child();
    const callbackKill = vi.fn();
    const callbackEnv = await ScopedExecutionEnv.create(worktree, {
      sandbox: srt,
      spawn: (() => callbackChild) as never,
      processKill: callbackKill,
    });
    const callbackRun = callbackEnv.exec("echo output", {
      onStdout: () => {
        throw new Error("sink failed");
      },
    });
    await vi.waitFor(() => expect(callbackChild.listenerCount("close")).toBeGreaterThan(0));
    callbackChild.stdout.write("output");
    await expect(callbackRun).resolves.toMatchObject({
      ok: false,
      error: { code: "callback_error" },
    });
    expect(callbackKill).toHaveBeenCalledWith(-1234, "SIGTERM");

    const abortedChild = child();
    const controller = new AbortController();
    const abortKill = vi.fn();
    const abortEnv = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => abortedChild) as never,
      processKill: abortKill,
    });
    const abortRun = abortEnv.exec("sleep 10", { abortSignal: controller.signal });
    await vi.waitFor(() => expect(abortedChild.listenerCount("close")).toBeGreaterThan(0));
    controller.abort();
    await expect(abortRun).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(abortKill).toHaveBeenCalledWith(-1234, "SIGTERM");
  });

  it("escalates the original process group after its leader closes", async () => {
    const { worktree } = roots();
    const running = child();
    const processKill = vi.fn();
    const controller = new AbortController();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
      processKill,
    });
    const run = env.exec("sleep 10", { abortSignal: controller.signal });
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));

    vi.useFakeTimers();
    try {
      controller.abort();
      running.emit("close", 0);
      await vi.advanceTimersByTimeAsync(249);
      expect(processKill).toHaveBeenCalledWith(-1234, "SIGTERM");
      expect(processKill).not.toHaveBeenCalledWith(-1234, "SIGKILL");
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
      expect(processKill).toHaveBeenCalledWith(-1234, "SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cleanup's group escalation after the shell leader closes", async () => {
    const { worktree } = roots();
    const running = child();
    const processKill = vi.fn();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
      processKill,
    });
    const run = env.exec("sleep 10");
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));

    vi.useFakeTimers();
    try {
      const cleaning = env.cleanup();
      await Promise.resolve();
      expect(processKill).toHaveBeenCalledWith(-1234, "SIGTERM");
      running.emit("close", 0);
      await vi.advanceTimersByTimeAsync(250);
      await cleaning;
      await expect(run).resolves.toMatchObject({ ok: true });
      expect(processKill).toHaveBeenCalledWith(-1234, "SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up each successful wrap exactly once when launch throws or executions overlap", async () => {
    const { worktree } = roots();
    const srt = sandbox();
    const failed = await ScopedExecutionEnv.create(worktree, {
      sandbox: srt,
      spawn: (() => {
        throw new Error("spawn failed");
      }) as never,
    });
    await expect(failed.exec("false")).resolves.toMatchObject({
      ok: false,
      error: { code: "spawn_error" },
    });
    expect(srt.calls.cleanups).toBe(1);

    const first = child();
    const second = child();
    const children = [first, second];
    const concurrent = await ScopedExecutionEnv.create(worktree, {
      sandbox: srt,
      spawn: (() => children.shift()!) as never,
    });
    const executions = [concurrent.exec("true"), concurrent.exec("true")];
    await vi.waitFor(() => expect(first.listenerCount("close")).toBeGreaterThan(0));
    first.emit("close", 0);
    second.emit("close", 0);
    await expect(Promise.all(executions)).resolves.toHaveLength(2);
    expect(srt.calls.cleanups).toBe(3);
  });

  it("caps stdout and stderr independently by bytes without splitting UTF-8", async () => {
    const { worktree } = roots();
    const running = child();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
    });
    const run = env.exec("output");
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    const oversized = Buffer.concat([Buffer.alloc(999_999, 0x61), Buffer.from("€extra")]);
    running.stdout.write(oversized);
    running.stderr.write(oversized);
    running.emit("close", 0);

    await expect(run).resolves.toEqual({
      ok: true,
      value: { stdout: "a".repeat(999_999), stderr: "a".repeat(999_999), exitCode: 0 },
    });
  });

  it("preserves a multibyte character split across output chunks before byte decoding", async () => {
    const { worktree } = roots();
    const running = child();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
    });
    const run = env.exec("output");
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    running.stdout.write(Buffer.alloc(999_997, 0x61));
    running.stdout.write(Buffer.from([0xe2]));
    running.stdout.write(Buffer.from([0x82, 0xac]));
    running.emit("close", 0);

    await expect(run).resolves.toEqual({
      ok: true,
      value: { stdout: `${"a".repeat(999_997)}€`, stderr: "", exitCode: 0 },
    });
  });

  it("forwards append-file cancellation to the underlying environment", async () => {
    const { worktree } = roots();
    const append = vi.spyOn(NodeExecutionEnv.prototype, "appendFile");
    const env = await ScopedExecutionEnv.create(worktree);
    const controller = new AbortController();

    await env.appendFile("inside.txt", "x", controller.signal);

    expect(append).toHaveBeenCalledWith(join(env.cwd, "inside.txt"), "x", controller.signal);
    await env.cleanup();
  });
});
