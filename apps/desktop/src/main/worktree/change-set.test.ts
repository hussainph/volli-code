import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { changeSetSnapshot, readChangeSetBaseFile } from "./change-set";
import { GitError, runGitCapturing } from "./git";
import { scriptedGit } from "./scripted-git";

/** Join NUL-terminated git -z fields without octal-escape hazards (`\03` ≠ NUL+"3"). */
function z(...fields: string[]): string {
  return fields.length === 0 ? "" : `${fields.join("\0")}\0`;
}

function runRepoGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Volli Test",
      GIT_AUTHOR_EMAIL: "test@volli.local",
      GIT_COMMITTER_NAME: "Volli Test",
      GIT_COMMITTER_EMAIL: "test@volli.local",
    },
  });
}

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
      numstat: `2\t1\t${path}\0`,
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
      numstat: `1\t0\t${path}\0`,
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
      numstat: "1\t1\t\0src/old.ts\0src/new.ts\0",
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
      numstat: "-\t-\tassets/logo.png\0",
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
      nameStatus: z("A", "src/new.ts", "D", "src/gone.ts"),
      numstat: z("4\t0\tsrc/new.ts", "0\t3\tsrc/gone.ts"),
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

describe("changeSetSnapshot — conflicted / unrecognized status", () => {
  it("surfaces unmerged (U) paths as conflicted instead of dropping them", () => {
    const { git } = scriptedChangeSetGit({
      nameStatus: z("U", "src/conflict.ts"),
      numstat: z("1\t1\tsrc/conflict.ts"),
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      {
        path: "src/conflict.ts",
        status: "conflicted",
        insertions: 1,
        deletions: 1,
        binary: false,
      },
    ]);
  });

  it("never silently drops an unrecognized name-status code", () => {
    const { git } = scriptedChangeSetGit({
      nameStatus: z("X", "src/weird.ts"),
      numstat: z("0\t0\tsrc/weird.ts"),
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      {
        path: "src/weird.ts",
        status: "conflicted",
        insertions: 0,
        deletions: 0,
        binary: false,
      },
    ]);
  });

  it("upgrades a path to conflicted when porcelain v2 reports it unmerged", () => {
    // Real `git diff <base>` emits M for conflicted files; honesty comes from status.
    const { git } = scriptedChangeSetGit({
      nameStatus: z("M", "src/conflict.ts"),
      numstat: z("1\t1\tsrc/conflict.ts"),
      status: z("u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts"),
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      {
        path: "src/conflict.ts",
        status: "conflicted",
        insertions: 1,
        deletions: 1,
        binary: false,
      },
    ]);
  });
});

describe("changeSetSnapshot — untracked", () => {
  it("appends untracked paths from porcelain v2 with null counts", () => {
    const path = "new file.txt";
    const { git, calls } = scriptedChangeSetGit({
      status: `? ${path}\0`,
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([
      {
        path,
        status: "untracked",
        insertions: null,
        deletions: null,
        binary: false,
      },
    ]);
    const statusCall = calls.find((c) => c.args[0] === "status");
    expect(statusCall?.args).toEqual(["status", "--porcelain=v2", "-z"]);
  });
});

describe("changeSetSnapshot — unified outcome", () => {
  it("lists committed, dirty, and untracked outcomes together in one snapshot", () => {
    // Simulates: a committed add (relative to base), a dirty modify, and an untracked file.
    const { git } = scriptedChangeSetGit({
      nameStatus: z("A", "src/committed.ts", "M", "src/dirty.ts"),
      numstat: z("5\t0\tsrc/committed.ts", "3\t1\tsrc/dirty.ts"),
      status: z("? untracked.txt"),
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.map((f) => [f.path, f.status])).toEqual([
      ["src/committed.ts", "added"],
      ["src/dirty.ts", "modified"],
      ["untracked.txt", "untracked"],
    ]);
    expect(result.value.insertions).toBe(8);
    expect(result.value.deletions).toBe(1);
  });
});

describe("changeSetSnapshot — failures", () => {
  it("errs when no base branch is known", () => {
    const { git, calls } = scriptedGit(() => "");
    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/base branch/i);
    expect(calls).toHaveLength(0);
  });

  it("surfaces real git stderr when a read fails", async () => {
    const { git } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no such ref");
      if (args[0] === "rev-parse" && args[1] === "main") {
        throw new GitError("failed", "fatal: bad object main", args);
      }
      return "";
    });

    const result = changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bad object");
  });
});

