/**
 * The window the review's C3 names: the folder is already gone and the outcome
 * was never written. These cases stop the app in exactly that instant — after a
 * real `git worktree remove`, before the fact lands — and then ask what the
 * next launch says about it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { OrphanCleanupPlanItem } from "@volli/shared";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { cleanupOrphans } from "./cleanup";
import { createOrphanCleanupEngine, type OrphanCleanupEngine } from "./cleanup-engine";
import { SqliteOrphanCleanupLedger } from "./cleanup-ledger";
import { reconcileInterruptedCleanups } from "./cleanup-recovery";
import { projectContainerName } from "./containers";
import { resetDeletionLeasesForTest } from "./deletion-lease";
import { scriptedGit } from "./scripted-git";
import type { WorktreeDeps } from "./types";

let ctx: TestDb;
let tempDirs: string[] = [];
let engine: OrphanCleanupEngine;
let minted = 0;

const DAY_MS = 24 * 60 * 60 * 1000;
const REAL_GIT_TIMEOUT_MS = 30_000;

beforeEach(() => {
  ctx = openTestDb();
  minted = 0;
  engine = createOrphanCleanupEngine({
    ledger: new SqliteOrphanCleanupLedger(ctx.db),
    now: () => 1_000 + minted,
    nextId: () => `id-${(minted += 1)}`,
  });
  resetDeletionLeasesForTest();
});

afterEach(() => {
  ctx.cleanup();
  resetDeletionLeasesForTest();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function runRepoGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Volli Test",
      GIT_AUTHOR_EMAIL: "test@volli.local",
      GIT_COMMITTER_NAME: "Volli Test",
      GIT_COMMITTER_EMAIL: "test@volli.local",
    },
  });
}

/** A real project with one real orphan worktree inside a container this db owns. */
function realFixture(): { deps: WorktreeDeps; projectPath: string; orphan: string } {
  const home = tempDir("home");
  const originPath = tempDir("origin");
  runRepoGit(originPath, ["init", "-q", "--bare", "-b", "main"]);
  const projectPath = tempDir("proj");
  runRepoGit(projectPath, ["init", "-q", "-b", "main"]);
  writeFileSync(join(projectPath, "README.md"), "base\n");
  runRepoGit(projectPath, ["add", "."]);
  runRepoGit(projectPath, ["commit", "-q", "-m", "base"]);
  runRepoGit(projectPath, ["remote", "add", "origin", originPath]);
  runRepoGit(projectPath, ["push", "-q", "origin", "main"]);
  const container = join(home, ".volli", "worktrees", projectContainerName(projectPath, "proj-1"));
  mkdirSync(container, { recursive: true });
  const orphan = join(container, "VC-7-interrupted");
  runRepoGit(projectPath, ["worktree", "add", "-q", "-b", "volli/VC-7", orphan]);
  // Pushed, so nothing about it reads as unsaved work: the preservation rules
  // are not what these cases are about.
  runRepoGit(projectPath, ["push", "-q", "origin", "volli/VC-7"]);
  insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
  const { git } = scriptedGit((args, cwd) => runRepoGit(cwd, args));
  return {
    projectPath,
    orphan,
    deps: {
      db: ctx.db,
      git,
      home,
      now: () => Date.now() + 400 * DAY_MS,
      blobsRoot: "unused",
    },
  };
}

function item(path: string, projectPath: string): OrphanCleanupPlanItem {
  return {
    id: "rev1:worktree:0",
    kind: "worktree",
    path,
    projectId: "proj-1",
    projectName: "Volli",
    projectPath,
    branch: "volli/VC-7",
    gitReason: null,
  };
}

/**
 * The engine, but the outcome write for one item never lands — the app being
 * killed in the microseconds between `git worktree remove` returning and the
 * fact being appended.
 */
function engineThatDiesAfterMutating(target: string): OrphanCleanupEngine {
  return {
    ...engine,
    settleItem: async (input) => {
      if (input.itemId === target) throw new Error("the app stopped");
      await engine.settleItem(input);
    },
  };
}

