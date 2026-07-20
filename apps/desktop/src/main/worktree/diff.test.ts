import { describe, expect, it } from "vite-plus/test";

import { diffStat } from "./diff";
import { GitError } from "./git";
import { scriptedGit } from "./scripted-git";

describe("diffStat — working-tree mode", () => {
  it("sums tracked numstat and appends untracked files with null counts", () => {
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === "diff") return "3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n";
      if (args[0] === "status") return "?? src/new.ts\n M src/a.ts\n";
      return "";
    });
    const result = diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "working-tree");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.insertions).toBe(13);
    expect(result.value.deletions).toBe(1);
    expect(result.value.files).toEqual([
      { path: "src/a.ts", insertions: 3, deletions: 1, untracked: false },
      { path: "src/b.ts", insertions: 10, deletions: 0, untracked: false },
      { path: "src/new.ts", insertions: null, deletions: null, untracked: true },
    ]);
    // Working-tree diff is against HEAD, and it reads status for untracked.
    expect(calls.find((c) => c.args[0] === "diff")?.args).toEqual(["diff", "--numstat", "HEAD"]);
    expect(calls.some((c) => c.args[0] === "status")).toBe(true);
  });

  it("represents binary files (-\\t-) with null insertions/deletions, excluded from totals", () => {
    const { git } = scriptedGit((args) => {
      if (args[0] === "diff") return "-\t-\tassets/logo.png\n5\t2\tsrc/a.ts\n";
      if (args[0] === "status") return "";
      return "";
    });
    const result = diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "working-tree");
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

  it("ignores non-untracked porcelain lines (only ?? entries are appended)", () => {
    const { git } = scriptedGit((args) => {
      if (args[0] === "diff") return "";
      if (args[0] === "status") return " M src/a.ts\nA  src/staged.ts\n?? src/really-new.ts\n";
      return "";
    });
    const result = diffStat(git, { worktreePath: "/wt", baseBranch: null }, "working-tree");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      { path: "src/really-new.ts", insertions: null, deletions: null, untracked: true },
    ]);
  });

  it("returns err carrying stderr when the diff read fails", () => {
    const { git } = scriptedGit((args) => {
      if (args[0] === "diff") throw new GitError("failed", "fatal: bad revision HEAD", args);
      return "";
    });
    const result = diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "working-tree");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bad revision");
  });
});

describe("diffStat — merge-base mode", () => {
  it("diffs <base>...HEAD (three-dot) and never reads untracked", () => {
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === "diff") return "4\t0\tsrc/a.ts\n";
      return "";
    });
    const result = diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "merge-base");
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
      "main...HEAD",
    ]);
    expect(calls.some((c) => c.args[0] === "status")).toBe(false);
  });

  it("errs when the base branch is unknown", () => {
    const { git, calls } = scriptedGit(() => "");
    const result = diffStat(git, { worktreePath: "/wt", baseBranch: null }, "merge-base");
    expect(result.ok).toBe(false);
    // No git spawned — it fails fast on the missing base.
    expect(calls.length).toBe(0);
  });
});

describe("diffStat — rename path handling", () => {
  it("keeps the new path for a braced rename (common prefix/suffix)", () => {
    const { git } = scriptedGit((args) => {
      if (args[0] === "diff") return "2\t2\tsrc/{old.ts => new.ts}\n";
      return "";
    });
    const result = diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "merge-base");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files[0]?.path).toBe("src/new.ts");
  });

  it("keeps the new path for a whole-path rename (old => new, no braces)", () => {
    const { git } = scriptedGit((args) => {
      if (args[0] === "diff") return "1\t1\told/a.ts => new/b.ts\n";
      return "";
    });
    const result = diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "merge-base");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files[0]?.path).toBe("new/b.ts");
  });

  it("resolves a braced rename embedded mid-path (prefix/{old => new}/suffix)", () => {
    const { git } = scriptedGit((args) => {
      if (args[0] === "diff") return "0\t0\tsrc/{a => b}/index.ts\n";
      return "";
    });
    const result = diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "merge-base");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files[0]?.path).toBe("src/b/index.ts");
  });
});
