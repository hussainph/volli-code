import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { isWorktreeDirty, isWorktreeDirtyAsync } from "./dirty";
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

  it("is dirty on submodule drift (`+` different SHA, or `U` conflict)", () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const { git } = cleanGit(wt, gitDir, { submodule: () => "+abc123 vendor/lib (v1)\n" });
    const result = isWorktreeDirty(git, { worktreePath: wt, branch: "b", baseBranch: "main" });
    expect(result.dirty).toBe(true);
    expect(result.reason).toMatch(/submodule/);
  });

  it("is CLEAN when a submodule is merely uninitialized (`-`) — worktree add never inits them", () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    // Every worktree of a submodule repo starts `-`; counting it would make the
    // sweep and non-forced remove permanently refuse (fix 3).
    const { git } = cleanGit(wt, gitDir, { submodule: () => "-abc123 vendor/lib\n" });
    expect(isWorktreeDirty(git, { worktreePath: wt, branch: "b", baseBranch: "main" })).toEqual({
      dirty: false,
      reason: null,
    });
  });

  it("reuses a supplied worktree listing for the lock check, never re-spawning git worktree list", () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const { git, calls } = cleanGit(wt, gitDir);
    const result = isWorktreeDirty(git, {
      worktreePath: wt,
      branch: "b",
      baseBranch: "main",
      worktreeEntries: [{ path: wt, branch: "b", locked: true, bare: false, prunable: null }],
    });
    expect(result.dirty).toBe(true);
    expect(result.reason).toMatch(/locked/);
    // The caller's listing answered the lock check — no `worktree list` spawn (fix 10).
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "list")).toBe(false);
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

/**
 * The async driver is the same five rules over the runner that lets Electron
 * main keep turning (VC-383). These hold it to the sync driver's answers,
 * probe by probe, so the two can never say different things about one tree.
 */
const input = (wt: string) => ({ worktreePath: wt, branch: "b", baseBranch: "main" });

describe("isWorktreeDirtyAsync", () => {

  it("is clean when every rule passes, and runs the probes in the sync driver's order", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const { git, gitAsync, calls } = cleanGit(wt, gitDir);
    expect(await isWorktreeDirtyAsync(gitAsync, input(wt))).toEqual({ dirty: false, reason: null });
    const asyncOrder = calls.map((c) => c.args.join(" "));
    calls.length = 0;
    isWorktreeDirty(git, input(wt));
    expect(asyncOrder).toEqual(calls.map((c) => c.args.join(" ")));
  });

  it("fires the same rule the sync driver fires, with the same reason", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const cases: Parameters<typeof cleanGit>[2][] = [
      { status: () => "?? new.txt\n" },
      { log: () => "abc123\n" },
      { list: () => `worktree ${wt}\nHEAD abc\nbranch refs/heads/b\nlocked\n` },
      { submodule: () => "+abc path/to/sub (v1)\n" },
      { submodule: () => "-abc path/to/sub\n" },
    ];
    for (const over of cases) {
      const { git, gitAsync } = cleanGit(wt, gitDir, over);
      expect(await isWorktreeDirtyAsync(gitAsync, input(wt))).toEqual(
        isWorktreeDirty(git, input(wt)),
      );
    }
  });

  it("is dirty when sequencer state exists, and errs dirty when the git dir cannot be resolved", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    writeFileSync(join(gitDir, "MERGE_HEAD"), "abc\n");
    const { gitAsync } = cleanGit(wt, gitDir);
    const active = await isWorktreeDirtyAsync(gitAsync, input(wt));
    expect(active.dirty).toBe(true);
    expect(active.reason).toMatch(/in-progress/);

    const { gitAsync: broken } = scriptedGit((args) => {
      if (args[0] === "rev-parse") throw new Error("no git dir");
      return "";
    });
    const unknown = await isWorktreeDirtyAsync(broken, input(wt));
    expect(unknown.dirty).toBe(true);
    expect(unknown.reason).toMatch(/git directory/);
  });

  it("reuses a supplied worktree listing for the lock check, never re-spawning git worktree list", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const { gitAsync, calls } = cleanGit(wt, gitDir);
    const result = await isWorktreeDirtyAsync(gitAsync, {
      ...input(wt),
      worktreeEntries: [{ path: wt, branch: "b", locked: true, bare: false, prunable: null }],
    });
    expect(result.reason).toMatch(/locked/);
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "list")).toBe(false);
  });

  it("errs dirty on ANY git failure, naming the probe that could not be read", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    const failing = (probe: string) =>
      scriptedGit((args) => {
        if (args[0] === probe) throw new Error("git exploded");
        if (args[0] === "rev-parse") return gitDir;
        if (args[0] === "worktree") return `worktree ${wt}\nHEAD abc\nbranch refs/heads/b\n`;
        return "";
      }).gitAsync;
    expect((await isWorktreeDirtyAsync(failing("status"), input(wt))).reason).toMatch(/status/);
    expect((await isWorktreeDirtyAsync(failing("log"), input(wt))).reason).toMatch(/compare/);
    expect((await isWorktreeDirtyAsync(failing("worktree"), input(wt))).reason).toMatch(/lock/);
    expect((await isWorktreeDirtyAsync(failing("submodule"), input(wt))).reason).toMatch(
      /submodule/,
    );
  });
});