describe("reconcileInterruptedCleanups", () => {
  it(
    "records a directory that was really removed as completed, not as never attempted",
    async () => {
      const f = realFixture();

      await expect(
        cleanupOrphans(
          { worktree: f.deps, engine: engineThatDiesAfterMutating("rev1:worktree:0") },
          {
            commandId: "cmd-1",
            scanRevision: "rev1",
            items: [item(f.orphan, f.projectPath)],
            source: "settings",
          },
        ),
      ).rejects.toThrow("the app stopped");

      // The world: the folder is gone. The record: nobody wrote the outcome.
      expect(existsSync(f.orphan)).toBe(false);
      const midFlight = (await engine.recentRuns())[0];
      expect(midFlight?.items[0]?.state).toBe("executing");
      expect(midFlight?.finishedAt).toBeNull();

      const [reconciled] = await reconcileInterruptedCleanups({ worktree: f.deps, engine });

      expect(reconciled?.items[0]?.state).toBe("completed");
      expect(reconciled?.items[0]?.detail).toMatch(/next launch/i);
      expect(reconciled?.interruptedAt).not.toBeNull();
      // A second launch changes nothing: the outcome is a fact now.
      const again = await reconcileInterruptedCleanups({ worktree: f.deps, engine });
      expect(again).toEqual([]);
      expect((await engine.recentRuns())[0]?.items[0]?.state).toBe("completed");
    },
    REAL_GIT_TIMEOUT_MS,
  );

  it(
    "records a directory that is demonstrably still there as failed",
    async () => {
      const f = realFixture();
      // Announced, but the mutation never ran.
      await engine.accept({
        commandId: "cmd-1",
        source: "settings",
        scanRevision: "rev1",
        retentionDays: 14,
        preservation: ["branches"],
        items: [item(f.orphan, f.projectPath)],
      });
      await engine.beginItem({ commandId: "cmd-1", itemId: "rev1:worktree:0" });

      const [reconciled] = await reconcileInterruptedCleanups({ worktree: f.deps, engine });

      expect(reconciled?.items[0]?.state).toBe("failed");
      expect(reconciled?.items[0]?.detail).toMatch(/still here/i);
      expect(existsSync(f.orphan)).toBe(true);
    },
    REAL_GIT_TIMEOUT_MS,
  );

  it("says it cannot tell, rather than guessing, when git can no longer be read", async () => {
    const home = tempDir("home");
    const projectPath = tempDir("proj");
    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
    const { git } = scriptedGit(() => {
      throw new Error("not a git repository");
    });
    const deps: WorktreeDeps = { db: ctx.db, git, home, blobsRoot: "unused" };
    const orphan = join(home, "gone");

    await engine.accept({
      commandId: "cmd-1",
      source: "settings",
      scanRevision: "rev1",
      retentionDays: 14,
      preservation: [],
      items: [item(orphan, projectPath)],
    });
    await engine.beginItem({ commandId: "cmd-1", itemId: "rev1:worktree:0" });

    const [reconciled] = await reconcileInterruptedCleanups({ worktree: deps, engine });

    expect(reconciled?.items[0]?.state).toBe("indeterminate");
    expect(reconciled?.items[0]?.detail).toMatch(/Scan again/i);
  });

  it("leaves items that were never attempted as pending, and never rewrites a settled one", async () => {
    const home = tempDir("home");
    const projectPath = tempDir("proj");
    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
    // Git cannot be read at all, so the one announced item is genuinely
    // unresolvable — the honest third answer.
    const { git } = scriptedGit(() => {
      throw new Error("not a git repository");
    });
    const deps: WorktreeDeps = { db: ctx.db, git, home, blobsRoot: "unused" };

    await engine.accept({
      commandId: "cmd-1",
      source: "settings",
      scanRevision: "rev1",
      retentionDays: 14,
      preservation: [],
      items: [
        { ...item(join(home, "one"), projectPath), id: "i1" },
        { ...item(join(home, "two"), projectPath), id: "i2" },
        { ...item(join(home, "three"), projectPath), id: "i3" },
      ],
    });
    await engine.beginItem({ commandId: "cmd-1", itemId: "i1" });
    await engine.settleItem({
      commandId: "cmd-1",
      itemId: "i1",
      state: "completed",
      detail: "Removed the folder.",
    });
    await engine.beginItem({ commandId: "cmd-1", itemId: "i2" });

    const [reconciled] = await reconcileInterruptedCleanups({ worktree: deps, engine });

    expect(reconciled?.items.map((entry) => [entry.id, entry.state])).toEqual([
      // A completed removal is never re-labelled by a recovery pass.
      ["i1", "completed"],
      ["i2", "indeterminate"],
      // Never attempted stays never attempted — the set a person may scan again.
      ["i3", "pending"],
    ]);
    expect(reconciled?.items[0]?.detail).toBe("Removed the folder.");
  });

  it("resolves an announced metadata prune against the project's current stale set", async () => {
    const home = tempDir("home");
    const projectPath = tempDir("proj");
    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
    const stale = join(home, "records", "VC-9");
    let stillStale = true;
    const { git } = scriptedGit(() =>
      stillStale
        ? `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\nworktree ${stale}\nHEAD b\nprunable gitdir file points to non-existent location\n`
        : `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n`,
    );
    const deps: WorktreeDeps = { db: ctx.db, git, home, blobsRoot: "unused" };
    const metadata: OrphanCleanupPlanItem = {
      id: "m1",
      kind: "metadata",
      path: stale,
      projectId: "proj-1",
      projectName: "Volli",
      projectPath,
      branch: null,
      gitReason: "gitdir file points to non-existent location",
    };

    await engine.accept({
      commandId: "cmd-1",
      source: "settings",
      scanRevision: "rev1",
      retentionDays: 14,
      preservation: [],
      items: [metadata],
    });
    await engine.beginItem({ commandId: "cmd-1", itemId: "m1" });
    const stillThere = await reconcileInterruptedCleanups({ worktree: deps, engine });
    expect(stillThere[0]?.items[0]?.state).toBe("failed");

    // The same window, but the prune had in fact landed before the app stopped.
    stillStale = false;
    await engine.accept({
      commandId: "cmd-2",
      source: "settings",
      scanRevision: "rev1",
      retentionDays: 14,
      preservation: [],
      items: [metadata],
    });
    await engine.beginItem({ commandId: "cmd-2", itemId: "m1" });
    const pruned = await reconcileInterruptedCleanups({ worktree: deps, engine });
    expect(pruned[0]?.items[0]?.state).toBe("completed");
    expect(pruned[0]?.items[0]?.detail).toMatch(/next launch/i);
  });

  it("does nothing when every run closed normally", async () => {
    const home = tempDir("home");
    const { git } = scriptedGit(() => "");
    const deps: WorktreeDeps = { db: ctx.db, git, home, blobsRoot: "unused" };
    expect(await reconcileInterruptedCleanups({ worktree: deps, engine })).toEqual([]);
  });
});
