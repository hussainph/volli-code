import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

// `scripts/deploy.mjs` is the entry `pnpm -C convex deploy:checked` runs: it
// hands the real `deployChecked` a CLI that spawns the pinned `convex`. Only
// the process boundary is stood in for: `spawn`, `process.exit` and stderr.
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

type Answer = { code?: number | null; stdout?: string; error?: Error };
type Spawned = { command: string; args: string[]; options: { cwd: string; stdio: unknown } };

/** Each spawn answers with the next `answers` entry, after its listeners are attached. */
function answerSpawns(answers: Answer[]): Spawned[] {
  const spawned: Spawned[] = [];
  spawn.mockImplementation(
    (command: string, args: string[], options: { cwd: string; stdio: unknown }) => {
      spawned.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), {
        // A real child has no stdout pipe when its stdio is inherited.
        stdout: options.stdio === "inherit" ? null : new EventEmitter(),
      });
      const answer = answers.shift() ?? { code: 0 };
      setImmediate(() => {
        if (answer.error) {
          child.emit("error", answer.error);
          return;
        }
        // A real child can exit before its stdout drains: `exit`, then the data, then `close`.
        const code = answer.code ?? null;
        const signal = answer.code === null ? "SIGTERM" : null;
        child.emit("exit", code, signal);
        if (answer.stdout !== undefined) child.stdout?.emit("data", Buffer.from(answer.stdout));
        child.emit("close", code, signal);
      });
      return child;
    },
  );
  return spawned;
}

const argv = process.argv;
let exit: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

/** Evaluates the entry afresh with `args`, as `node scripts/deploy.mjs …args` would. */
async function runEntry(args: string[]): Promise<void> {
  const entry = join(PACKAGE_DIR, "scripts/deploy.mjs");
  process.argv = [process.execPath, entry, ...args];
  vi.resetModules();
  // By path: the entry is plain JavaScript with no declarations for tsc to read.
  await import(/* @vite-ignore */ entry);
}

beforeEach(() => {
  spawn.mockReset();
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("CONVEX_DEPLOY_KEY", "");
  vi.stubEnv("CONVEX_SELF_HOSTED_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SELF_HOSTED_ADMIN_KEY", "volli-test|redacted");
});

afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("scripts/deploy.mjs", () => {
  test("runs each step through the pinned CLI, capturing only the preflight", async () => {
    const spawned = answerSpawns([{ code: 0, stdout: "" }, { code: 0 }, { code: 0 }]);
    await runEntry([]);
    expect(exit).toHaveBeenCalledWith(0);
    expect(spawned.map(({ args }) => args.slice(1))).toEqual([
      ["env", "get", "VOLLI_TEST_JWKS"],
      ["deploy", "--codegen", "disable"],
      ["run", "health:deploymentChecks", '{"mode":"cloud"}'],
    ]);
    for (const { command, args, options } of spawned) {
      expect(command).toBe(process.execPath);
      expect(args[0]).toMatch(/[/\\]convex[/\\]bin[/\\]main\.js$/);
      expect(options.cwd).toBe(PACKAGE_DIR);
    }
    expect(spawned.map(({ options }) => options.stdio)).toEqual([
      ["ignore", "pipe", "inherit"],
      "inherit",
      "inherit",
    ]);
  });

  test("reads the preflight's output to the end, even after the child exits", async () => {
    answerSpawns([{ code: 0, stdout: "data:application/json;base64,e30=\n" }]);
    await runEntry([]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^\[convex-deploy\] .*TEST_JWKS/));
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("data:");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("a step killed by a signal (no exit code) fails the deploy", async () => {
    answerSpawns([{ code: null }]);
    await runEntry(["--test"]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("a CLI that cannot start rejects, and nothing exits as if it had run", async () => {
    answerSpawns([{ error: new Error("spawn ENOENT") }]);
    await expect(runEntry(["--test"])).rejects.toThrow("spawn ENOENT");
    expect(exit).not.toHaveBeenCalled();
  });

  test("a usage error spawns nothing and says why on stderr", async () => {
    await runEntry(["--prod"]);
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^\[convex-deploy\] usage:/));
    expect(spawn).not.toHaveBeenCalled();
  });
});
