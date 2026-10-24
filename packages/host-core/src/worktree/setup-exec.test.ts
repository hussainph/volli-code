import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { listTicketEvents } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { isFirstRunPending, markFirstRunPending } from "./first-run";
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
  const params = (setupCommand: string | null) => ({
    ticketId: "t",
    worktreePath,
    setupCommand,
    shellPath: "/bin/sh",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
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
    expect(stderr).toContain("[exited with code 3]");
    // At-most-once: the Retry starts without running it again.
    expect(await runPendingWorktreeSetup(deps, params(`touch ran-again`))).toEqual({
      kind: "skipped",
    });
    expect(existsSync(join(worktreePath, "ran-again"))).toBe(false);
  });

  it("reports a shell that cannot start as a failed setup", async () => {
    const { deps, params } = pendingWorktree();

    const outcome = await runPendingWorktreeSetup(deps, {
      ...params("true"),
      shellPath: "/volli-no-such-shell",
    });

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
});
