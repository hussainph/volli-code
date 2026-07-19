import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { isWorktreeDirty } from "./dirty";
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

/**
 * A git that answers every §7 probe "clean" for a worktree, unless a probe is
 * overridden. `gitDir` is a real empty dir (no sequencer files) so the sequencer
 * check passes by default.
 */
function cleanGit(
  wt: string,
  gitDir: string,
  over: Partial<Record<"status" | "log" | "list" | "submodule", () => string>> = {},
) {
  return scriptedGit((args) => {
    if (args[0] === "status") return (over.status ?? (() => ""))();
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
    if (args[0] === "log") return (over.log ?? (() => ""))();
    if (args[0] === "worktree" && args[1] === "list") {
      return over.list ? over.list() : `worktree ${wt}\nHEAD abc\nbranch refs/heads/b\n`;
    }
    if (args[0] === "submodule") return (over.submodule ?? (() => ""))();
    return "";
  });
}

describe("isWorktreeDirty", () => {
  it("is clean when every rule passes", () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const { git } = cleanGit(wt, gitDir);
    expect(isWorktreeDirty(git, { worktreePath: wt, branch: "b", baseBranch: "main" })).toEqual({
      dirty: false,
      reason: null,
    });
  });

  it("is dirty on a non-empty git status (includes untracked)", () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const { git } = cleanGit(wt, gitDir, { status: () => "?? new.txt\n" });
    const result = isWorktreeDirty(git, { worktreePath: wt, branch: "b", baseBranch: "main" });
    expect(result.dirty).toBe(true);
    expect(result.reason).toMatch(/untracked/);
  });

  it("is dirty when sequencer state exists (mid-flight rebase/merge/etc.)", () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    writeFileSync(join(gitDir, "MERGE_HEAD"), "abc\n");
    const { git } = cleanGit(wt, gitDir);
    const result = isWorktreeDirty(git, { worktreePath: wt, branch: "b", baseBranch: "main" });
    expect(result.dirty).toBe(true);
    expect(result.reason).toMatch(/merge, rebase/);
  });

  it("is dirty when the branch has commits unreachable from base or any remote", () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const { git } = cleanGit(wt, gitDir, { log: () => "deadbeef\n" });
    const result = isWorktreeDirty(git, { worktreePath: wt, branch: "b", baseBranch: "main" });
    expect(result.dirty).toBe(true);
    expect(result.reason).toMatch(/not reachable/);
  });

  it("respects a git worktree lock absolutely", () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const { git } = cleanGit(wt, gitDir, {
      list: () => `worktree ${wt}\nHEAD abc\nbranch refs/heads/b\nlocked in use\n`,
    });
    const result = isWorktreeDirty(git, { worktreePath: wt, branch: "b", baseBranch: "main" });
    expect(result.dirty).toBe(true);
    expect(result.reason).toMatch(/locked/);
  });

  it("is dirty on submodule drift", () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const { git } = cleanGit(wt, gitDir, { submodule: () => "+abc123 vendor/lib (v1)\n" });
    const result = isWorktreeDirty(git, { worktreePath: wt, branch: "b", baseBranch: "main" });
    expect(result.dirty).toBe(true);
    expect(result.reason).toMatch(/submodule/);
  });

  it("errs dirty on ANY git failure (an unreadable worktree is not assumed clean)", () => {
    const wt = tempDir("wt");
    const { git } = scriptedGit(() => {
      throw new Error("git exploded");
    });
    const result = isWorktreeDirty(git, { worktreePath: wt, branch: "b", baseBranch: "main" });
    expect(result.dirty).toBe(true);
    expect(result.reason).not.toBeNull();
  });

  it("negates base AND remotes with a single --not (a second one would toggle --remotes positive)", () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const { git, calls } = cleanGit(wt, gitDir);
    isWorktreeDirty(git, { worktreePath: wt, branch: "b", baseBranch: "main" });
    const logCall = calls.find((c) => c.args[0] === "log");
    expect(logCall?.args.filter((a) => a === "--not")).toHaveLength(1);
    // Negation persists across both: `log b --not main --remotes`.
    expect(logCall?.args.join(" ")).toContain("--not main --remotes");
  });

  it("skips the base filter when the base is unknown (sweep of an orphan)", () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const { git, calls } = cleanGit(wt, gitDir);
    isWorktreeDirty(git, { worktreePath: wt, branch: "b", baseBranch: null });
    const logCall = calls.find((c) => c.args[0] === "log");
    // Only `--not --remotes` remains — never a `--not <base>` pair.
    expect(logCall?.args.filter((a) => a === "--not")).toHaveLength(1);
    expect(logCall?.args).toContain("--remotes");
  });
});
