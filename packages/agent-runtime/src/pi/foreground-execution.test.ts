import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { piExecutionEnv } from "./execution-env";
import { createSessionTools } from "./tools";
import { ShellSpillBudget } from "./shell-spill";
import { withCallScope } from "./call-scope";
import { BACKGROUND_CONTEXT, withAbortSignal } from "./harness-env";
import { NodeExecutionEnv } from "./vendor/pi-harness/env/nodejs";
import { OutputCapture } from "./vendor/pi-harness/execution/output-capture";
import { ExecutionError, type ForegroundShellExecutor } from "./vendor/pi-harness/types";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "volli-foreground-capture-"));
  roots.push(root);
  return root;
}
const text = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((part) => part.text ?? "").join("\n");

/** Only the host boundary is substituted here; bytes come from a real piped child. */
function childExecutor(background = false): ForegroundShellExecutor {
  return async (input) => {
    const child = spawn(input.shellConfig.shell, [...input.shellConfig.args, input.command], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const abort = () => child.kill("SIGKILL");
    input.signal.addEventListener("abort", abort, { once: true });
    input.onReady({
      pauseOutput: () => {
        child.stdout.pause();
        child.stderr.pause();
      },
      resumeOutput: () => {
        child.stdout.resume();
        child.stderr.resume();
      },
    });
    child.stdout.on("data", input.onOutput);
    child.stderr.on("data", input.onOutput);
    const finished = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    input.signal.removeEventListener("abort", abort);
    return background ? { ...finished, background: { shellId: "moved-1" } } : finished;
  };
}

const failingCaptureExecutor: ForegroundShellExecutor = async (input) => {
  input.onReady({ pauseOutput() {}, resumeOutput() {} });
  input.onOutput(Buffer.from("before"));
  input.onOutput(Buffer.from("after"));
  expect(input.signal.aborted).toBe(true);
  throw new Error("Command aborted");
};

describe("foreground bash capture", () => {
  it.each(["foreground", "standalone"])(
    "caps a real 200 MiB execute spill but keeps the final tail (%s)",
    async (path) => {
      const env = await piExecutionEnv(await workspace(), {
        ...(path === "foreground" ? { foregroundExecutor: childExecutor() } : {}),
      });
      const [bash] = createSessionTools({ tools: { tools: ["execute"] } }, env);
      let spillPath: string;
      try {
        const result = await bash!.execute("huge", {
          command:
            "printf 'first-byte\\n'; head -c 209715200 /dev/zero | tr '\\0' x; printf '\\nfinal-tail\\n'",
        });
        spillPath = (result.details as { fullOutputPath: string }).fullOutputPath;
        expect(text(result)).toContain(`Full output: ${spillPath}`);
        expect(text(result)).toContain(`[Spill truncated at ${ShellSpillBudget.maxBytes} bytes.]`);
        expect(text(result)).toContain("final-tail");
        expect(result.details).toMatchObject({
          truncation: { maxBytes: 50 * 1024, maxLines: 2000, truncated: true },
        });
        expect(text(result).length).toBeLessThan(52_000);
        expect((await stat(spillPath)).size).toBe(ShellSpillBudget.maxBytes);
        const file = await open(spillPath, "r");
        try {
          const { buffer } = await file.read(Buffer.alloc(11), 0, 11, 0);
          expect(buffer.toString()).toBe("first-byte\n");
        } finally {
          await file.close();
        }
      } finally {
        await env.cleanup(BACKGROUND_CONTEXT);
      }
      await expect(stat(dirname(spillPath!))).rejects.toMatchObject({ code: "ENOENT" });
    },
    60_000,
  );

  it("keeps bounded capture and complete spill, with the original frozen declaration", async () => {
    const cwd = await workspace();
    const runner = vi.fn(childExecutor(true));
    const env = await piExecutionEnv(cwd, {
      foregroundExecutor: runner,
      identity: { sessionId: "session", ticketDisplayId: "VC-757" },
    });
    const [bash] = createSessionTools({ tools: { tools: ["execute"] } }, env);
    const updates: unknown[] = [];
    const result = await bash!.execute(
      "call",
      { command: "printf 'before\\n'; head -c 60000 /dev/zero | tr '\\0' x; printf '\\nafter\\n'" },
      undefined,
      (update) => updates.push(update),
    );
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]![0]).toMatchObject({
      toolCallId: "call",
      shellConfig: { shell: "/bin/bash", args: ["-c"] },
      cwd,
      env: { VOLLI_SESSION: "session" },
    });
    expect(updates).toContainEqual({ content: [], details: { backgroundable: true } });
    expect(text(result)).toContain("Moved command to background shell moved-1.");
    expect(text(result)).toContain("A notice will arrive when it exits");
    expect(text(result)).toContain("after");
    const details = result.details as { fullOutputPath: string };
    const full = await readFile(details.fullOutputPath, "utf8");
    expect(full).toBe(`before\n${"x".repeat(60000)}\nafter\n`);
    expect(bash!.description).not.toContain("background");
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("does not route nested calls into the foreground host", async () => {
    const runner = vi.fn(childExecutor());
    const env = await piExecutionEnv(await workspace(), { foregroundExecutor: runner });
    const [bash] = createSessionTools({ tools: { tools: ["execute"] } }, env);
    // A scope is all Code Mode lends a nested call; no tool description changes.
    const result = await withCallScope({ question: (ask) => ask() }, () =>
      bash!.execute("nested", { command: "printf nested" }),
    );
    expect(text(result)).toBe("nested");
    expect(runner).not.toHaveBeenCalled();
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("reports the normal exit code and handles a handoff with no output", async () => {
    const env = new NodeExecutionEnv({
      cwd: await workspace(),
      foregroundExecutor: childExecutor(),
    });
    expect(
      await env.exec("exit 7", { foregroundCallId: "exit" }, BACKGROUND_CONTEXT),
    ).toMatchObject({ ok: true, value: { exitCode: 7 } });
    const moved = new NodeExecutionEnv({ cwd: env.cwd, foregroundExecutor: childExecutor(true) });
    const [bash] = createSessionTools({ tools: { tools: ["execute"] } }, moved);
    expect(text(await bash!.execute("empty", { command: "true" }))).toContain("No output so far.");
    await env.cleanup(BACKGROUND_CONTEXT);
    await moved.cleanup(BACKGROUND_CONTEXT);
  });

  it.each([
    [new Error("Command timed out after 0.01 seconds"), "timeout"],
    [new Error("spawn failed"), "spawn_error"],
    [new ExecutionError("spawn_error", "typed failure"), "spawn_error"],
    [Object.assign(new Error("Session attachment ended"), { code: "aborted" }), "aborted"],
    [Object.assign(new Error("Host stopping"), { code: "aborted" }), "aborted"],
    [Object.assign(new Error("host timeout"), { code: "timeout" }), "timeout"],
    [
      Object.assign(new Error("host callback failed"), { code: "callback_error" }),
      "callback_error",
    ],
    [Object.assign(new Error("unrecognized host error"), { code: "other" }), "spawn_error"],
  ] as const)("keeps host failures typed: %s", async (error, code) => {
    const env = new NodeExecutionEnv({
      cwd: await workspace(),
      foregroundExecutor: async () => {
        throw error;
      },
    });
    const result = await env.exec(
      "true",
      { foregroundCallId: "fail", timeout: 0.01 },
      BACKGROUND_CONTEXT,
    );
    expect(result).toMatchObject({ ok: false, error: { code } });
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("preserves a moved receipt when the final output callback fails after promotion", async () => {
    let promoted = false;
    const flush = OutputCapture.prototype.flush;
    vi.spyOn(OutputCapture.prototype, "flush").mockImplementation(function (this: OutputCapture) {
      if (promoted) throw new Error("final callback failed");
      return flush.call(this);
    });
    const env = new NodeExecutionEnv({
      cwd: await workspace(),
      foregroundExecutor: async (input) => {
        const result = await childExecutor(true)(input);
        promoted = true;
        return result;
      },
    });
    const [bash] = createSessionTools({ tools: { tools: ["execute"] } }, env);
    const result = await bash!.execute("late-callback", { command: "printf before-move" });
    expect(text(result)).toContain("Moved command to background shell moved-1.");
    expect(text(result)).toContain("Output capture was interrupted. Use shell_output");
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("preserves a moved receipt when spill creation fails after promotion", async () => {
    const spill = Promise.withResolvers<never>();
    const env = new NodeExecutionEnv({
      cwd: await workspace(),
      foregroundExecutor: async (input) => {
        // Keep this real child's pipes draining while the deliberately pending spill
        // simulates a host handoff before disk completion.
        const result = await childExecutor(true)({
          ...input,
          onReady: () => input.onReady({ pauseOutput() {}, resumeOutput() {} }),
        });
        spill.reject(new Error("spill failed after move"));
        return result;
      },
    });
    vi.spyOn(env, "createTempFile").mockReturnValue(spill.promise);
    const [bash] = createSessionTools({ tools: { tools: ["execute"] } }, env);
    const result = await bash!.execute("late-spill", {
      command: "head -c 60000 /dev/zero | tr '\\0' x",
    });
    expect(text(result)).toContain("Moved command to background shell moved-1.");
    expect(text(result)).toContain("Output capture was interrupted. Use shell_output");
    expect(text(result)).not.toContain("Full output: undefined");
    expect(result.details).toMatchObject({ truncation: { truncated: true } });
    expect(result.details).not.toHaveProperty("fullOutputPath", expect.any(String));
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("keeps callback failures ahead of cancellation, and passes cancellation to the host", async () => {
    const cwd = await workspace();
    const aborted = new AbortController();
    const pending = new NodeExecutionEnv({
      cwd,
      foregroundExecutor: async () => {
        aborted.abort();
        throw new Error("Command aborted");
      },
    });
    expect(
      await pending.exec(
        "true",
        { foregroundCallId: "abort" },
        withAbortSignal(aborted.signal, BACKGROUND_CONTEXT),
      ),
    ).toMatchObject({ ok: false, error: { code: "aborted" } });
    const failed = new NodeExecutionEnv({ cwd, foregroundExecutor: failingCaptureExecutor });
    expect(
      await failed.exec(
        "true",
        {
          foregroundCallId: "callback",
          onUpdate: () => {
            throw new Error("callback failed");
          },
        },
        BACKGROUND_CONTEXT,
      ),
    ).toMatchObject({ ok: false, error: { code: "callback_error" } });
    await pending.cleanup(BACKGROUND_CONTEXT);
    await failed.cleanup(BACKGROUND_CONTEXT);
  });
});
