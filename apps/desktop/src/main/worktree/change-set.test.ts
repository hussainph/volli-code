import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CHANGE_SET_FILE_CAP } from "@volli/shared";

import { changeSetSnapshot, readChangeSetBaseFile } from "./change-set";
import { GitError, runGitCapturingAsync } from "./git";
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

/**
 * Scripted git that resolves local `main` and returns the given NUL payloads.
 * The merge base (`basesha`) and `main`'s tip (`tipsha`) are deliberately
 * DIFFERENT so every assertion on `baseRevision` proves which one was stamped.
 */
function scriptedChangeSetGit(opts: {
  nameStatus?: string;
  numstat?: string;
  status?: string;
}): ReturnType<typeof scriptedGit> {
  return scriptedGit((args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no such ref");
    if (args[0] === "merge-base") return "basesha\n";
    if (args[0] === "rev-parse" && args[1] === "main") return "tipsha\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "headsha\n";
    if (args[0] === "diff" && args.includes("--name-status")) return opts.nameStatus ?? "";
    if (args[0] === "diff" && args.includes("--numstat")) return opts.numstat ?? "";
    if (args[0] === "status") return opts.status ?? "";
    return "";
  });
}

describe("changeSetSnapshot — merge-base stamping", () => {
  it("stamps the merge base and diffs both reads against it, never the base tip", async () => {
    const { gitAsync, calls } = scriptedChangeSetGit({});

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseRevision).toBe("basesha");
    expect(calls.some((c) => c.args[0] === "merge-base")).toBe(true);

    const diffs = calls.filter((c) => c.args[0] === "diff");
    expect(diffs).toHaveLength(2);
    for (const diff of diffs) {
      expect(diff.args).toContain("basesha");
      expect(diff.args).not.toContain("tipsha");
    }
  });

  it("reuses the remote-tracking probe's SHA rather than re-resolving the tip", async () => {
    const { gitAsync, calls } = scriptedGit((args) => {
      // `rev-parse --verify` PRINTS the SHA it verified.
      if (args[0] === "rev-parse" && args[1] === "--verify") return "remotetip\n";
      if (args[0] === "merge-base") throw new GitError("failed", "fatal: no merge base", args);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "headsha\n";
      return "";
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseRevision).toBe("remotetip");
    const tipResolves = calls.filter(
      (c) => c.args[0] === "rev-parse" && c.args[1] === "origin/main",
    );
    expect(tipResolves).toHaveLength(0);
  });

  it("falls back to the comparison ref tip when merge-base cannot be computed", async () => {
    const { gitAsync } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no such ref");
      if (args[0] === "merge-base") throw new GitError("failed", "fatal: no merge base", args);
      if (args[0] === "rev-parse" && args[1] === "main") return "tipsha\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "headsha\n";
      return "";
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseRevision).toBe("tipsha");
  });
});

