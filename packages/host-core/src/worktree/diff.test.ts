import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { diffStat } from "./diff";
import { GitError, runGitCapturingAsync } from "./git";
import { scriptedReadOnlyGit } from "./scripted-git";

function runRepoGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("diffStat — working-tree mode", () => {
  it("sums tracked numstat and appends untracked files with null counts", async () => {
    const { gitAsync: git, calls } = scriptedReadOnlyGit((args) => {
      if (args[0] === "diff") return ["3\t1\tsrc/a.ts", "10\t0\tsrc/b.ts", ""].join("\0");
      if (args[0] === "ls-files") return "src/new.ts\0";
      return "";
    });
    const result = await diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "working-tree");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.insertions).toBe(13);
    expect(result.value.deletions).toBe(1);
    expect(result.value.files).toEqual([
      { path: "src/a.ts", insertions: 3, deletions: 1, untracked: false },
      { path: "src/b.ts", insertions: 10, deletions: 0, untracked: false },
      { path: "src/new.ts", insertions: null, deletions: null, untracked: true },
    ]);
    // Working-tree diff is against HEAD; ls-files enumerates individual untracked files.
    expect(calls.find((c) => c.args[0] === "diff")?.args).toEqual([
      "diff",
      "--numstat",
      "-z",
      "-M",
      "HEAD",
    ]);
    expect(calls.find((c) => c.args[0] === "ls-files")?.args).toEqual([
      "ls-files",
      "-o",
      "--exclude-standard",
      "-z",
    ]);
  });

  it("represents binary files (-\\t-) with null insertions/deletions, excluded from totals", async () => {
    const { gitAsync: git } = scriptedReadOnlyGit((args) => {
      if (args[0] === "diff") return ["-\t-\tassets/logo.png", "5\t2\tsrc/a.ts", ""].join("\0");
      if (args[0] === "ls-files") return "";
      return "";
    });
    const result = await diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "working-tree");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files[0]).toEqual({
      path: "assets/logo.png",
      insertions: null,
      deletions: null,
      untracked: false,
    });
    expect(result.value.insertions).toBe(5);
    expect(result.value.deletions).toBe(2);
  });

  it("appends only paths returned by the untracked file listing", async () => {
    const { gitAsync: git } = scriptedReadOnlyGit((args) => {
      if (args[0] === "diff") return "";
      if (args[0] === "ls-files") return "src/really-new.ts\0";
      return "";
    });
    const result = await diffStat(git, { worktreePath: "/wt", baseBranch: null }, "working-tree");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      { path: "src/really-new.ts", insertions: null, deletions: null, untracked: true },
    ]);
  });

  it("returns err carrying stderr when the diff read fails", async () => {
    const { gitAsync: git } = scriptedReadOnlyGit((args) => {
      if (args[0] === "diff") throw new GitError("failed", "fatal: bad revision HEAD", args);
      return "";
    });
    const result = await diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "working-tree");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bad revision");
  });
});

describe("diffStat — merge-base mode", () => {
  it("diffs <base>...HEAD (three-dot) and never reads untracked", async () => {
    const { gitAsync: git, calls } = scriptedReadOnlyGit((args) => {
      if (args[0] === "diff") return "4\t0\tsrc/a.ts\0";
      // No remote-tracking ref — comparisons stay on the local base.
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no such ref");
      return "";
    });
    const result = await diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "merge-base");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      files: [{ path: "src/a.ts", insertions: 4, deletions: 0, untracked: false }],
      insertions: 4,
      deletions: 0,
    });
    expect(calls.find((c) => c.args[0] === "diff")?.args).toEqual([
      "diff",
      "--numstat",
      "-z",
      "-M",
      "main...HEAD",
    ]);
    expect(calls.some((c) => c.args[0] === "ls-files")).toBe(false);
  });

  it("diffs against origin/<base> when the remote-tracking ref exists", async () => {
    const { gitAsync: git, calls } = scriptedReadOnlyGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") return "abc123\n";
      if (args[0] === "diff") return "4\t0\tsrc/a.ts\0";
      return "";
    });
    const result = await diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "merge-base");
    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.args[0] === "diff")?.args).toEqual([
      "diff",
      "--numstat",
      "-z",
      "-M",
      "origin/main...HEAD",
    ]);
  });

  it("errs when the base branch is unknown", async () => {
    const { gitAsync: git, calls } = scriptedReadOnlyGit(() => "");
    const result = await diffStat(git, { worktreePath: "/wt", baseBranch: null }, "merge-base");
    expect(result.ok).toBe(false);
    // No git spawned — it fails fast on the missing base.
    expect(calls.length).toBe(0);
  });
});

