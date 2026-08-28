import { describe, expect, it } from "vite-plus/test";

import { GitError } from "./git";
import { scriptedGit } from "./scripted-git";
import { previewSyncWithBase, syncWithBase } from "./sync";
import type { RunGitAsync } from "./types";

/** Every git subcommand that talks to a remote — none of which sync may run. */
const NETWORK_SUBCOMMANDS = ["fetch", "pull", "push", "ls-remote", "clone", "remote"];

const TICKET_BRANCH = "volli/VC-1-ship";
const SYNC_INPUT = { worktreePath: "/wt", branch: TICKET_BRANCH, baseBranch: "main" };

/** Gives sync's branch-identity guard the ticket checkout every unit scenario intends. */
function ticketBranchGit(git: RunGitAsync): RunGitAsync {
  return async (args, cwd) =>
    args[0] === "branch" && args[1] === "--show-current" ? `${TICKET_BRANCH}\n` : git(args, cwd);
}

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

describe("previewSyncWithBase", () => {
  it("reports the resolved ref and matching target without merging or aborting", async () => {
    const { gitAsync, calls } = mergingRepo();

    const result = await previewSyncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "merge");

    expect(result).toEqual({
      ok: true,
      value: {
        mode: "merge",
        mergedRef: "origin/main",
        targetBranch: TICKET_BRANCH,
        checkedOutBranch: TICKET_BRANCH,
        branchIdentityMatches: true,
      },
    });
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
  });

  it("reports a failed branch identity check without mutating", async () => {
    const { gitAsync, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") return "bbbbbbb\n";
      if (args[0] === "branch" && args[1] === "--show-current") return "other-branch\n";
      return "";
    });

    const result = await previewSyncWithBase(gitAsync, SYNC_INPUT, "abort");

    expect(result).toEqual({
      ok: true,
      value: {
        mode: "abort",
        mergedRef: "origin/main",
        targetBranch: TICKET_BRANCH,
        checkedOutBranch: "other-branch",
        branchIdentityMatches: false,
      },
    });
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
  });

  it("refuses previews whose configured base or target branch cannot be checked", async () => {
    const { gitAsync, calls } = scriptedGit(() => "");

    const noBase = await previewSyncWithBase(
      gitAsync,
      { ...SYNC_INPUT, baseBranch: null },
      "merge",
    );
    const noTarget = await previewSyncWithBase(gitAsync, { ...SYNC_INPUT, branch: null }, "merge");

    expect(noBase).toMatchObject({ ok: false, error: expect.stringContaining("No base branch") });
    expect(noTarget).toMatchObject({ ok: false, error: expect.stringContaining("no recorded") });
    expect(calls).toEqual([]);
  });

  it("reports a branch-probe failure without attempting a merge", async () => {
    const { gitAsync, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") return "bbbbbbb\n";
      throw new GitError("branch unavailable", "fatal: not a git repository", args);
    });

    const result = await previewSyncWithBase(gitAsync, SYNC_INPUT, "merge");

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("not a git repository"),
    });
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
  });
});

