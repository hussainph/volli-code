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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  applyShellOutputUpdate,
  BACKGROUND_CONTEXT,
  FileError,
  withAbortSignal,
  type Context,
  type ShellExecOptions,
  type ShellOutputCaptureOptions,
  type ShellOutputUpdate,
  type ShellOutputView,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it, vi } from "vite-plus/test";
import { ScopedExecutionEnv, type ScopedExecutionEnvOptions } from "./scoped-execution-env";

type SandboxOverrides = Partial<NonNullable<ScopedExecutionEnvOptions["sandbox"]>>;

/**
 * The cancellation an operation runs under, as Pi 0.85 expresses it.
 *
 * Every `FileSystem`/`Shell` method lost its trailing `abortSignal?` and gained
 * a trailing chord `Context`; a signal reaches one by being wrapped onto the
 * empty root. Tests that are not about cancellation pass nothing at all, which
 * this environment reads exactly as an absent `abortSignal` was read before.
 */
function under(signal: AbortSignal): Context {
  return withAbortSignal(signal, BACKGROUND_CONTEXT);
}

/**
 * What a consumer of `exec` actually sees in 0.85: one bounded view, rebuilt
 * from the updates the environment publishes.
 *
 * `applyShellOutputUpdate` is Pi's own reducer, so these assertions are about
 * the sequence a real consumer would fold rather than about a shape this file
 * invented. Stdout and stderr are merged — the release's decision, not this
 * environment's — so there is one `text` here where there used to be two.
 */
