import { describe, expect, it } from "vite-plus/test";

import { GitError } from "./git";
import { scriptedGit } from "./scripted-git";
import { syncWithBase } from "./sync";

/** Every git subcommand that talks to a remote — none of which sync may run. */
const NETWORK_SUBCOMMANDS = ["fetch", "pull", "push", "ls-remote", "clone", "remote"];

/**
 * A scripted repo where HEAD moves when the merge runs, so the "what moved"
 * report is measured rather than asserted into existence.
 */
function mergingRepo(options: { conflicts?: readonly string[] } = {}) {
  let head = "aaaaaaa";
  return scriptedGit((args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
      // No merge in flight until one conflicts.
      if (head === "conflicted") return "cccccccc\n";
      throw new GitError("no MERGE_HEAD", "fatal: Needed a single revision", args);
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") return "bbbbbbb\n";
    if (args[0] === "rev-parse") return `${head}\n`;
    if (args[0] === "merge") {
      if (options.conflicts) {
        head = "conflicted";
        throw new GitError("merge failed", "Automatic merge failed; fix conflicts", args);
      }
      head = "ddddddd";
      return "Updating aaaaaaa..ddddddd\n";
    }
    if (args[0] === "diff" && args.includes("--diff-filter=U")) {
      return (options.conflicts ?? []).join("\n");
    }
    if (args[0] === "diff") return "3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n";
    if (args[0] === "rev-list") return "2\n";
    return "";
  });
}

describe("syncWithBase — a clean merge", () => {
  it("merges the base into the worktree and reports what moved", () => {
    const { git, calls } = mergingRepo();

    const result = syncWithBase(git, { worktreePath: "/wt", baseBranch: "main" }, "merge");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("merged");
    expect(result.value.mergedRef).toBe("origin/main");
    expect(result.value.commits).toBe(2);
    expect(result.value.conflicts).toEqual([]);
    expect(result.value.diff).toEqual({
      files: [
        { path: "src/a.ts", insertions: 3, deletions: 1, untracked: false },
        { path: "src/b.ts", insertions: 10, deletions: 0, untracked: false },
      ],
      insertions: 13,
      deletions: 1,
    });
    // The merge itself is non-interactive: an editor prompt is a wedge.
    expect(calls.find((call) => call.args[0] === "merge")?.args).toEqual([
      "merge",
      "--no-edit",
      "origin/main",
    ]);
  });

  it("reports an unmoved HEAD as already up to date rather than as a merge", () => {
    // git exits 0 for "Already up to date", so the outcome has to be read off
    // HEAD, not off the exit code.
    const { git } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
        throw new GitError("no MERGE_HEAD", "fatal: Needed a single revision", args);
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return "bbbbbbb\n";
      if (args[0] === "rev-parse") return "aaaaaaa\n";
      if (args[0] === "merge") return "Already up to date.\n";
      return "";
    });

    const result = syncWithBase(git, { worktreePath: "/wt", baseBranch: "main" }, "merge");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("already-up-to-date");
    expect(result.value.commits).toBe(0);
    expect(result.value.diff).toEqual({ files: [], insertions: 0, deletions: 0 });
  });

  it("keeps a landed merge landed when measuring it fails", () => {
    // The merge COMMITTED and a later read broke. Reporting the sync as failed
    // would send a session to undo work that is already in the branch, so the
    // outcome stands and only its size degrades to unknown.
    const { git } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
        throw new GitError("no MERGE_HEAD", "fatal: Needed a single revision", args);
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return "bbbbbbb\n";
      if (args[0] === "rev-parse") return `${args[1] === "HEAD" ? "aaaaaaa" : "zzzzzzz"}\n`;
      if (args[0] === "merge") return "";
      if (args[0] === "rev-list") throw new GitError("boom", "fatal: bad revision", args);
      return "";
    });
    let head = 0;
    const moving = ((args: readonly string[], cwd: string) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        head += 1;
        return head === 1 ? "aaaaaaa\n" : "ddddddd\n";
      }
      return git(args, cwd);
    }) as typeof git;

    const result = syncWithBase(moving, { worktreePath: "/wt", baseBranch: "main" }, "merge");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("merged");
    expect(result.value.commits).toBeNull();
    expect(result.value.diff).toBeNull();
  });

  it("measures against the local base when no remote-tracking ref exists", () => {
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        throw new GitError("no ref", "fatal: Needed a single revision", args);
      }
      if (args[0] === "rev-parse") return "aaaaaaa\n";
      return "";
    });

    const result = syncWithBase(git, { worktreePath: "/wt", baseBranch: "main" }, "merge");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mergedRef).toBe("main");
    expect(calls.find((call) => call.args[0] === "merge")?.args).toEqual([
      "merge",
      "--no-edit",
      "main",
    ]);
  });
});