describe("syncWithBase — a clean merge", () => {
  it("merges the base into the worktree and reports what moved", async () => {
    const { gitAsync, calls } = mergingRepo();

    const result = await syncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "merge");

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

  it("reports an unmoved HEAD as already up to date rather than as a merge", async () => {
    // git exits 0 for "Already up to date", so the outcome has to be read off
    // HEAD, not off the exit code.
    const { gitAsync } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
        throw new GitError("no MERGE_HEAD", "fatal: Needed a single revision", args);
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return "bbbbbbb\n";
      if (args[0] === "rev-parse") return "aaaaaaa\n";
      if (args[0] === "merge") return "Already up to date.\n";
      return "";
    });

    const result = await syncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "merge");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("already-up-to-date");
    expect(result.value.commits).toBe(0);
    expect(result.value.diff).toEqual({ files: [], insertions: 0, deletions: 0 });
  });

  it("keeps a landed merge landed when measuring it fails", async () => {
    // The merge COMMITTED and a later read broke. Reporting the sync as failed
    // would send a session to undo work that is already in the branch, so the
    // outcome stands and only its size degrades to unknown.
    const { gitAsync } = scriptedGit((args) => {
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
    const moving = (async (args: readonly string[], cwd: string) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        head += 1;
        return head === 1 ? "aaaaaaa\n" : "ddddddd\n";
      }
      return gitAsync(args, cwd);
    }) as typeof gitAsync;

    const result = await syncWithBase(ticketBranchGit(moving), SYNC_INPUT, "merge");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("merged");
    expect(result.value.commits).toBeNull();
    expect(result.value.diff).toBeNull();
  });

  it("measures against the local base when no remote-tracking ref exists", async () => {
    const { gitAsync, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        throw new GitError("no ref", "fatal: Needed a single revision", args);
      }
      if (args[0] === "rev-parse") return "aaaaaaa\n";
      return "";
    });

    const result = await syncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "merge");

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
  it("reports the conflicted paths and leaves the merge in flight", async () => {
    const { gitAsync, calls } = mergingRepo({
      conflicts: ["packages/shared/src/x.ts", "apps/desktop/src/y.tsx"],
    });

    const result = await syncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "merge");

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

  it("surfaces a merge that failed for any other reason as an error", async () => {
    // A dirty tree, an unrelated history, a missing ref: git exits non-zero and
    // no path is unmerged. Reporting that as "conflicted" would send a session
    // hunting for conflict markers that do not exist.
    const { gitAsync } = scriptedGit((args) => {
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

    const result = await syncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "merge");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("would be overwritten by merge");
  });

  it("refuses to start a second merge on top of one already in flight", async () => {
    const { gitAsync, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
        return "cccccccc\n";
      }
      return "";
    });

    const result = await syncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "merge");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("merge is already in progress");
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
  });

  it("names --abort when a hook rejects the merge after MERGE_HEAD was written", async () => {
    let mergeInFlight = false;
    const { gitAsync, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
        if (mergeInFlight) return "cccccccc\n";
        throw new GitError("no MERGE_HEAD", "fatal: Needed a single revision", args);
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return "bbbbbbb\n";
      if (args[0] === "rev-parse") return "aaaaaaa\n";
      if (args[0] === "merge") {
        mergeInFlight = true;
        throw new GitError(
          "merge hook rejected commit",
          "Not committing merge; use 'git commit' to complete the merge.\npre-merge-commit rejected it",
          args,
        );
      }
      if (args[0] === "diff" && args.includes("--diff-filter=U")) return "";
      return "";
    });

    const result = await syncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "merge");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("pre-merge-commit rejected it");
    expect(result.error).toContain("--abort");
    // A hook failure has no unmerged paths, but Git has still left its merge
    // sequencer active. The post-error probe must observe that state instead
    // of returning a bare error against a silently broken worktree.
    expect(mergeInFlight).toBe(true);
    expect(
      calls.filter(
        (call) =>
          call.args[0] === "rev-parse" &&
          call.args[1] === "--verify" &&
          call.args[3] === "MERGE_HEAD",
      ),
    ).toHaveLength(2);
  });
});

describe("syncWithBase — the abort story", () => {
  it("aborts a merge that is in flight and says so", async () => {
    const { gitAsync, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
        return "cccccccc\n";
      }
      if (args[0] === "rev-parse") return "aaaaaaa\n";
      return "";
    });

    const result = await syncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "abort");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("aborted");
    expect(calls.find((call) => call.args[0] === "merge")?.args).toEqual(["merge", "--abort"]);
  });

  it("refuses to abort when no merge is in flight", async () => {
    const { gitAsync, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[3] === "MERGE_HEAD") {
        throw new GitError("no MERGE_HEAD", "fatal: Needed a single revision", args);
      }
      return "";
    });

    const result = await syncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "abort");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no merge in progress");
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
  });
});

describe("syncWithBase — it never blocks", () => {
  it("runs no command that reaches the network, in any outcome", async () => {
    // The hard constraint VC-92 pinned on this verb: it starts no gate, CI,
    // watch, or remote command. The separate bounded-runner test covers a hung
    // local hook/filter; this one pins the no-network half of the contract.
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
      await syncWithBase(ticketBranchGit(scenario.gitAsync), SYNC_INPUT, "merge");
      await syncWithBase(ticketBranchGit(scenario.gitAsync), SYNC_INPUT, "abort");
      for (const call of scenario.calls) {
        expect(NETWORK_SUBCOMMANDS).not.toContain(call.args[0]);
      }
      expect(scenario.calls.length).toBeGreaterThan(0);
    }
  });

  it("fails fast when no base branch is known instead of guessing one", async () => {
    const { gitAsync, calls } = scriptedGit(() => "");

    const result = await syncWithBase(
      ticketBranchGit(gitAsync),
      { ...SYNC_INPUT, baseBranch: null },
      "merge",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("No base branch");
    expect(calls).toEqual([]);
  });
});
