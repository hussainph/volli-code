import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { openTestDb, type TestDb } from "../db/test-helpers";
import { readEnvironmentRun } from "./environment-runs";
import { resetResumeEpochForTest, runWorktreeResume, watchRunnerWakes } from "./resume-exec";
import type { WorktreePorts } from "./types";
import type { PowerEvent, PowerPort } from "../ports/power";

let ctx: TestDb;
let dirs: string[] = [];
let home: string;
let worktreePath: string;
let deps: WorktreePorts;

/** A wake, as the machine's power port announces one. */
function noteRunnerWake(): void {
  const listeners: (() => void)[] = [];
  watchRunnerWakes({ on: (_event, listener) => listeners.push(listener), removeListener: () => 0 });
  for (const listener of listeners) listener();
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-resume-${prefix}-`));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  ctx = openTestDb();
  resetResumeEpochForTest();
  home = tempDir("home");
  worktreePath = tempDir("wt");
  deps = { db: ctx.db, gitAsync: async () => "", home, blobsRoot: "unused" };
});

afterEach(() => {
  ctx.cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function withResume(body: string, mode = 0o644): void {
  mkdirSync(join(worktreePath, ".agents"), { recursive: true });
  writeFileSync(join(worktreePath, ".agents", "resume"), body);
  chmodSync(join(worktreePath, ".agents", "resume"), mode);
}

const params = (overrides: Partial<Parameters<typeof runWorktreeResume>[1]> = {}) => ({
  ticketId: "t",
  worktreePath,
  recipe: { projectId: "p", ticketDisplayId: "VC-7", runnerKind: "mac" as const },
  environment: async () => ({
    shellPath: "/bin/sh",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
  }),
  ...overrides,
});

describe("runWorktreeResume", () => {
  it("does nothing without a .agents/resume", async () => {
    expect(await runWorktreeResume(deps, params())).toEqual({ kind: "skipped" });
    expect(readEnvironmentRun({ home }, worktreePath, "resume")).toBeNull();
  });

  it("runs once per runner epoch, telling the script why, and again after a wake", async () => {
    withResume('printf "%s\\n" "$VOLLI_RESUME_REASON" >> reasons.txt\n');

    expect(await runWorktreeResume(deps, params())).toEqual({
      kind: "finished",
      ok: true,
      summary: "`.agents/resume` succeeded.",
    });
    expect(await runWorktreeResume(deps, params())).toEqual({ kind: "skipped" });
    noteRunnerWake();
    expect(await runWorktreeResume(deps, params())).toMatchObject({ kind: "finished", ok: true });

    expect(readFileSync(join(worktreePath, "reasons.txt"), "utf8")).toBe("runner-start\nwake\n");
    expect(readEnvironmentRun({ home }, worktreePath, "resume")).toMatchObject({
      script: "resume",
      source: "repo",
      reason: "wake",
      outcome: "succeeded",
    });
  });

  it("starts a new epoch on every wake the power port announces", async () => {
    const listeners = new Map<PowerEvent, () => void>();
    const power: PowerPort = {
      on: (event, listener) => listeners.set(event, listener),
      removeListener: () => undefined,
    };
    watchRunnerWakes(power);
    watchRunnerWakes(power);
    withResume("echo >> runs.txt\n");

    await runWorktreeResume(deps, params());
    listeners.get("resume")!();
    await runWorktreeResume(deps, params());

    expect(readFileSync(join(worktreePath, "runs.txt"), "utf8")).toBe("\n\n");
  });

  it("reports a failure as a warning outcome and records it", async () => {
    withResume("echo 'docker: not running'\nexit 2\n");

    expect(await runWorktreeResume(deps, params())).toEqual({
      kind: "finished",
      ok: false,
      summary: "`.agents/resume` exited with code 2.",
    });
    expect(readEnvironmentRun({ home }, worktreePath, "resume")).toMatchObject({
      outcome: "failed",
      exitCode: 2,
      tail: "docker: not running\n",
    });
  });

  it("lets a slow resume run on in the background, and what it starts outlives it", async () => {
    withResume("sleep 0.6\n(sleep 0.3; touch service-up) &\ntouch resumed\n");

    expect(await runWorktreeResume(deps, params({ waitMs: 100 }))).toEqual({
      kind: "background",
    });
    expect(existsSync(join(worktreePath, "resumed"))).toBe(false);
    // A second start in the same epoch waits for the shared run, not a new one.
    expect(await runWorktreeResume(deps, params())).toEqual({ kind: "skipped" });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(existsSync(join(worktreePath, "resumed"))).toBe(true);
    expect(existsSync(join(worktreePath, "service-up"))).toBe(true);
  });

  it("warns when the environment cannot be had or the script cannot start", async () => {
    withResume("true\n");
    expect(
      await runWorktreeResume(
        deps,
        params({
          environment: async () => {
            throw new Error("no PATH");
          },
        }),
      ),
    ).toEqual({ kind: "finished", ok: false, summary: "`.agents/resume` could not start." });

    noteRunnerWake();
    withResume("#!/volli-no-such-interpreter\n", 0o755);
    expect(await runWorktreeResume(deps, params())).toMatchObject({
      kind: "finished",
      ok: false,
      summary: expect.stringMatching(/could not start/),
    });
  });
});
