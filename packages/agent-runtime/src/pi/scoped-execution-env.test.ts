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
import { ScopedExecutionEnv, type ScopedExecutionEnvOptions } from "./scoped-execution-env";

type SandboxOverrides = Partial<NonNullable<ScopedExecutionEnvOptions["sandbox"]>>;

function roots() {
  const parent = mkdtempSync(join(tmpdir(), "volli-scoped-env-"));
  const worktree = join(parent, "worktree");
  const outside = join(parent, "outside.txt");
  mkdirSync(worktree);
  writeFileSync(join(worktree, "inside.txt"), "inside\n");
  writeFileSync(outside, "outside\n");
  return { worktree, outside };
}

function sandbox(overrides: SandboxOverrides = {}) {
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
          LANG: "C.UTF-8",
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

  it("keeps unused filesystem capabilities unavailable and fails closed without a process boundary", async () => {
    const { worktree } = roots();
    const env = await ScopedExecutionEnv.create(worktree, {
      // The ordinary unit suite must not depend on whether its host can run
      // SRT. The live integration gate proves the available-boundary path.
      sandbox: sandbox({ isSupportedPlatform: () => false }),
    });
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

  it("fails closed when the sandbox is unavailable", async () => {
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

  it("retries a rejected process preflight when the same sandbox later becomes available", async () => {
    const { worktree } = roots();
    let available = false;
    const srt = sandbox({ isSupportedPlatform: () => available });
    const env = await ScopedExecutionEnv.create(worktree, { sandbox: srt });

    await expect(env.prepareProcessExecution()).resolves.toMatchObject({
      ok: false,
      error: { code: "shell_unavailable" },
    });

    available = true;

    await expect(env.prepareProcessExecution()).resolves.toEqual({ ok: true, value: undefined });
    expect(srt.calls).toMatchObject({ checks: 1, initializes: 1 });
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
            join(env.cwd, ".git", "hooks"),
            join(env.cwd, ".git", "config"),
            join(env.cwd, ".git", "modules", "**", "hooks"),
            join(env.cwd, ".git", "modules", "**", "hooks", "**", "*"),
            join(env.cwd, ".git", "modules", "**", "config"),
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
    expect(spawns[0]!.options.env).toMatchObject({ LANG: "C.UTF-8" });
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

  // The composed config only; the kernel's own refusal is proved against a real
  // Main checkout in `scoped-execution-env.srt.integration.test.ts`.
  it("composes a denial of .git hooks and config alone, leaving the rest of .git writable", async () => {
    const { worktree } = roots();
    const srt = sandbox();
    const running = child();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: srt,
      spawn: (() => running) as never,
    });
    const execution = env.exec("git commit -m x");
    await vi.waitFor(() => expect(srt.calls.wraps).toHaveLength(1));
    running.emit("close", 0);
    await execution;

    const [, , composed] = srt.calls.wraps[0] as [string, string, SandboxRuntimeConfig];
    expect(composed.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        join(env.cwd, ".git", "hooks"),
        join(env.cwd, ".git", "config"),
        // A submodule's hooks execute too, and live where the literals cannot reach.
        join(env.cwd, ".git", "modules", "**", "hooks", "**", "*"),
      ]),
    );
    // A Session that cannot write the index, refs, and objects cannot commit.
    expect(composed.filesystem.denyWrite).not.toContain(join(env.cwd, ".git"));
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
    await vi.waitFor(() => {
      expect(first.listenerCount("close")).toBeGreaterThan(0);
      expect(second.listenerCount("close")).toBeGreaterThan(0);
    });
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
    running.stdout.emit("data", "not captured after the stream cap");
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

  it("streams split UTF-8 separately to stdout and stderr callbacks and flushes them at close", async () => {
    const { worktree } = roots();
    const running = child();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const run = env.exec("output", {
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    });
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    running.stdout.write(Buffer.from([0xe2]));
    running.stderr.write(Buffer.from([0xe2]));
    running.stdout.write(Buffer.from([0x82, 0xac]));
    running.stderr.write(Buffer.from([0x82, 0xac]));
    running.stdout.write(Buffer.from([0xe2]));
    running.stderr.write(Buffer.from([0xe2]));
    running.emit("close", 0);

    await expect(run).resolves.toEqual({
      ok: true,
      value: { stdout: "€", stderr: "€", exitCode: 0 },
    });
    expect(stdout).toEqual(["€", "�"]);
    expect(stderr).toEqual(["€", "�"]);
  });

  it("forwards append-file cancellation to the underlying environment", async () => {
    const { worktree } = roots();
    const append = vi.spyOn(NodeExecutionEnv.prototype, "appendFile");
    const env = await ScopedExecutionEnv.create(worktree);
    const controller = new AbortController();

    await env.appendFile("inside.txt", "x", controller.signal);

    expect(append).toHaveBeenCalledWith(join(env.cwd, "inside.txt"), "x", controller.signal);
    await env.cleanup();
    append.mockRestore();
  });

  it("cleans owned output spools after a late abort, write failure, or cleanup fault", async () => {
    const { worktree } = roots();
    const controller = new AbortController();
    const lateDirectory = join(worktree, ".volli-bash-late");
    mkdirSync(lateDirectory);
    const lateRemove = vi.fn(async () => undefined);
    const lateAbort = await ScopedExecutionEnv.create(worktree, {
      fileOperations: {
        mkdtemp: async () => {
          controller.abort();
          return lateDirectory;
        },
        writeFile: async () => undefined,
        rm: lateRemove,
      },
    });
    expect(await lateAbort.createTempFile({ abortSignal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(lateRemove).toHaveBeenCalledWith(lateDirectory, { recursive: true, force: true });

    const failedDirectory = join(worktree, ".volli-bash-failed");
    mkdirSync(failedDirectory);
    const writeFailure = await ScopedExecutionEnv.create(worktree, {
      fileOperations: {
        mkdtemp: async () => failedDirectory,
        writeFile: async () => Promise.reject("disk full"),
        rm: async () => Promise.reject(new Error("already removed")),
      },
    });
    expect(await writeFailure.createTempFile()).toMatchObject({
      ok: false,
      error: { code: "unknown", message: "disk full" },
    });

    const ownedDirectory = join(worktree, ".volli-bash-owned");
    const ownedRemove = vi.fn(async () => undefined);
    const owned = await ScopedExecutionEnv.create(worktree, {
      fileOperations: {
        mkdtemp: async () => ownedDirectory,
        writeFile: async () => undefined,
        rm: ownedRemove,
      },
    });
    await expect(owned.createTempFile()).resolves.toMatchObject({ ok: true });
    await owned.cleanup();
    expect(ownedRemove).toHaveBeenCalledWith(ownedDirectory, { recursive: true, force: true });
  });

  it("falls back to the child signal method and a minimal trusted PATH", async () => {
    const { worktree } = roots();
    const running = child();
    const processKill = vi.fn(() => {
      throw new Error("group already gone");
    });
    const spawns: SpawnOptions[] = [];
    const srt = sandbox({
      wrapWithSandboxArgv: async () => ({ argv: ["/usr/bin/true"], env: {} }),
    });
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: srt,
      spawn: ((_command: string, _args: readonly string[], options: SpawnOptions) => {
        spawns.push(options);
        return running;
      }) as never,
      processKill,
    });
    const controller = new AbortController();
    const run = env.exec("echo", {
      abortSignal: controller.signal,
      onStdout: () => {
        throw new Error("stop");
      },
    });
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    running.stdout.write("output");
    await vi.waitFor(() => expect(running.kill).toHaveBeenCalledWith("SIGTERM"));
    controller.abort();
    running.emit("close", 0);
    await expect(run).resolves.toMatchObject({ ok: false, error: { code: "callback_error" } });
    running.emit("error", new Error("late process event"));
    expect(processKill).toHaveBeenCalledWith(-1234, "SIGTERM");
    expect(running.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawns[0]!.env).toMatchObject({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  });

  it("returns bounded errors for preflight, cwd, temporary-file, and wrapper failures", async () => {
    const { worktree, outside } = roots();
    const dependencyEnv = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox({
        checkDependenciesAsync: async () => ({ errors: ["missing runtime"], warnings: [] }),
      }),
    });
    expect(await dependencyEnv.prepareProcessExecution()).toMatchObject({
      ok: false,
      error: { code: "shell_unavailable", message: expect.stringContaining("missing runtime") },
    });

    const enabledWithoutConfig = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox({ isSandboxingEnabled: () => true, getConfig: () => undefined }),
    });
    expect(await enabledWithoutConfig.prepareProcessExecution()).toMatchObject({
      ok: false,
      error: { code: "shell_unavailable", message: expect.stringContaining("incompatible") },
    });
    const discardedConfig = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox({ getConfig: () => undefined }),
    });
    expect(await discardedConfig.prepareProcessExecution()).toMatchObject({
      ok: false,
      error: { code: "shell_unavailable", message: expect.stringContaining("did not retain") },
    });

    const configured = sandbox();
    const configuredEnv = await ScopedExecutionEnv.create(worktree, { sandbox: configured });
    await configuredEnv.prepareProcessExecution();
    const enabled = sandbox({
      isSandboxingEnabled: () => true,
      getConfig: () => configured.getConfig(),
    });
    const enabledEnv = await ScopedExecutionEnv.create(worktree, { sandbox: enabled });
    expect(await enabledEnv.prepareProcessExecution()).toEqual({ ok: true, value: undefined });

    const abort = new AbortController();
    abort.abort();
    expect(await enabledEnv.exec("echo never", { abortSignal: abort.signal })).toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(await enabledEnv.exec("pwd", { cwd: outside })).toMatchObject({
      ok: false,
      error: { code: "spawn_error", message: expect.stringContaining("outside") },
    });
    expect(await enabledEnv.exec("pwd", { cwd: "missing-directory" })).toMatchObject({
      ok: false,
      error: { code: "spawn_error", message: expect.stringContaining("unavailable") },
    });
    expect(await enabledEnv.appendFile("../outside.txt", "no")).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect(await enabledEnv.createTempFile({ abortSignal: abort.signal })).toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });

    const wrapFailure = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox({
        wrapWithSandboxArgv: async () => Promise.reject(new Error("cannot wrap")),
      }),
    });
    expect(await wrapFailure.exec("pwd")).toMatchObject({
      ok: false,
      error: { code: "shell_unavailable", message: expect.stringContaining("cannot wrap") },
    });
    const noArgv = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox({ wrapWithSandboxArgv: async () => ({ argv: [], env: {} }) }),
    });
    expect(await noArgv.exec("pwd")).toMatchObject({
      ok: false,
      error: { code: "spawn_error", message: expect.stringContaining("no command argv") },
    });
  });

  it("handles child launch errors, text chunks, default exits, timeouts, and kill fallbacks", async () => {
    const { worktree } = roots();
    const running = child();
    const fallbackKill = vi.fn(() => {
      throw new Error("group already gone");
    });
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
      processKill: fallbackKill,
    });
    const output = env.exec("output");
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    running.stdout.emit("data", "text stdout");
    running.stderr.emit("data", "text stderr");
    running.emit("close", null);
    await expect(output).resolves.toEqual({
      ok: true,
      value: { stdout: "text stdout", stderr: "text stderr", exitCode: 1 },
    });

    const launchError = child();
    const launchEnv = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => launchError) as never,
    });
    const failed = launchEnv.exec("fails-after-launch");
    await vi.waitFor(() => expect(launchError.listenerCount("error")).toBeGreaterThan(0));
    launchError.emit("error", new Error("child launch failure"));
    await expect(failed).resolves.toMatchObject({ ok: false, error: { code: "spawn_error" } });

    const timeoutChild = child();
    timeoutChild.pid = 0;
    const timeoutEnv = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => timeoutChild) as never,
      processKill: fallbackKill,
    });
    await timeoutEnv.prepareProcessExecution();
    const timedOut = timeoutEnv.exec("sleep 10", { timeout: 0.001 });
    await vi.waitFor(() => expect(timeoutChild.listenerCount("close")).toBeGreaterThan(0));
    await expect(timedOut).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(timeoutChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(timeoutChild.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("finishes attachment cleanup when a process-group leader never reports close", async () => {
    const { worktree } = roots();
    const running = child();
    const processKill = vi.fn();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
      processKill,
    });
    void env.exec("sleep 10");
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));

    vi.useFakeTimers();
    try {
      const cleaning = env.cleanup();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      await cleaning;
      expect(processKill).toHaveBeenCalledWith(-1234, "SIGTERM");
      expect(processKill).toHaveBeenCalledWith(-1234, "SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});
