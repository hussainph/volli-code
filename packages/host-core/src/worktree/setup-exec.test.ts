import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { listTicketEvents } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { readEnvironmentRun } from "./environment-runs";
import { isFirstRunPending, markFirstRunPending, workingCopyRecordPath } from "./first-run";
import { retryWorktreeSetup, startWorktreeSetupAnyway } from "./setup-gate";
import { resetPhasesForTest } from "./phase";
import { runPendingWorktreeSetup } from "./setup-exec";
import type { WorktreePhase, WorktreePorts } from "./types";

let ctx: TestDb;
let dirs: string[] = [];
let phases: WorktreePhase[];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-setup-exec-${prefix}-`));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  ctx = openTestDb();
  resetPhasesForTest();
  phases = [];
  const project = testProject({ id: "p" });
  insertProject(ctx.db, project);
  insertTicket(ctx.db, testTicket(project.id, { id: "t" }));
});

afterEach(() => {
  ctx.cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A worktree that still owes its setup run, and the deps to run it with. */
function pendingWorktree() {
  const home = tempDir("home");
  const worktreePath = tempDir("wt");
  markFirstRunPending({ home }, worktreePath, "t", ["setup"]);
  const deps: WorktreePorts = {
    db: ctx.db,
    gitAsync: async () => "",
    home,
    blobsRoot: "unused",
    onPhase: (_ticketId, phase) => phases.push(phase),
  };
  const params = (setupCommand: string | null, shellPath = "/bin/sh") => ({
    ticketId: "t",
    worktreePath,
    setupCommand,
    environment: async () => ({
      shellPath,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    }),
  });
  return { home, worktreePath, deps, params };
}

describe("runPendingWorktreeSetup", () => {
  it("runs the setup command in the worktree before it resolves, then never again", async () => {
    const { home, worktreePath, deps, params } = pendingWorktree();

    expect(await runPendingWorktreeSetup(deps, params("touch .setup-ran"))).toEqual({
      kind: "succeeded",
    });

    expect(existsSync(join(worktreePath, ".setup-ran"))).toBe(true);
    expect(phases).toEqual(["setting-up", "ready"]);
    expect(isFirstRunPending({ home }, worktreePath, "setup")).toBe(false);
    rmSync(join(worktreePath, ".setup-ran"));
    expect(await runPendingWorktreeSetup(deps, params("touch .setup-ran"))).toEqual({
      kind: "skipped",
    });
    expect(existsSync(join(worktreePath, ".setup-ran"))).toBe(false);
  });

  it("runs it once for two starts racing one new worktree, and both wait for it", async () => {
    const { worktreePath, deps, params } = pendingWorktree();
    const command = "echo run >> runs.txt";

    const [a, b] = await Promise.all([
      runPendingWorktreeSetup(deps, params(command)),
      runPendingWorktreeSetup(deps, params(command)),
    ]);

    expect(a).toEqual({ kind: "succeeded" });
    expect(b).toEqual({ kind: "succeeded" });
    expect(readFileSync(join(worktreePath, "runs.txt"), "utf8")).toBe("run\n");
  });

  it("reports a failing command with its exit code and output on the ticket, and does not retry it", async () => {
    const { worktreePath, deps, params } = pendingWorktree();

    const outcome = await runPendingWorktreeSetup(
      deps,
      params("echo installing; echo 'lockfile is stale'; exit 3"),
    );

    expect(outcome).toEqual({
      kind: "failed",
      message: "The project's setup command exited with code 3: lockfile is stale",
    });
    expect(phases).toEqual(["setting-up", "failed"]);
    const failed = listTicketEvents(ctx.db, "t").find((e) => e.payload.kind === "worktree_failed");
    expect(failed?.payload).toMatchObject({ kind: "worktree_failed", stage: "setup" });
    const stderr = (failed!.payload as { stderr: string }).stderr;
    expect(stderr).toContain("lockfile is stale");
    expect(stderr).toContain("[setup command exited with code 3]");
    // At-most-once: the Retry starts without running it again.
    expect(await runPendingWorktreeSetup(deps, params(`touch ran-again`))).toEqual({
      kind: "skipped",
    });
    expect(existsSync(join(worktreePath, "ran-again"))).toBe(false);
  });

  it("reports a shell that cannot start as a failed setup", async () => {
    const { deps, params } = pendingWorktree();

    const outcome = await runPendingWorktreeSetup(deps, params("true", "/volli-no-such-shell"));

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.message).toMatch(/could not start/);
    expect(phases).toEqual(["setting-up", "failed"]);
  });

  it("consumes a pending run when no command is configured any more, running nothing", async () => {
    const { home, worktreePath, deps, params } = pendingWorktree();

    expect(await runPendingWorktreeSetup(deps, params("   "))).toEqual({ kind: "skipped" });

    expect(isFirstRunPending({ home }, worktreePath, "setup")).toBe(false);
    expect(phases).toEqual([]);
  });

  it("runs nothing for a worktree that owes no setup", async () => {
    const { deps, params } = pendingWorktree();
    const fresh = tempDir("other-wt");

    expect(
      await runPendingWorktreeSetup(deps, { ...params("touch .setup-ran"), worktreePath: fresh }),
    ).toEqual({ kind: "skipped" });
    expect(existsSync(join(fresh, ".setup-ran"))).toBe(false);
  });

  it("stops a command that outlives its deadline, with everything it started, and says so", async () => {
    const { worktreePath, deps, params } = pendingWorktree();

    const outcome = await runPendingWorktreeSetup(deps, {
      ...params("(sleep 1; touch late-child) & sleep 1; touch late"),
      deadlineMs: 300,
    });

    expect(outcome).toEqual({
      kind: "failed",
      message: "The project's setup command did not finish within 300 ms and was stopped.",
    });
    expect(phases).toEqual(["setting-up", "failed"]);
    // SIGTERM reached the group: neither the shell nor its child finishes.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(join(worktreePath, "late"))).toBe(false);
    expect(existsSync(join(worktreePath, "late-child"))).toBe(false);
  });

  it("finishes when the shell exits, though a background process it left holds the output open", async () => {
    const { deps, params } = pendingWorktree();
    const started = Date.now();

    const outcome = await runPendingWorktreeSetup(deps, params("echo ready; sleep 5 &"));

    expect(outcome).toEqual({ kind: "succeeded" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("names a missing worktree directory rather than blaming the shell", async () => {
    const { worktreePath, deps, params } = pendingWorktree();
    rmSync(worktreePath, { recursive: true });

    expect(await runPendingWorktreeSetup(deps, params("true"))).toEqual({
      kind: "failed",
      message: "The project's setup command could not start: the worktree directory is missing.",
    });
  });

  it("keeps a run owed and says why when the claim itself fails", async () => {
    const { home, worktreePath, deps, params } = pendingWorktree();
    // A directory where the marker file should be: unlink fails with EPERM/EISDIR.
    const markerDir = join(home, ".volli", "worktree-first-run");
    const [marker] = readdirSync(markerDir);
    rmSync(join(markerDir, marker!));
    mkdirSync(join(markerDir, marker!));

    const outcome = await runPendingWorktreeSetup(deps, params("touch .setup-ran"));

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.message).toMatch(/could not be claimed/);
    expect(existsSync(join(worktreePath, ".setup-ran"))).toBe(false);
  });
});

/** Writes the working copy's `.agents/setup`. */
function withRecipe(worktreePath: string, body: string, mode = 0o755): void {
  mkdirSync(join(worktreePath, ".agents"), { recursive: true });
  writeFileSync(join(worktreePath, ".agents", "setup"), body);
  chmodSync(join(worktreePath, ".agents", "setup"), mode);
}

// VC-584: with environment recipes on, the claimed run is the working copy's
// recipe, its outcome is a fact of the working copy, and a failed one gates.
describe("runPendingWorktreeSetup with environment recipes", () => {
  const recipe = { projectId: "p", ticketDisplayId: "VC-7", runnerKind: "linux" as const };

  it("runs the repository's .agents/setup instead of the stored command, with the recipe's variables", async () => {
    const { home, worktreePath, deps, params } = pendingWorktree();
    withRecipe(
      worktreePath,
      '#!/bin/sh\nprintf "%s %s %s %s" "$VOLLI_RUNNER_KIND" "$VOLLI_TICKET" "$VOLLI_SETUP_REASON" "$(pwd)" > env.txt\n',
    );

    const outcome = await runPendingWorktreeSetup(deps, {
      ...params("touch stored-ran"),
      recipe,
      now: () => 42,
    });

    expect(outcome).toEqual({ kind: "succeeded" });
    expect(existsSync(join(worktreePath, "stored-ran"))).toBe(false);
    expect(readFileSync(join(worktreePath, "env.txt"), "utf8")).toMatch(
      /^linux VC-7 new-working-copy .+/,
    );
    expect(readEnvironmentRun({ home }, worktreePath, "setup")).toMatchObject({
      script: "setup",
      source: "repo",
      reason: "new-working-copy",
      runnerKind: "linux",
      ticketId: "t",
      startedAt: 42,
      endedAt: 42,
      outcome: "succeeded",
      exitCode: 0,
      summary: "`.agents/setup` succeeded.",
    });
    expect(phases).toEqual(["setting-up", "ready"]);
  });

  it("falls back to the stored command and records it, and records nothing when there is neither", async () => {
    const { home, worktreePath, deps, params } = pendingWorktree();

    expect(await runPendingWorktreeSetup(deps, { ...params("touch stored-ran"), recipe })).toEqual({
      kind: "succeeded",
    });
    expect(existsSync(join(worktreePath, "stored-ran"))).toBe(true);
    expect(readEnvironmentRun({ home }, worktreePath, "setup")).toMatchObject({
      source: "legacyCommand",
      summary: "The project's setup command succeeded.",
    });

    const other = pendingWorktree();
    expect(await runPendingWorktreeSetup(other.deps, { ...other.params(null), recipe })).toEqual({
      kind: "skipped",
    });
    expect(readEnvironmentRun({ home: other.home }, other.worktreePath, "setup")).toBeNull();
  });

  it("stops what setup left running when it exits", async () => {
    const { worktreePath, deps, params } = pendingWorktree();
    withRecipe(worktreePath, "(sleep 1; touch leftover) &\necho done\n", 0o644);

    expect(await runPendingWorktreeSetup(deps, { ...params(null), recipe })).toEqual({
      kind: "succeeded",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(join(worktreePath, "leftover"))).toBe(false);
  });

  it("blocks every later start with the failed run's reason until Start anyway, then Retry runs it again", async () => {
    const { home, worktreePath, deps, params } = pendingWorktree();
    withRecipe(worktreePath, "#!/bin/sh\necho 'pnpm: not found'\nexit 127\n");

    const failed = await runPendingWorktreeSetup(deps, { ...params(null), recipe });
    expect(failed).toMatchObject({
      kind: "failed",
      message: "`.agents/setup` exited with code 127: pnpm: not found",
      run: { outcome: "failed", exitCode: 127, tail: "pnpm: not found\n" },
    });
    const event = listTicketEvents(ctx.db, "t").find((e) => e.payload.kind === "worktree_failed");
    expect((event!.payload as { stderr: string }).stderr).toContain(
      "[.agents/setup exited with code 127]",
    );

    // The gate: refused again, with the same reason, and nothing is recorded again.
    const events = listTicketEvents(ctx.db, "t").length;
    const blocked = await runPendingWorktreeSetup(deps, { ...params(null), recipe });
    expect(blocked).toMatchObject({
      kind: "failed",
      message:
        "Environment setup failed: `.agents/setup` exited with code 127: pnpm: not found. Retry setup, or start anyway.",
    });
    expect(listTicketEvents(ctx.db, "t")).toHaveLength(events);

    startWorktreeSetupAnyway({ home }, worktreePath, 1);
    expect(await runPendingWorktreeSetup(deps, { ...params(null), recipe })).toEqual({
      kind: "skipped",
    });

    // Retry: the next start runs it again, as a retry.
    withRecipe(worktreePath, '#!/bin/sh\nprintf %s "$VOLLI_SETUP_REASON" > reason.txt\n');
    retryWorktreeSetup({ home }, worktreePath, "t");
    expect(await runPendingWorktreeSetup(deps, { ...params(null), recipe })).toEqual({
      kind: "succeeded",
    });
    expect(readFileSync(join(worktreePath, "reason.txt"), "utf8")).toBe("retry");
    expect(await runPendingWorktreeSetup(deps, { ...params(null), recipe })).toEqual({
      kind: "skipped",
    });
  });

  it("records a timed-out recipe as timed out", async () => {
    const { home, worktreePath, deps, params } = pendingWorktree();
    withRecipe(worktreePath, "sleep 5\n", 0o644);

    const outcome = await runPendingWorktreeSetup(deps, {
      ...params(null),
      recipe,
      deadlineMs: 200,
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      message: "`.agents/setup` did not finish within 200 ms and was stopped.",
    });
    expect(readEnvironmentRun({ home }, worktreePath, "setup")).toMatchObject({
      outcome: "timed_out",
      exitCode: null,
    });
  });

  it("fails the start, and records the fact, when the environment cannot be had", async () => {
    const { home, worktreePath, deps, params } = pendingWorktree();
    withRecipe(worktreePath, "true\n");

    const outcome = await runPendingWorktreeSetup(deps, {
      ...params(null),
      recipe,
      environment: async () => {
        throw new Error("no PATH yet");
      },
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      message: "`.agents/setup` could not start (no PATH yet).",
    });
    expect(readEnvironmentRun({ home }, worktreePath, "setup")).toMatchObject({
      outcome: "failed",
      exitCode: null,
    });
  });

  it("refuses rather than reads nothing when the run record is unreadable", async () => {
    const { home, worktreePath, deps, params } = pendingWorktree();
    await runPendingWorktreeSetup(deps, { ...params("false"), recipe });
    writeFileSync(workingCopyRecordPath({ home }, worktreePath, "setup-run.json"), "{");

    const outcome = await runPendingWorktreeSetup(deps, { ...params(null), recipe });

    expect(outcome).toMatchObject({ kind: "failed" });
    if (outcome.kind === "failed") {
      expect(outcome.message).toMatch(/^The environment setup record could not be read/);
    }
  });

  it("names a recipe that cannot be read, keeping the stored command from running in its place", async () => {
    const { worktreePath, deps, params } = pendingWorktree();
    withRecipe(worktreePath, "true\n", 0o000);

    const outcome = await runPendingWorktreeSetup(deps, { ...params("touch stored-ran"), recipe });

    // Root reads anything; the claim was still consumed either way.
    if (outcome.kind === "failed") {
      expect(outcome.message).toMatch(/could not be read/);
      expect(existsSync(join(worktreePath, "stored-ran"))).toBe(false);
    }
  });
});

describe("markFirstRunPending", () => {
  it("records exactly the steps it is given, clearing one an earlier attempt left", () => {
    const home = tempDir("home");
    const worktreePath = join(tempDir("parent"), "not-created-yet");

    markFirstRunPending({ home }, worktreePath, "t", ["copy", "setup"]);
    markFirstRunPending({ home }, worktreePath, "t", ["copy"]);

    expect(isFirstRunPending({ home }, worktreePath, "copy")).toBe(true);
    expect(isFirstRunPending({ home }, worktreePath, "setup")).toBe(false);
  });
});
