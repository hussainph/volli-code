import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { scriptedGit } from "./scripted-git";
import { getWorktreeStatus } from "./status";

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
 * A git answering every status probe clean, unless a probe is overridden. The
 * remote-tracking probe (`rev-parse --verify refs/remotes/origin/<base>`)
 * FAILS by default — no remote-tracking ref, so comparisons use the local base;
 * `hasRemoteRef: true` makes it succeed (comparison-ref.ts then prefers
 * `origin/<base>`).
 */
function statusGit(
  gitDir: string,
  over: Partial<Record<"status" | "revList", () => string>> & { hasRemoteRef?: boolean } = {},
) {
  return scriptedGit((args) => {
    if (args[0] === "status") return (over.status ?? (() => ""))();
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      if (over.hasRemoteRef) return "abc123\n";
      throw new Error("fatal: Needed a single revision");
    }
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
    if (args[0] === "rev-list") return (over.revList ?? (() => "0\t0\n"))();
    return "";
  });
}

describe("getWorktreeStatus", () => {
  it("reports a fully clean, in-sync worktree", () => {
    const gitDir = tempDir("gitdir");
    const { git } = statusGit(gitDir);
    expect(
      getWorktreeStatus(git, { worktreePath: "/wt", branch: "b", baseBranch: "main" }),
    ).toEqual({ uncommitted: false, sequencerActive: false, aheadOfBase: 0, behindBase: 0 });
  });

  it("flags uncommitted when git status is non-empty", () => {
    const gitDir = tempDir("gitdir");
    const { git } = statusGit(gitDir, { status: () => " M src/a.ts\n" });
    const report = getWorktreeStatus(git, { worktreePath: "/wt", branch: "b", baseBranch: "main" });
    expect(report.uncommitted).toBe(true);
  });

  it("treats a failing status read as uncommitted=true (never silently clean)", () => {
    const gitDir = tempDir("gitdir");
    const { git } = statusGit(gitDir, {
      status: () => {
        throw new Error("git status exploded");
      },
    });
    const report = getWorktreeStatus(git, { worktreePath: "/wt", branch: "b", baseBranch: "main" });
    expect(report.uncommitted).toBe(true);
  });

  it("flags sequencerActive when a marker file exists in the private gitdir", () => {
    const gitDir = tempDir("gitdir");
    writeFileSync(join(gitDir, "MERGE_HEAD"), "abc\n");
    const { git } = statusGit(gitDir);
    const report = getWorktreeStatus(git, { worktreePath: "/wt", branch: "b", baseBranch: "main" });
    expect(report.sequencerActive).toBe(true);
  });

  it("parses ahead/behind from rev-list --left-right --count (left=behind, right=ahead)", () => {
    const gitDir = tempDir("gitdir");
    const { git, calls } = statusGit(gitDir, { revList: () => "2\t5\n" });
    const report = getWorktreeStatus(git, { worktreePath: "/wt", branch: "b", baseBranch: "main" });
    expect(report.behindBase).toBe(2);
    expect(report.aheadOfBase).toBe(5);
    // Uses the three-dot symmetric range `<base>...<branch>`.
    const revList = calls.find((c) => c.args[0] === "rev-list");
    expect(revList?.args).toContain("--left-right");
    expect(revList?.args).toContain("--count");
    expect(revList?.args).toContain("main...b");
  });

  it("measures ahead/behind against origin/<base> when the remote-tracking ref exists", () => {
    const gitDir = tempDir("gitdir");
    const { git, calls } = statusGit(gitDir, { hasRemoteRef: true, revList: () => "1\t3\n" });
    const report = getWorktreeStatus(git, { worktreePath: "/wt", branch: "b", baseBranch: "main" });
    expect(report.behindBase).toBe(1);
    expect(report.aheadOfBase).toBe(3);
    const revList = calls.find((c) => c.args[0] === "rev-list");
    expect(revList?.args).toContain("origin/main...b");
  });

  it("returns null ahead/behind when the base is unknown, never spawning rev-list", () => {
    const gitDir = tempDir("gitdir");
    const { git, calls } = statusGit(gitDir);
    const report = getWorktreeStatus(git, { worktreePath: "/wt", branch: "b", baseBranch: null });
    expect(report.aheadOfBase).toBeNull();
    expect(report.behindBase).toBeNull();
    expect(calls.some((c) => c.args[0] === "rev-list")).toBe(false);
  });

  it("returns null ahead/behind when rev-list fails, but keeps the rest of the report", () => {
    const gitDir = tempDir("gitdir");
    const { git } = statusGit(gitDir, {
      status: () => " M a.ts\n",
      revList: () => {
        throw new Error("bad revision");
      },
    });
    const report = getWorktreeStatus(git, { worktreePath: "/wt", branch: "b", baseBranch: "main" });
    expect(report.aheadOfBase).toBeNull();
    expect(report.behindBase).toBeNull();
    expect(report.uncommitted).toBe(true);
  });
});
