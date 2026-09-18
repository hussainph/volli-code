/**
 * The ticketId-in read verbs (read.ts), and the one property that is not
 * visible in their return values: they must not block Electron main.
 *
 * ## Why an event-loop probe rather than a spy (VC-369)
 *
 * "Is this read on the async runner" is exactly the kind of claim a mock will
 * happily confirm while production freezes: `readWorktreeStatus` used to take a
 * `RunGit` and every suite handed it a scripted synchronous function, so the
 * five `execFileSync` children it really spawned were invisible here. The freeze
 * was reported as the whole app rainbow-wheeling when a ticket workspace opened,
 * which is main blocked, not a slow renderer.
 *
 * So the test below measures the thing itself: a `git` shim first on PATH that
 * sleeps, a 10ms timer, and the worst gap between ticks. The CONTROL arm runs
 * the synchronous runner under the identical shim and asserts the loop IS
 * starved — without it, "lag stayed low" could pass because the probe cannot
 * detect blocking at all. Measured before the fix: the sync read starved the
 * loop for its entire 1.6s, the 10ms timer firing zero times.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { runGitCapturing } from "./git";
import { readWorktreeDiff, readWorktreeStatus, resolveWorktreeTarget } from "./read";
import { scriptedGit } from "./scripted-git";

let ctx: TestDb;
let tempDirs: string[] = [];
let originalPath: string | undefined;

beforeEach(() => {
  ctx = openTestDb();
  originalPath = process.env["PATH"];
});

afterEach(() => {
  ctx.cleanup();
  if (originalPath !== undefined) process.env["PATH"] = originalPath;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** How long each scripted git child takes. Five of them per status read. */
const GIT_DELAY_MS = 80;

/**
 * Puts a `git` first on PATH that sleeps, then answers each status probe
 * plausibly enough to parse. Real spawns, so both runners are measured against
 * the same cost.
 */
function slowGitOnPath(delayMs: number): void {
  const binDir = tempDir("slow-git-bin");
  const shim = join(binDir, "git");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `sleep ${(delayMs / 1000).toFixed(3)}`,
      'case "$1" in',
      "  status) printf 'M file.ts\\n' ;;",
      "  rev-parse) printf '.git\\n' ;;",
      "  rev-list) printf '0\\t0\\n' ;;",
      "  diff) printf '1\\t0\\tfile.ts\\n' ;;",
      "  *) printf '' ;;",
      "esac",
      "exit 0",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);
  process.env["PATH"] = `${binDir}:${originalPath ?? ""}`;
}

/** Runs `work` while a 10ms timer ticks; reports the worst gap and the tick count. */
async function eventLoopLagDuring(
  work: () => void | Promise<void>,
): Promise<{ maxLag: number; ticks: number; wall: number }> {
  const gaps: number[] = [];
  const started = performance.now();
  let last = started;
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 10);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  const wall = performance.now() - started;
  // No tick at all is the WORST case, not a missing measurement: the loop never
  // got a turn for the whole read, so the lag is at least the wall time.
  return { maxLag: gaps.length > 0 ? Math.max(...gaps) : wall, ticks: gaps.length, wall };
}

/** A git that answers every status probe clean. */
const cleanGit = () =>
  scriptedGit((args) => {
    if (args[0] === "status") return "";
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git\n";
    if (args[0] === "rev-list" && args[1] === "--left-right") return "0\t0\n";
    return "";
  });

/** A ticket stamped with a real on-disk worktree, so the reads reach git. */
function stampTicket(): void {
  const worktreePath = tempDir("wt");
  mkdirSync(join(worktreePath, ".git"), { recursive: true });
  insertProject(ctx.db, testProject({ id: "p1", ticketPrefix: "VC", baseBranch: "main" }));
  insertTicket(
    ctx.db,
    testTicket("p1", {
      id: "t1",
      ticketNumber: 369,
      worktreePath,
      branch: "volli/VC-369-x",
      baseBranch: "main",
      usesWorktree: true,
    }),
  );
}

describe("the rail reads leave Electron main responsive", () => {
  it("CONTROL: the synchronous runner starves the loop under the same shim", async () => {
    slowGitOnPath(GIT_DELAY_MS);

    const { maxLag, ticks, wall } = await eventLoopLagDuring(() => {
      // The five children one status read spawns, through the sync runner.
      runGitCapturing(["status", "--porcelain"], process.cwd());
      runGitCapturing(["rev-parse", "--git-dir"], process.cwd());
      runGitCapturing(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], ".");
      runGitCapturing(["rev-list", "--left-right", "--count", "a...b"], process.cwd());
      runGitCapturing(["rev-list", "--count", "a..b"], process.cwd());
    });

    // The probe can see blocking: the timer never ran, so the lag is the whole
    // span. This is what the rail's status read did before VC-369.
    expect(ticks).toBe(0);
    expect(maxLag).toBeGreaterThanOrEqual(wall * 0.9);
  });

  it("readWorktreeStatus keeps the event loop turning while git runs", async () => {
    slowGitOnPath(GIT_DELAY_MS);
    stampTicket();

    const { maxLag, ticks, wall } = await eventLoopLagDuring(async () => {
      const read = await readWorktreeStatus({ db: ctx.db }, "t1");
      expect(read.kind).toBe("ok");
    });

    // Real git children still take their time; what changed is that main is
    // free between and during them.
    expect(wall).toBeGreaterThan(GIT_DELAY_MS);
    expect(ticks).toBeGreaterThan(10);
    expect(maxLag).toBeLessThan(GIT_DELAY_MS);
  });

  it("readWorktreeDiff keeps the event loop turning while git runs", async () => {
    slowGitOnPath(GIT_DELAY_MS);
    stampTicket();

    const { maxLag, ticks } = await eventLoopLagDuring(async () => {
      const read = await readWorktreeDiff({ db: ctx.db }, "t1", "working-tree");
      expect(read.kind).toBe("ok");
    });

    expect(ticks).toBeGreaterThan(5);
    expect(maxLag).toBeLessThan(GIT_DELAY_MS);
  });
});