describe("diffStat — rename path handling", () => {
  it("keeps the new path for a rename with a common prefix", async () => {
    const { gitAsync: git } = scriptedReadOnlyGit((args) => {
      if (args[0] === "diff") return "2\t2\t\0src/old.ts\0src/new.ts\0";
      return "";
    });
    const result = await diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "merge-base");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files[0]?.path).toBe("src/new.ts");
  });

  it("keeps the new path for a whole-path rename", async () => {
    const { gitAsync: git } = scriptedReadOnlyGit((args) => {
      if (args[0] === "diff") return "1\t1\t\0old/a.ts\0new/b.ts\0";
      return "";
    });
    const result = await diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "merge-base");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files[0]?.path).toBe("new/b.ts");
  });

  it("keeps the new path for a renamed directory", async () => {
    const { gitAsync: git } = scriptedReadOnlyGit((args) => {
      if (args[0] === "diff") return "0\t0\t\0src/a/index.ts\0src/b/index.ts\0";
      return "";
    });
    const result = await diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "merge-base");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files[0]?.path).toBe("src/b/index.ts");
  });
});

describe("diffStat — real git paths", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.each(["working-tree", "merge-base"] as const)(
    "%s preserves literal tracked paths and rename destinations",
    async (mode) => {
      const dir = mkdtempSync(join(process.cwd(), ".volli-diff-test-"));
      tempDirs.push(dir);
      runRepoGit(dir, "init", "-q", "-b", "main");
      for (const [key, value] of Object.entries({
        "user.name": "Volli Test",
        "user.email": "test@volli.local",
        "commit.gpgSign": "false",
        "core.hooksPath": "/dev/null",
        "core.quotePath": "true",
        "core.autocrlf": "false",
        "diff.renames": "false",
      }))
        runRepoGit(dir, "config", key, value);
      mkdirSync(join(dir, "src"));
      const trackedPaths = [
        "src/my plan.md",
        "src/café.ts",
        "src/tab\tname.ts",
        "src/line\nbreak.ts",
        "src/{old => new}.ts",
      ];
      for (const path of trackedPaths) writeFileSync(join(dir, path), "before\n");
      writeFileSync(join(dir, "src/old name.ts"), "rename body\n");
      writeFileSync(join(dir, ".gitignore"), "ignored/\n");
      runRepoGit(dir, "add", ".");
      runRepoGit(dir, "commit", "-qm", "base");
      runRepoGit(dir, "checkout", "-qb", "ticket");
      for (const path of trackedPaths) writeFileSync(join(dir, path), "after\n");
      renameSync(join(dir, "src/old name.ts"), join(dir, "src/new café.ts"));
      runRepoGit(dir, "add", ".");
      if (mode === "merge-base") runRepoGit(dir, "commit", "-qm", "changes");
      mkdirSync(join(dir, "notes/deep"), { recursive: true });
      writeFileSync(join(dir, "notes/deep/my plan.md"), "untracked\n");
      mkdirSync(join(dir, "ignored"));
      writeFileSync(join(dir, "ignored/secret.md"), "ignored\n");

      const result = await diffStat(
        runGitCapturingAsync,
        { worktreePath: dir, baseBranch: "main" },
        mode,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        files: expect.arrayContaining([
          ...trackedPaths.map((path) => ({ path, insertions: 1, deletions: 1, untracked: false })),
          { path: "src/new café.ts", insertions: 0, deletions: 0, untracked: false },
          ...(mode === "working-tree"
            ? [
                {
                  path: "notes/deep/my plan.md",
                  insertions: null,
                  deletions: null,
                  untracked: true,
                },
              ]
            : []),
        ]),
        insertions: trackedPaths.length,
        deletions: trackedPaths.length,
      });
      expect(result.value.files).toHaveLength(
        trackedPaths.length + (mode === "working-tree" ? 2 : 1),
      );
    },
  );
});