function collected(
  capture: ShellOutputCaptureOptions = { limits: { maxBytes: 50 * 1024, maxLines: 2_000 } },
) {
  const updates: ShellOutputUpdate[] = [];
  let view: ShellOutputView | undefined;
  const options: ShellExecOptions = {
    capture,
    onUpdate: (update) => {
      updates.push(update);
      view = applyShellOutputUpdate(view, update);
    },
  };
  return {
    options,
    updates,
    get text(): string {
      return view?.text ?? "";
    },
    get view(): ShellOutputView | undefined {
      return view;
    },
  };
}

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
    expect(await env.absolutePath("inside.txt", under(controller.signal))).toMatchObject({
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

    const seen = collected();
    const execution = env.exec("echo safe", {
      ...seen.options,
      env: { VOLLI_TEST_FLAG: "yes", GITHUB_TOKEN: "never-pass" },
    });
    await vi.waitFor(() => expect(spawns).toHaveLength(1));
    running.stdout.write("safe\\n");
    running.emit("close", 0);

    await expect(execution).resolves.toEqual({
      ok: true,
      value: { exitCode: 0, truncation: expect.objectContaining({ truncated: false }) },
    });
    expect(seen.text).toBe("safe\\n");
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
      capture: { limits: { maxBytes: 1_024, maxLines: 100 } },
      onUpdate: () => {
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
    const abortRun = abortEnv.exec("sleep 10", undefined, under(controller.signal));
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
    const run = env.exec("sleep 10", undefined, under(controller.signal));
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

  it("bounds the merged view by the caller's budget, republishing a window that has slid", async () => {
    const { worktree } = roots();
    const running = child();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
    });
    // 0.85 moved the budget from this environment to its caller: `exec` keeps
    // what `capture.limits` asks for and nothing more, and reports what it
    // dropped rather than silently returning a prefix.
    const seen = collected({ limits: { maxBytes: 8, maxLines: 100 } });
    const run = env.exec("output", seen.options);
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    running.stdout.write("aaaa\n");
    running.stdout.write("bbbb\n");
    running.emit("close", 0);

    await expect(run).resolves.toMatchObject({
      ok: true,
      value: {
        exitCode: 0,
        // Totals are what the command produced, not what survived the budget:
        // the bash tool renders `[Showing lines 2-2 of 2]` off exactly these.
        truncation: { truncated: true, truncatedBy: "bytes", totalBytes: 10, totalLines: 2 },
      },
    });
    expect(seen.text).toBe("bbbb");
    // The first line left the window, so the second update could not be an
    // append — what a consumer folds is the bounded window again.
    expect(seen.updates.map((update) => update.kind)).toEqual(["replace", "replace"]);
  });

  it("reports a single over-long line as a partial one, cut on a character boundary", async () => {
    const { worktree } = roots();
    const running = child();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
    });
    const seen = collected({ limits: { maxBytes: 16, maxLines: 100 } });
    const run = env.exec("output", seen.options);
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    running.stdout.write(Buffer.concat([Buffer.alloc(20, 0x61), Buffer.from("€")]));
    running.emit("close", 0);

    await expect(run).resolves.toMatchObject({
      ok: true,
      value: {
        exitCode: 0,
        truncation: { truncated: true, lastLinePartial: true, totalBytes: 23, totalLines: 1 },
        // How long the line really was, which is the only way the tool that
        // renders this can say "showing the last 16B of a 23B line".
        lastLineBytes: 23,
      },
    });
    // Sixteen bytes of a twenty-three byte line, ending on the three-byte
    // character rather than in the middle of it.
    expect(seen.text).toBe(`${"a".repeat(13)}€`);
  });

  it("decodes each stream on its own while merging both into one view", async () => {
    const { worktree } = roots();
    const running = child();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
    });
    const seen = collected();
    const run = env.exec("output", seen.options);
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    running.stdout.write(Buffer.from([0xe2]));
    running.stderr.write(Buffer.from([0xe2]));
    running.stdout.write(Buffer.from([0x82, 0xac]));
    running.stderr.write(Buffer.from([0x82, 0xac]));
    running.stdout.write(Buffer.from([0xe2]));
    running.stderr.write(Buffer.from([0xe2]));
    running.emit("close", 0);

    await expect(run).resolves.toMatchObject({ ok: true, value: { exitCode: 0 } });
    // Two whole characters and two flushed lead bytes. 0.85 merges the streams,
    // but the merge happens on decoded text: one shared decoder — which is what
    // Pi's own environment uses — would have completed stdout's lead byte with
    // stderr's continuation and produced one character where there are two.
    expect(seen.text).toBe("€€��");
    expect(seen.updates.map((update) => update.kind)).toEqual([
      "replace",
      "append",
      "append",
      "append",
    ]);

    // A child can keep writing after its group was killed, and its pipes are
    // still attached here. Nothing published then would be about a command the
    // caller has not already been told the outcome of.
    const published = seen.updates.length;
    running.stdout.write("after the fact");
    expect(seen.updates).toHaveLength(published);
  });

  it("names the line limit when that is the budget the output crossed", async () => {
    const { worktree } = roots();
    const running = child();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
    });
    // Two independent limits, whichever is crossed first — and which one it was
    // is what the bash tool's notice says out loud, so it has to be right.
    const seen = collected({ limits: { maxBytes: 1_000, maxLines: 2 } });
    const run = env.exec("output", seen.options);
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    running.stdout.write("aa\nbb\ncc\n");
    running.emit("close", 0);

    await expect(run).resolves.toMatchObject({
      ok: true,
      value: {
        exitCode: 0,
        truncation: { truncated: true, truncatedBy: "lines", totalLines: 3, totalBytes: 9 },
      },
    });
    expect(seen.text).toBe("bb\ncc");
  });

  it("keeps a head-retained window from the front, counting everything that arrived", async () => {
    const { worktree } = roots();
    const running = child();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
    });
    // `retain: "head"` is the half of the contract Pi's own bash tool never
    // asks for. It is honoured anyway, because the environment is the thing the
    // interface names and a caller is entitled to either end.
    const seen = collected({ limits: { maxBytes: 8, maxLines: 100, retain: "head" } });
    const run = env.exec("output", seen.options);
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    // Far past the internal guard on the retained buffer, so this also proves
    // the totals are counted as bytes arrive rather than measured off whatever
    // the guard left behind.
    running.stdout.write("aa\n".repeat(40));
    running.emit("close", 0);

    await expect(run).resolves.toMatchObject({
      ok: true,
      value: { exitCode: 0, truncation: { truncated: true, totalBytes: 120, totalLines: 40 } },
    });
    expect(seen.text).toBe("aa\naa\naa");
  });

  it("keeps a tail-retained window from the end past the same guard", async () => {
    const { worktree } = roots();
    const running = child();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
    });
    const seen = collected({ limits: { maxBytes: 8, maxLines: 100 } });
    const run = env.exec("output", seen.options);
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    running.stdout.write("aa\n".repeat(40));
    running.emit("close", 0);

    await expect(run).resolves.toMatchObject({
      ok: true,
      value: { exitCode: 0, truncation: { truncated: true, totalBytes: 120, totalLines: 40 } },
    });
    expect(seen.text).toBe("aa\naa\naa");
  });

  /**
   * The spool moved in 0.85. In 0.84 the collector above this environment kept
   * a truncated command's complete output by calling `createTempFile` and
   * `appendFile` on the environment itself; now the environment owns it, behind
   * `capture.spill`. Honouring it here rather than declining it is what keeps
   * the spool inside the Session workspace — the one directory this boundary
   * lets a contained command write.
   */
  it("spools a truncated command's complete output into the workspace, from its first byte", async () => {
    const { worktree } = roots();
    const running = child();
    let opening = 0;
    const opened = Promise.withResolvers<void>();
    const env = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => running) as never,
      fileOperations: {
        mkdtemp: async (prefix) => {
          opening += 1;
          await opened.promise;
          return mkdtemp(prefix);
        },
        writeFile: async (path, content) => writeFile(path, content),
        rm: async (path, options) => rm(path, options),
      },
    });
    const seen = collected({ limits: { maxBytes: 6, maxLines: 100 }, spill: true });
    const run = env.exec("output", seen.options);
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));

    // Under the budget: held back, because a command whose output fits should
    // leave no file behind at all.
    running.stdout.write("aaa\n");
    expect(opening).toBe(0);
    // Over it: the held prefix and this chunk reach the spool together.
    running.stdout.write("bbb\n");
    await vi.waitFor(() => expect(opening).toBe(1));
    // And this one arrives while the spool is still being opened, so it has to
    // queue behind it rather than race it.
    running.stdout.write("ccc\n");
    opened.resolve();
    running.emit("close", 0);

    const result = await run;
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
    const spillPath = result.ok ? result.value.spillPath : undefined;
    expect(spillPath).toBeDefined();
    expect(dirname(spillPath!)).toContain(".volli-bash-");
    expect(readFileSync(spillPath!, "utf8")).toBe("aaa\nbbb\nccc\n");
    // The view stays bounded while the spool holds everything, and the path
    // still reaches the consumer — through a metadata update, since it is
    // discovered after the bytes it belongs to.
    expect(seen.text).toBe("ccc");
    expect(seen.view?.spillPath).toBe(spillPath);
    expect(seen.updates.some((update) => update.kind === "metadata")).toBe(true);

    await env.cleanup();
    expect(existsSync(spillPath!)).toBe(false);
  });

  it("fails a command whose complete output could not be preserved", async () => {
    const { worktree } = roots();
    const unopenable = child();
    const unopenableEnv = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => unopenable) as never,
      fileOperations: {
        mkdtemp: async () => Promise.reject(new Error("no room for a spool")),
        writeFile: async () => undefined,
        rm: async () => undefined,
      },
    });
    const cannotOpen = unopenableEnv.exec("output", {
      capture: { limits: { maxBytes: 4, maxLines: 100 }, spill: true },
    });
    await vi.waitFor(() => expect(unopenable.listenerCount("close")).toBeGreaterThan(0));
    unopenable.stdout.write("more than four bytes\n");
    unopenable.emit("close", 0);

    // A spool that cannot be written is a failed command rather than a quietly
    // shorter one: the truncation notice names a path, and a named path holding
    // nothing is worse than an error. Pi's own environment answers the same way.
    await expect(cannotOpen).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unknown",
        message: expect.stringContaining("preserve complete shell output"),
      },
    });

    const unwritable = child();
    const append = vi
      .spyOn(NodeExecutionEnv.prototype, "appendFile")
      .mockResolvedValue({ ok: false, error: new FileError("permission_denied", "read-only") });
    const unwritableEnv = await ScopedExecutionEnv.create(worktree, {
      sandbox: sandbox(),
      spawn: (() => unwritable) as never,
    });
    const cannotWrite = unwritableEnv.exec("output", {
      capture: { limits: { maxBytes: 4, maxLines: 100 }, spill: true },
    });
    await vi.waitFor(() => expect(unwritable.listenerCount("close")).toBeGreaterThan(0));
    unwritable.stdout.write("more than four bytes\n");
    unwritable.emit("close", 0);

    await expect(cannotWrite).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown", message: expect.stringContaining("read-only") },
    });
    append.mockRestore();
    await unwritableEnv.cleanup();
  });

  it("forwards append-file cancellation to the underlying environment", async () => {
    const { worktree } = roots();
    const append = vi.spyOn(NodeExecutionEnv.prototype, "appendFile");
    const env = await ScopedExecutionEnv.create(worktree);
    const controller = new AbortController();
    const context = under(controller.signal);

    await env.appendFile("inside.txt", "x", context);

    // 0.84's Node environment took a third argument and ignored it, so this was
    // forwarded through a cast on the promise that it would one day mean
    // something. In 0.85 it does: `appendFile` reads `context.abortSignal`.
    expect(append).toHaveBeenCalledWith(join(env.cwd, "inside.txt"), "x", context);
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
    expect(await lateAbort.createTempFile(undefined, under(controller.signal))).toMatchObject({
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
    const run = env.exec(
      "echo",
      {
        capture: { limits: { maxBytes: 1_024, maxLines: 100 } },
        onUpdate: () => {
          throw new Error("stop");
        },
      },
      under(controller.signal),
    );
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
    expect(await enabledEnv.exec("echo never", undefined, under(abort.signal))).toMatchObject({
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
    expect(await enabledEnv.createTempFile(undefined, under(abort.signal))).toMatchObject({
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
    const seen = collected();
    const output = env.exec("output", seen.options);
    await vi.waitFor(() => expect(running.listenerCount("close")).toBeGreaterThan(0));
    running.stdout.emit("data", "text stdout");
    running.stderr.emit("data", "text stderr");
    running.emit("close", null);
    // A close with no code is still an exit, and 1 is what it has always been
    // reported as. Both streams arrive in one view now, in the order the child
    // produced them.
    await expect(output).resolves.toMatchObject({ ok: true, value: { exitCode: 1 } });
    expect(seen.text).toBe("text stdouttext stderr");

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