/**
 * The contracts VC-369 had to preserve exactly. It moved the runner, not the
 * meaning: every discriminated arm, the errs-dirty rule, and the degrade-to-null
 * counts must read the same as they did on `execFileSync`.
 */
describe("read verb contracts are unchanged by the async runner", () => {
  it("discriminates a missing ticket", async () => {
    const { gitAsync } = cleanGit();
    expect(await readWorktreeStatus({ db: ctx.db, gitAsync }, "nope")).toEqual({
      kind: "missing-ticket",
    });
    expect(await readWorktreeDiff({ db: ctx.db, gitAsync }, "nope", "merge-base")).toEqual({
      kind: "missing-ticket",
    });
  });

  it("discriminates a worktree-scoped ticket that has none yet", async () => {
    const { gitAsync } = cleanGit();
    insertProject(ctx.db, testProject({ id: "p1", ticketPrefix: "VC" }));
    insertTicket(ctx.db, testTicket("p1", { id: "t1", ticketNumber: 7, usesWorktree: true }));

    expect(await readWorktreeStatus({ db: ctx.db, gitAsync }, "t1")).toMatchObject({
      kind: "no-worktree",
      displayId: "VC-7",
      usesWorktree: true,
    });
  });

  it("discriminates a stamped-but-deleted worktree instead of erring dirty", async () => {
    const { gitAsync, calls } = cleanGit();
    insertProject(ctx.db, testProject({ id: "p1", ticketPrefix: "VC" }));
    insertTicket(
      ctx.db,
      testTicket("p1", {
        id: "t1",
        ticketNumber: 8,
        worktreePath: "/gone/VC-8",
        usesWorktree: true,
      }),
    );

    expect(await readWorktreeStatus({ db: ctx.db, gitAsync }, "t1")).toMatchObject({
      kind: "missing-on-disk",
      displayId: "VC-8",
      worktreePath: "/gone/VC-8",
    });
    // The whole point of the arm: a deleted path never reaches git, so it can
    // never come back as the errs-dirty `uncommitted: true` lie.
    expect(calls).toHaveLength(0);
  });

  it("errs dirty: a failing status read still reports uncommitted", async () => {
    const worktreePath = tempDir("wt");
    insertProject(ctx.db, testProject({ id: "p1", ticketPrefix: "VC" }));
    insertTicket(
      ctx.db,
      testTicket("p1", {
        id: "t1",
        ticketNumber: 9,
        worktreePath,
        branch: "b",
        baseBranch: "main",
      }),
    );
    const { gitAsync } = scriptedGit(() => {
      throw new Error("git is broken");
    });

    const read = await readWorktreeStatus({ db: ctx.db, gitAsync }, "t1");
    expect(read).toMatchObject({
      kind: "ok",
      status: {
        uncommitted: true,
        sequencerActive: false,
        aheadOfBase: null,
        behindBase: null,
        unpushed: null,
      },
    });
  });

  it("surfaces a diff failure as diff-error with git's own message", async () => {
    const worktreePath = tempDir("wt");
    insertProject(ctx.db, testProject({ id: "p1", ticketPrefix: "VC" }));
    insertTicket(
      ctx.db,
      testTicket("p1", { id: "t1", ticketNumber: 10, worktreePath, baseBranch: "main" }),
    );
    const { gitAsync } = scriptedGit(() => {
      throw new Error("fatal: bad revision");
    });

    expect(await readWorktreeDiff({ db: ctx.db, gitAsync }, "t1", "merge-base")).toMatchObject({
      kind: "diff-error",
      displayId: "VC-10",
    });
  });
});

/**
 * The path-only resolution. `worktree-change-watch` wants one string and used to
 * run the whole five-child status read to get it (VC-369).
 */
describe("resolveWorktreeTarget", () => {
  it("answers the on-disk identity without spawning git", () => {
    stampTicket();
    const { git, calls } = scriptedGit(() => "");

    const resolved = resolveWorktreeTarget({ db: ctx.db, git }, "t1");

    expect(resolved).toMatchObject({
      kind: "ok",
      target: { displayId: "VC-369", branch: "volli/VC-369-x", baseBranch: "main" },
    });
    expect(calls).toHaveLength(0);
  });
});