describe("readChangeSetBaseFile", () => {
  it("reads file contents at the base revision via git show", () => {
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === "show") return "hello from base\n";
      return "";
    });

    const result = readChangeSetBaseFile(git, {
      worktreePath: "/wt",
      baseRevision: "basesha",
      path: "src/a.ts",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ content: "hello from base\n" });
    expect(calls[0]?.args).toEqual(["show", "basesha:src/a.ts"]);
  });

  it("rejects path traversal outside the worktree", () => {
    const { git, calls } = scriptedGit(() => "secret");
    const result = readChangeSetBaseFile(git, {
      worktreePath: "/wt",
      baseRevision: "basesha",
      path: "../secret.txt",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/path/i);
    expect(calls).toHaveLength(0);
  });

  it("returns missing when the path is absent at the base revision", () => {
    const { git } = scriptedGit((args) => {
      throw new GitError("failed", "fatal: path 'src/new.ts' does not exist in 'basesha'", args);
    });
    const result = readChangeSetBaseFile(git, {
      worktreePath: "/wt",
      baseRevision: "basesha",
      path: "src/new.ts",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ missing: true });
  });

  it("surfaces real git stderr for non-missing failures", () => {
    const { git } = scriptedGit((args) => {
      throw new GitError("failed", "fatal: bad object basesha", args);
    });
    const result = readChangeSetBaseFile(git, {
      worktreePath: "/wt",
      baseRevision: "basesha",
      path: "src/a.ts",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bad object");
  });
});

describe("changeSetSnapshot — real git repository", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "volli-changeset-"));
    tempDirs.push(dir);
    runRepoGit(dir, ["init", "-q"]);
    // Ensure the default branch is `main` regardless of the host's init.defaultBranch.
    runRepoGit(dir, ["checkout", "-b", "main"]);
    writeFileSync(join(dir, "tracked.ts"), "line one\n");
    writeFileSync(join(dir, "keep.ts"), "keep\n");
    writeFileSync(join(dir, "rename-me.ts"), "rename body\n");
    writeFileSync(join(dir, "delete-me.ts"), "delete me\n");
    runRepoGit(dir, ["add", "."]);
    runRepoGit(dir, ["commit", "-q", "-m", "base"]);
    return dir;
  }

  it("composes committed, staged, unstaged, untracked, rename, delete, binary, and special paths", () => {
    const dir = makeRepo();

    // Committed change on a branch (relative to main / base).
    runRepoGit(dir, ["checkout", "-b", "ticket"]);
    writeFileSync(join(dir, "tracked.ts"), "line one\nline two\n");
    runRepoGit(dir, ["add", "tracked.ts"]);
    runRepoGit(dir, ["commit", "-q", "-m", "commit change"]);

    // Staged modify.
    writeFileSync(join(dir, "keep.ts"), "keep\nstaged\n");
    runRepoGit(dir, ["add", "keep.ts"]);

    // Unstaged further modify of the committed file.
    writeFileSync(join(dir, "tracked.ts"), "line one\nline two\nline three\n");

    // Rename (staged) + delete (staged).
    runRepoGit(dir, ["mv", "rename-me.ts", "renamed.ts"]);
    runRepoGit(dir, ["rm", "-q", "delete-me.ts"]);

    // Untracked with space + Unicode; binary untracked.
    writeFileSync(join(dir, "my notes 日本語.txt"), "untracked\n");
    writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    // Tracked binary addition (numstat emits -/-).
    writeFileSync(join(dir, "asset.bin"), Buffer.from([0x00, 0x01, 0xff]));
    runRepoGit(dir, ["add", "asset.bin"]);

    const result = changeSetSnapshot(runGitCapturing, {
      worktreePath: dir,
      baseBranch: "main",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byPath = new Map(result.value.files.map((f) => [f.path, f]));
    expect(byPath.get("tracked.ts")?.status).toBe("modified");
    expect(byPath.get("keep.ts")?.status).toBe("modified");
    expect(byPath.get("renamed.ts")).toMatchObject({
      status: "renamed",
      previousPath: "rename-me.ts",
    });
    expect(byPath.get("delete-me.ts")?.status).toBe("deleted");
    expect(byPath.get("my notes 日本語.txt")).toMatchObject({
      status: "untracked",
      insertions: null,
      deletions: null,
    });
    expect(byPath.get("logo.png")?.status).toBe("untracked");
    expect(byPath.get("asset.bin")).toMatchObject({
      status: "added",
      binary: true,
      insertions: null,
      deletions: null,
    });

    // Base read must not mutate the working tree.
    const before = readFileSync(join(dir, "tracked.ts"));
    const baseRead = readChangeSetBaseFile(runGitCapturing, {
      worktreePath: dir,
      baseRevision: result.value.baseRevision,
      path: "tracked.ts",
    });
    expect(baseRead.ok).toBe(true);
    if (!baseRead.ok) return;
    expect(baseRead.value).toEqual({ content: "line one\n" });
    expect(readFileSync(join(dir, "tracked.ts"))).toEqual(before);

    // Status still dirty after the base read (prove we didn't checkout).
    const status = runRepoGit(dir, ["status", "--porcelain"]);
    expect(status.length).toBeGreaterThan(0);
  });

  it("marks a real merge conflict as conflicted relative to the base", () => {
    const dir = mkdtempSync(join(tmpdir(), "volli-changeset-conflict-"));
    tempDirs.push(dir);
    runRepoGit(dir, ["init", "-q"]);
    runRepoGit(dir, ["checkout", "-b", "main"]);
    writeFileSync(join(dir, "conflict.ts"), "base\n");
    runRepoGit(dir, ["add", "."]);
    runRepoGit(dir, ["commit", "-q", "-m", "base"]);

    runRepoGit(dir, ["checkout", "-b", "left"]);
    writeFileSync(join(dir, "conflict.ts"), "left\n");
    runRepoGit(dir, ["add", "."]);
    runRepoGit(dir, ["commit", "-q", "-m", "left"]);

    runRepoGit(dir, ["checkout", "main"]);
    runRepoGit(dir, ["checkout", "-b", "right"]);
    writeFileSync(join(dir, "conflict.ts"), "right\n");
    runRepoGit(dir, ["add", "."]);
    runRepoGit(dir, ["commit", "-q", "-m", "right"]);

    try {
      runRepoGit(dir, ["merge", "left", "--no-edit"]);
    } catch {
      // Expected: content conflict leaves the worktree unmerged.
    }

    const result = changeSetSnapshot(runGitCapturing, {
      worktreePath: dir,
      baseBranch: "main",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.find((f) => f.path === "conflict.ts")).toMatchObject({
      status: "conflicted",
    });
  });
});