describe("changeSetSnapshot — clean worktree", () => {
  it("stamps resolved base and HEAD SHAs with an empty file list", async () => {
    const { gitAsync, calls } = scriptedChangeSetGit({});

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

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
  it("keeps a modified path that contains spaces intact", async () => {
    const path = "docs/my notes.md";
    const { gitAsync } = scriptedChangeSetGit({
      nameStatus: `M\0${path}\0`,
      numstat: `2\t1\t${path}\0`,
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

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

  it("keeps a modified path that contains Unicode characters intact", async () => {
    const path = "src/café/日本語.ts";
    const { gitAsync } = scriptedChangeSetGit({
      nameStatus: `M\0${path}\0`,
      numstat: `1\t0\t${path}\0`,
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

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
  it("retains both path and previousPath for a rename", async () => {
    const { gitAsync } = scriptedChangeSetGit({
      nameStatus: "R100\0src/old.ts\0src/new.ts\0",
      numstat: "1\t1\t\0src/old.ts\0src/new.ts\0",
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

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

  it("marks binary files with null counts and binary: true", async () => {
    const { gitAsync } = scriptedChangeSetGit({
      nameStatus: "A\0assets/logo.png\0",
      numstat: "-\t-\tassets/logo.png\0",
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

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

  it("classifies additions and deletions", async () => {
    const { gitAsync } = scriptedChangeSetGit({
      nameStatus: z("A", "src/new.ts", "D", "src/gone.ts"),
      numstat: z("4\t0\tsrc/new.ts", "0\t3\tsrc/gone.ts"),
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

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
  it("surfaces unmerged (U) paths as conflicted instead of dropping them", async () => {
    const { gitAsync } = scriptedChangeSetGit({
      nameStatus: z("U", "src/conflict.ts"),
      numstat: z("1\t1\tsrc/conflict.ts"),
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

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

  it("never silently drops an unrecognized name-status code", async () => {
    const { gitAsync } = scriptedChangeSetGit({
      nameStatus: z("X", "src/weird.ts"),
      numstat: z("0\t0\tsrc/weird.ts"),
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

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

  it("upgrades a path to conflicted when porcelain v2 reports it unmerged", async () => {
    // Real `git diff <base>` emits M for conflicted files; honesty comes from status.
    const { gitAsync } = scriptedChangeSetGit({
      nameStatus: z("M", "src/conflict.ts"),
      numstat: z("1\t1\tsrc/conflict.ts"),
      status: z("u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts"),
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

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
  it("appends untracked paths from porcelain v2 with null counts", async () => {
    const path = "new file.txt";
    const { gitAsync, calls } = scriptedChangeSetGit({
      status: `? ${path}\0`,
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

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
    expect(statusCall?.args).toEqual(["status", "--porcelain=v2", "-z", "-uall"]);
  });
});

describe("changeSetSnapshot — unified outcome", () => {
  it("lists committed, dirty, and untracked outcomes together in one snapshot", async () => {
    // Simulates: a committed add (relative to base), a dirty modify, and an untracked file.
    const { gitAsync } = scriptedChangeSetGit({
      nameStatus: z("A", "src/committed.ts", "M", "src/dirty.ts"),
      numstat: z("5\t0\tsrc/committed.ts", "3\t1\tsrc/dirty.ts"),
      status: z("? untracked.txt"),
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

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

describe("changeSetSnapshot — file cap", () => {
  it("keeps the whole list when it fits under the cap", async () => {
    const paths = Array.from({ length: 3 }, (_, i) => `f${i}.txt`);
    const { gitAsync } = scriptedChangeSetGit({
      status: z(...paths.map((p) => `? ${p}`)),
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(false);
    expect(result.value.totalCount).toBe(3);
    expect(result.value.files).toHaveLength(3);
  });

  it("cuts a runaway untracked tree to the cap and reports the real total", async () => {
    const overflow = 25;
    const untracked = Array.from(
      { length: CHANGE_SET_FILE_CAP + overflow },
      (_, i) => `? node_modules/pkg/f${i}.js`,
    );
    const { gitAsync } = scriptedChangeSetGit({
      nameStatus: z("M", "src/real.ts"),
      numstat: z("4\t2\tsrc/real.ts"),
      status: z(...untracked),
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.files).toHaveLength(CHANGE_SET_FILE_CAP);
    expect(result.value.totalCount).toBe(CHANGE_SET_FILE_CAP + overflow + 1);
    // The tracked entry composes first, so the cut only ever loses untracked tail.
    expect(result.value.files[0]?.path).toBe("src/real.ts");
    // Totals are counted before the cut — the summary still describes everything.
    expect(result.value.insertions).toBe(4);
    expect(result.value.deletions).toBe(2);
  });

  it("moves the revision when files grow past the cap", async () => {
    const snapshotWith = async (count: number) => {
      const { gitAsync } = scriptedChangeSetGit({
        status: z(...Array.from({ length: count }, (_, i) => `? f${i}.txt`)),
      });
      const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });
      expect(result.ok).toBe(true);
      return result.ok ? result.value.revision : "";
    };

    // Both snapshots carry an identical capped `files`; only the hidden tail
    // differs, so without the total in the fingerprint this would read as "no
    // change" and the list would never refresh.
    const first = await snapshotWith(CHANGE_SET_FILE_CAP + 1);
    const second = await snapshotWith(CHANGE_SET_FILE_CAP + 2);
    expect(first).not.toBe(second);
  });
});

describe("changeSetSnapshot — failures", () => {
  it("errs when no base branch is known", async () => {
    const { gitAsync, calls } = scriptedGit(() => "");
    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/base branch/i);
    expect(calls).toHaveLength(0);
  });

  it("surfaces real git stderr when a read fails", async () => {
    const { gitAsync } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no such ref");
      if (args[0] === "merge-base" || (args[0] === "rev-parse" && args[1] === "main")) {
        throw new GitError("failed", "fatal: bad object main", args);
      }
      return "";
    });

    const result = await changeSetSnapshot(gitAsync, { worktreePath: "/wt", baseBranch: "main" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bad object");
  });
});

describe("readChangeSetBaseFile", () => {
  it("reads file contents at the base revision via git show", async () => {
    const { gitAsync, calls } = scriptedGit((args) => {
      if (args[0] === "cat-file") return "";
      if (args[0] === "show") return "hello from base\n";
      return "";
    });

    const result = await readChangeSetBaseFile(gitAsync, {
      worktreePath: "/wt",
      baseRevision: "basesha",
      path: "src/a.ts",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ content: "hello from base\n" });
    expect(calls.map((c) => c.args)).toEqual([
      ["cat-file", "-e", "basesha:src/a.ts"],
      ["show", "basesha:src/a.ts"],
    ]);
  });

  it("rejects path traversal outside the worktree", async () => {
    const { gitAsync, calls } = scriptedGit(() => "secret");
    const result = await readChangeSetBaseFile(gitAsync, {
      worktreePath: "/wt",
      baseRevision: "basesha",
      path: "../secret.txt",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/path/i);
    expect(calls).toHaveLength(0);
  });

  it("returns missing via cat-file probe without depending on stderr locale", async () => {
    const { gitAsync, calls } = scriptedGit((args) => {
      if (args[0] === "cat-file" && args[2]?.includes(":")) {
        // Non-English / nonsense stderr — must not be required for missing detection.
        throw new GitError("failed", "fatal: Pfad existiert nicht in 'basesha'", args);
      }
      if (args[0] === "cat-file") return ""; // revision itself exists
      return "";
    });
    const result = await readChangeSetBaseFile(gitAsync, {
      worktreePath: "/wt",
      baseRevision: "basesha",
      path: "src/new.ts",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ missing: true });
    expect(calls.map((c) => c.args[0])).toEqual(["cat-file", "cat-file"]);
    expect(calls.some((c) => c.args[0] === "show")).toBe(false);
  });

  it("surfaces real git stderr when the base revision itself is invalid", async () => {
    const { gitAsync } = scriptedGit((args) => {
      throw new GitError("failed", "fatal: bad object basesha", args);
    });
    const result = await readChangeSetBaseFile(gitAsync, {
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

  it("composes committed, staged, unstaged, untracked, rename, delete, binary, and special paths", async () => {
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

    // Untracked with space + Unicode; nested so -uall must expand the directory.
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "my notes 日本語.txt"), "untracked\n");
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(
      join(dir, "assets", "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    );

    // Tracked binary addition (numstat emits -/-).
    writeFileSync(join(dir, "asset.bin"), Buffer.from([0x00, 0x01, 0xff]));
    runRepoGit(dir, ["add", "asset.bin"]);

    const result = await changeSetSnapshot(runGitCapturingAsync, {
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
    expect(byPath.get("docs/my notes 日本語.txt")).toMatchObject({
      status: "untracked",
      insertions: null,
      deletions: null,
    });
    expect(byPath.get("assets/logo.png")?.status).toBe("untracked");
    expect(byPath.get("asset.bin")).toMatchObject({
      status: "added",
      binary: true,
      insertions: null,
      deletions: null,
    });

    // Base read must not mutate the working tree.
    const before = readFileSync(join(dir, "tracked.ts"));
    const baseRead = await readChangeSetBaseFile(runGitCapturingAsync, {
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

  it("ignores commits that landed on the base after the fork", async () => {
    const dir = makeRepo();

    runRepoGit(dir, ["checkout", "-b", "ticket"]);
    writeFileSync(join(dir, "ticket-work.ts"), "ticket work\n");
    runRepoGit(dir, ["add", "ticket-work.ts"]);
    runRepoGit(dir, ["commit", "-q", "-m", "ticket work"]);

    // Someone else moves main forward AFTER the fork: a new file and a deletion.
    // Measured from main's tip these invert into the ticket's own outcome — the
    // teammate's addition reads as Deleted, their deletion reads as Added.
    runRepoGit(dir, ["checkout", "-q", "main"]);
    writeFileSync(join(dir, "teammate.ts"), "not ours\n");
    runRepoGit(dir, ["add", "teammate.ts"]);
    runRepoGit(dir, ["rm", "-q", "keep.ts"]);
    runRepoGit(dir, ["commit", "-q", "-m", "teammate work"]);
    runRepoGit(dir, ["checkout", "-q", "ticket"]);

    const result = await changeSetSnapshot(runGitCapturingAsync, {
      worktreePath: dir,
      baseBranch: "main",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.map((f) => [f.path, f.status])).toEqual([
      ["ticket-work.ts", "added"],
    ]);
    expect(result.value.insertions).toBe(1);
    expect(result.value.deletions).toBe(0);
    // The stamp is the fork point, not main's tip.
    expect(result.value.baseRevision).toBe(runRepoGit(dir, ["merge-base", "main", "HEAD"]).trim());
    expect(result.value.baseRevision).not.toBe(runRepoGit(dir, ["rev-parse", "main"]).trim());
  });

  it("reports a NUL-bearing base blob as binary rather than mojibake", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "asset.bin"), Buffer.from([0x01, 0x02, 0x00, 0x03, 0xff]));
    runRepoGit(dir, ["add", "asset.bin"]);
    runRepoGit(dir, ["commit", "-q", "-m", "binary"]);
    const head = runRepoGit(dir, ["rev-parse", "HEAD"]).trim();

    const read = await readChangeSetBaseFile(runGitCapturingAsync, {
      worktreePath: dir,
      baseRevision: head,
      path: "asset.bin",
    });

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual({ binary: true });
  });

  it("reads the pinned revision even after the merge base moves", async () => {
    const dir = makeRepo();
    const forkPoint = runRepoGit(dir, ["rev-parse", "HEAD"]).trim();

    runRepoGit(dir, ["checkout", "-b", "ticket"]);
    writeFileSync(join(dir, "tracked.ts"), "line one\nline two\n");
    runRepoGit(dir, ["add", "tracked.ts"]);
    runRepoGit(dir, ["commit", "-q", "-m", "ticket work"]);
    // main catches up to the ticket, so the merge base is no longer the fork.
    runRepoGit(dir, ["checkout", "-q", "main"]);
    runRepoGit(dir, ["merge", "-q", "--ff-only", "ticket"]);
    runRepoGit(dir, ["checkout", "-q", "ticket"]);
    expect(runRepoGit(dir, ["merge-base", "main", "HEAD"]).trim()).not.toBe(forkPoint);

    const pinned = await readChangeSetBaseFile(runGitCapturingAsync, {
      worktreePath: dir,
      baseRevision: forkPoint,
      path: "tracked.ts",
    });

    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.value).toEqual({ content: "line one\n" });
  });

  it("marks a real merge conflict as conflicted relative to the base", async () => {
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

    const result = await changeSetSnapshot(runGitCapturingAsync, {
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
