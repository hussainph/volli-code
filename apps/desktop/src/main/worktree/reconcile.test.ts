import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { GitError } from "./git";
import { reconcile } from "./reconcile";
import { scriptedGit } from "./scripted-git";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-${prefix}-`));
  dirs.push(dir);
  return dir;
}

const BRANCH = "volli/VC-1-x";
const PROJECT = "/repo";
const MAIN_ENTRY = `worktree ${PROJECT}\nHEAD abc\nbranch refs/heads/main\n`;

/** A git whose `worktree list` returns `MAIN_ENTRY` plus any extra porcelain blocks. */
function listGit(extra = "") {
  return scriptedGit((args) => {
    if (args[0] === "worktree" && args[1] === "list") return MAIN_ENTRY + extra;
    return "";
  });
}

describe("reconcile matrix", () => {
  it("creates cleanly when nothing is registered and the dir is missing", () => {
    const target = join(tempDir("home"), "wt-missing"); // does not exist
    const { git } = listGit();
    const result = reconcile(git, { projectPath: PROJECT, worktreePath: target, branch: BRANCH });
    expect(result).toEqual({ ok: true, value: { kind: "create", prune: false } });
  });

  it("is an idempotent no-op when registered and the dir is present", () => {
    const target = tempDir("wt");
    const { git } = listGit(`worktree ${target}\nHEAD def\nbranch refs/heads/${BRANCH}\n`);
    const result = reconcile(git, { projectPath: PROJECT, worktreePath: target, branch: BRANCH });
    expect(result).toEqual({ ok: true, value: { kind: "already-present" } });
  });

  it("prunes and recreates when registered but the dir is missing (stale metadata)", () => {
    const target = join(tempDir("home"), "wt-gone");
    const { git } = listGit(`worktree ${target}\nHEAD def\nbranch refs/heads/${BRANCH}\n`);
    const result = reconcile(git, { projectPath: PROJECT, worktreePath: target, branch: BRANCH });
    expect(result).toEqual({ ok: true, value: { kind: "create", prune: true } });
  });

  it("creates into an existing EMPTY unregistered dir (git accepts an empty target)", () => {
    const target = tempDir("wt"); // exists, empty
    const { git } = listGit();
    const result = reconcile(git, { projectPath: PROJECT, worktreePath: target, branch: BRANCH });
    expect(result).toEqual({ ok: true, value: { kind: "create", prune: false } });
  });

  it("refuses an unregistered dir carrying a .git worktree file with the orphan message", () => {
    const target = tempDir("wt");
    writeFileSync(join(target, ".git"), "gitdir: /repo/.git/worktrees/wt\n");
    const { git } = listGit();
    const result = reconcile(git, { projectPath: PROJECT, worktreePath: target, branch: BRANCH });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/orphaned worktree/);
  });

  it("refuses a plain non-empty unregistered directory rather than blind rm -rf", () => {
    const target = tempDir("wt"); // someone's real dir with real contents
    writeFileSync(join(target, "notes.txt"), "keep me\n");
    const { git } = listGit();
    const result = reconcile(git, { projectPath: PROJECT, worktreePath: target, branch: BRANCH });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a Volli worktree/);
  });

  it("hard-fails (no --force) when the branch is checked out elsewhere", () => {
    const target = join(tempDir("home"), "wt-new");
    const { git } = listGit(`worktree /somewhere/else\nHEAD def\nbranch refs/heads/${BRANCH}\n`);
    const result = reconcile(git, { projectPath: PROJECT, worktreePath: target, branch: BRANCH });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already checked out/);
  });

  it("refuses when a different branch is registered at our target path", () => {
    const target = tempDir("wt");
    const { git } = listGit(`worktree ${target}\nHEAD def\nbranch refs/heads/other\n`);
    const result = reconcile(git, { projectPath: PROJECT, worktreePath: target, branch: BRANCH });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not volli\/VC-1-x/);
  });

  it("refuses a DETACHED-HEAD registration at our target path, naming detached HEAD", () => {
    // A detached HEAD (no `branch` line) would otherwise pass the wrong-branch
    // guard vacuously and boot a session that strands its commits off any
    // branch — refuse just as hard, and say why (fix 2).
    const target = tempDir("wt");
    const { git } = listGit(`worktree ${target}\nHEAD def\ndetached\n`);
    const result = reconcile(git, { projectPath: PROJECT, worktreePath: target, branch: BRANCH });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/detached HEAD/);
      expect(result.error).toMatch(/not volli\/VC-1-x/);
    }
  });

  it("surfaces an error when the worktree list can't be read", () => {
    const target = join(tempDir("home"), "wt");
    const { git } = scriptedGit(() => {
      throw new GitError("fatal", "not a git repository", ["worktree", "list"]);
    });
    const result = reconcile(git, { projectPath: PROJECT, worktreePath: target, branch: BRANCH });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a git repository/);
  });
});
