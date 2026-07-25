import { describe, expect, it } from "vite-plus/test";

import { changeSetSnapshot } from "./change-set";
import { scriptedGit } from "./scripted-git";

/** Scripted git that resolves local `main` and returns the given NUL payloads. */
function scriptedChangeSetGit(opts: {
  nameStatus?: string;
  numstat?: string;
  status?: string;
}): ReturnType<typeof scriptedGit> {
  return scriptedGit((args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no such ref");
    if (args[0] === "rev-parse" && args[1] === "main") return "basesha\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "headsha\n";
    if (args[0] === "diff" && args.includes("--name-status")) return opts.nameStatus ?? "";
    if (args[0] === "diff" && args.includes("--numstat")) return opts.numstat ?? "";
    if (args[0] === "status") return opts.status ?? "";
    return "";
  });
}

describe("changeSetSnapshot — clean worktree", () => {
  it("stamps resolved base and HEAD SHAs with an empty file list", () => {
    const { git, calls } = scriptedChangeSetGit({});

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseRevision).toBe("basesha");
    expect(result.value.headRevision).toBe("headsha");
    expect(result.value.files).toEqual([]);
    expect(result.value.insertions).toBe(0);
    expect(result.value.deletions).toBe(0);
    expect(result.value.revision.length).toBeGreaterThan(0);

    // Path-safety and rename detection are acceptance criteria — assert the argv contract.
    const nameStatus = calls.find((c) => c.args[0] === "diff" && c.args.includes("--name-status"));
    expect(nameStatus?.args).toContain("-z");
    expect(nameStatus?.args).toContain("-M");
    const numstat = calls.find((c) => c.args[0] === "diff" && c.args.includes("--numstat"));
    expect(numstat?.args).toContain("-z");
    expect(numstat?.args).toContain("-M");
  });
});

describe("changeSetSnapshot — NUL-delimited path safety", () => {
  it("keeps a modified path that contains spaces intact", () => {
    const path = "docs/my notes.md";
    const { git } = scriptedChangeSetGit({
      nameStatus: `M\0${path}\0`,
      numstat: `2\t1\0${path}\0`,
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      {
        path,
        status: "modified",
        insertions: 2,
        deletions: 1,
        binary: false,
      },
    ]);
    expect(result.value.insertions).toBe(2);
    expect(result.value.deletions).toBe(1);
  });

  it("keeps a modified path that contains Unicode characters intact", () => {
    const path = "src/café/日本語.ts";
    const { git } = scriptedChangeSetGit({
      nameStatus: `M\0${path}\0`,
      numstat: `1\t0\0${path}\0`,
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      {
        path,
        status: "modified",
        insertions: 1,
        deletions: 0,
        binary: false,
      },
    ]);
  });
});

describe("changeSetSnapshot — renames, binaries, additions, deletions", () => {
  it("retains both path and previousPath for a rename", () => {
    const { git } = scriptedChangeSetGit({
      nameStatus: "R100\0src/old.ts\0src/new.ts\0",
      numstat: "1\t1\0src/old.ts\0src/new.ts\0",
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        insertions: 1,
        deletions: 1,
        binary: false,
      },
    ]);
  });

  it("marks binary files with null counts and binary: true", () => {
    const { git } = scriptedChangeSetGit({
      nameStatus: "A\0assets/logo.png\0",
      numstat: "-\t-\0assets/logo.png\0",
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      {
        path: "assets/logo.png",
        status: "added",
        insertions: null,
        deletions: null,
        binary: true,
      },
    ]);
    expect(result.value.insertions).toBe(0);
    expect(result.value.deletions).toBe(0);
  });

  it("classifies additions and deletions", () => {
    const { git } = scriptedChangeSetGit({
      nameStatus: "A\0src/new.ts\0D\0src/gone.ts\0",
      numstat: "4\t0\0src/new.ts\0" + "0\t3\0src/gone.ts\0",
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      {
        path: "src/new.ts",
        status: "added",
        insertions: 4,
        deletions: 0,
        binary: false,
      },
      {
        path: "src/gone.ts",
        status: "deleted",
        insertions: 0,
        deletions: 3,
        binary: false,
      },
    ]);
    expect(result.value.insertions).toBe(4);
    expect(result.value.deletions).toBe(3);
  });
});