describe("syncWithBase — a conflicted merge", () => {
  it("reports the conflicted paths and leaves the merge in flight", () => {
    const { git, calls } = mergingRepo({
      conflicts: ["packages/shared/src/x.ts", "apps/desktop/src/y.tsx"],
    });

    const result = syncWithBase(git, { worktreePath: "/wt", baseBranch: "main" }, "merge");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("conflicted");
    expect(result.value.conflicts).toEqual(["packages/shared/src/x.ts", "apps/desktop/src/y.tsx"]);
    // Nothing tidies up after the conflict: the worktree stays conflicted for
    // the session to resolve, which is the whole contract.
    expect(calls.some((call) => call.args.includes("--abort"))).toBe(false);
    expect(calls.some((call) => call.args[0] === "reset")).toBe(false);
    expect(calls.some((call) => call.args[0] === "checkout")).toBe(false);
  });

  it("surfaces a merge that failed for any other reason as an error", () => {
    // A dirty tree, an unrelated history, a missing ref: git exits non-zero and
    // no path is unmerged. Reporting that as "conflicted" would send a session
    // hunting for conflict markers that do not exist.
    const { git } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
        throw new GitError("no MERGE_HEAD", "fatal: Needed a single revision", args);
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return "bbbbbbb\n";
      if (args[0] === "rev-parse") return "aaaaaaa\n";
      if (args[0] === "merge") {
        throw new GitError(
          "merge failed",
          "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts",
          args,
        );
      }
      if (args[0] === "diff" && args.includes("--diff-filter=U")) return "";
      return "";
    });

    const result = syncWithBase(git, { worktreePath: "/wt", baseBranch: "main" }, "merge");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("would be overwritten by merge");
  });

  it("refuses to start a second merge on top of one already in flight", () => {
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
        return "cccccccc\n";
      }
      return "";
    });

    const result = syncWithBase(git, { worktreePath: "/wt", baseBranch: "main" }, "merge");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("merge is already in progress");
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
  });
});

describe("syncWithBase — the abort story", () => {
  it("aborts a merge that is in flight and says so", () => {
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
        return "cccccccc\n";
      }
      if (args[0] === "rev-parse") return "aaaaaaa\n";
      return "";
    });

    const result = syncWithBase(git, { worktreePath: "/wt", baseBranch: "main" }, "abort");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("aborted");
    expect(calls.find((call) => call.args[0] === "merge")?.args).toEqual(["merge", "--abort"]);
  });

  it("refuses to abort when no merge is in flight", () => {
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
        throw new GitError("no MERGE_HEAD", "fatal: Needed a single revision", args);
      }
      return "";
    });

    const result = syncWithBase(git, { worktreePath: "/wt", baseBranch: "main" }, "abort");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no merge in progress");
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
  });
});

describe("syncWithBase — it never blocks", () => {
  it("runs no command that reaches the network, in any outcome", () => {
    // The hard constraint VC-92 pinned on this verb: it must not wait on gates
    // or CI, and the way a local git verb starts waiting is by touching a
    // remote — the osxkeychain hang that froze every push for two hours is the
    // failure class, and `--watch` is the wedge this verb exists to delete.
    for (const scenario of [
      mergingRepo(),
      mergingRepo({ conflicts: ["src/x.ts"] }),
      scriptedGit((args) => {
        if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
          return "cccccccc\n";
        }
        return "";
      }),
    ]) {
      syncWithBase(scenario.git, { worktreePath: "/wt", baseBranch: "main" }, "merge");
      syncWithBase(scenario.git, { worktreePath: "/wt", baseBranch: "main" }, "abort");
      for (const call of scenario.calls) {
        expect(NETWORK_SUBCOMMANDS).not.toContain(call.args[0]);
      }
      expect(scenario.calls.length).toBeGreaterThan(0);
    }
  });

  it("fails fast when no base branch is known instead of guessing one", () => {
    const { git, calls } = scriptedGit(() => "");

    const result = syncWithBase(git, { worktreePath: "/wt", baseBranch: null }, "merge");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("No base branch");
    expect(calls).toEqual([]);
  });
});
