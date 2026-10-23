import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GitError, runGitCapturingAsync } from "./git";
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

/** Git's `-z` reads terminate every field with NUL, so fixtures must too. */
function nulDelimited(records: readonly string[]): string {
  return records.map((record) => `${record}\0`).join("");
}

/**
 * A scripted repo where HEAD moves when the merge runs, so the "what moved"
 * report is measured rather than asserted into existence.
 */
function mergingRepo(options: { conflicts?: readonly string[]; numstat?: readonly string[] } = {}) {
  let head = "aaaaaaa";
  const numstat = options.numstat ?? ["3\t1\tsrc/a.ts", "10\t0\tsrc/b.ts"];
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
      return nulDelimited(options.conflicts ?? []);
    }
    if (args[0] === "diff") return nulDelimited(numstat);
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
    // `-z` keeps paths literal and separates both rename paths; `-M` enables
    // rename detection independently of the user's git configuration.
    expect(calls.find((call) => call.args[0] === "diff")?.args).toEqual([
      "diff",
      "--numstat",
      "-z",
      "-M",
      "aaaaaaa..ddddddd",
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

describe("syncWithBase — NUL-delimited movement", () => {
  it("keeps a rename destination and counts it against the new path", async () => {
    // `--numstat -z` prints a rename as an empty path field followed by the old
    // and new paths as separate tokens. Reporting the old half would name a file
    // the merge removed.
    const { gitAsync } = mergingRepo({
      numstat: ["2\t2\t", "src/old name.ts", "src/new café.ts", "1\t0\tnotes/my plan.md"],
    });

    const result = await syncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "merge");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diff).toEqual({
      files: [
        { path: "src/new café.ts", insertions: 2, deletions: 2, untracked: false },
        { path: "notes/my plan.md", insertions: 1, deletions: 0, untracked: false },
      ],
      insertions: 3,
      deletions: 2,
    });
  });
});

describe("syncWithBase — a conflicted merge", () => {
  it("reports the conflicted paths literally and leaves the merge in flight", async () => {
    // Exactly the paths a line-splitting parse mangles: a space, a non-ASCII
    // name, and a newline must each come back as the string an agent can hand
    // to `read`.
    const conflicts = ["notes/my plan.md", "src/café.ts", "src/line\nbreak.ts"];
    const { gitAsync, calls } = mergingRepo({ conflicts });

    const result = await syncWithBase(ticketBranchGit(gitAsync), SYNC_INPUT, "merge");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("conflicted");
    expect(result.value.conflicts).toEqual(conflicts);
    expect(calls.find((call) => call.args.includes("--diff-filter=U"))?.args).toEqual([
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=U",
    ]);
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

// Real-git regressions: a scripted runner cannot show that git C-quotes these
// paths when a read lacks `-z`, so it cannot prove the report is one an agent
// can open. Every fixture pins quoting, hooks and signing and runs under an
// empty global config, so no machine setting decides the outcome (VC-791).
describe("syncWithBase — real git paths", () => {
  let root: string;
  let dir: string;

  const git = (args: readonly string[], cwd?: string): string =>
    execFileSync("git", [...args], {
      cwd: cwd ?? dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const commit = (message: string): void => {
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", message]);
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(process.cwd(), ".volli-sync-test-")));
    dir = join(root, "repo");
    mkdirSync(dir);
    const config = join(root, "global.config");
    writeFileSync(config, "");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    git(["init", "--quiet", "--initial-branch=main"]);
    git(["config", "user.name", "Volli Test"]);
    git(["config", "user.email", "test@volli.local"]);
    git(["config", "commit.gpgSign", "false"]);
    git(["config", "core.hooksPath", "/dev/null"]);
    // Git's default quoting stays ON — `-z` is the only reason paths are literal.
    git(["config", "core.quotePath", "true"]);
    git(["config", "core.autocrlf", "false"]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("reports spaces, a non-ASCII name and a rename destination literally", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/my plan.md"), "one\ntwo\n");
    writeFileSync(join(dir, "src/café.ts"), "before\n");
    writeFileSync(join(dir, "src/old name.ts"), "rename body\n");
    commit("base");

    git(["checkout", "--quiet", "-b", "ticket"]);
    writeFileSync(join(dir, "ticket.txt"), "ticket work\n");
    commit("ticket work");

    git(["checkout", "--quiet", "main"]);
    writeFileSync(join(dir, "src/my plan.md"), "one\ntwo\nthree\n");
    writeFileSync(join(dir, "src/café.ts"), "after\n");
    renameSync(join(dir, "src/old name.ts"), join(dir, "src/new café.ts"));
    commit("main moves");
    const ticketTip = git(["rev-parse", "ticket"]).trim();

    git(["checkout", "--quiet", "ticket"]);
    const result = await syncWithBase(
      runGitCapturingAsync,
      { worktreePath: dir, branch: "ticket", baseBranch: "main" },
      "merge",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.status).toBe("merged");
    expect(result.value.mergedRef).toBe("main");
    // The merge commit itself plus the base commit it brought in.
    expect(result.value.commits).toBe(2);
    const diff = result.value.diff;
    expect(diff).not.toBeNull();
    expect(diff?.files.map((file) => file.path).toSorted()).toEqual([
      "src/café.ts",
      "src/my plan.md",
      "src/new café.ts",
    ]);
    expect(diff).toMatchObject({ insertions: 2, deletions: 1 });
    // The premise: the same range without `-z` C-quotes the café path, which is
    // what the old parse handed back as a path nobody could open.
    expect(git(["diff", "--numstat", `${ticketTip}..HEAD`])).toContain("\\303\\251");
  });

  it("lists a conflict on src/café.ts literally and leaves the merge in flight", async () => {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "notes"));
    const conflicted = ["notes/my plan.md", "src/café.ts", "src/line\nbreak.ts"];
    for (const path of conflicted) writeFileSync(join(dir, path), "base\n");
    commit("base");

    git(["checkout", "--quiet", "-b", "ticket"]);
    for (const path of conflicted) writeFileSync(join(dir, path), "ticket side\n");
    commit("ticket side");

    git(["checkout", "--quiet", "main"]);
    for (const path of conflicted) writeFileSync(join(dir, path), "main side\n");
    commit("main side");

    git(["checkout", "--quiet", "ticket"]);
    const result = await syncWithBase(
      runGitCapturingAsync,
      { worktreePath: dir, branch: "ticket", baseBranch: "main" },
      "merge",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.status).toBe("conflicted");
    expect(result.value.conflicts.toSorted()).toEqual(conflicted.toSorted());
    expect(result.value.diff).toEqual({ files: [], insertions: 0, deletions: 0 });
    // The merge is left in flight on purpose: the session resolving these paths
    // owns the conflicted checkout.
    expect(git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).trim()).toMatch(/^[0-9a-f]+$/);
    // The premise: without `-z` the same read C-quotes the non-ASCII name.
    expect(git(["diff", "--name-only", "--diff-filter=U"])).toContain("\\303\\251");
  });
});
