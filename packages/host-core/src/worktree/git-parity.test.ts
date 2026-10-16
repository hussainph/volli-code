import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GitError, runGitCapturing, runGitCapturingAsync } from "./git";
import type { RunGit, RunGitAsync } from "./types";

interface Repository {
  root: string;
  dir: string;
  raw: (args: readonly string[], cwd?: string) => string;
  commit: (message: string, cwd?: string) => void;
}

function rawGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalize(output: string, repo: Repository): string {
  return output.replaceAll(repo.root, "<fixture>");
}

function repository(root: string): Repository {
  const dir = join(root, "repo");
  mkdirSync(dir, { recursive: true });
  const raw = (args: readonly string[], cwd?: string): string => rawGit(args, cwd ?? dir);
  const commit = (message: string, cwd = dir): void => {
    raw(["add", "-A"], cwd);
    raw(["commit", "--quiet", "-m", message], cwd);
  };
  raw(["init", "--quiet", "--initial-branch=main"]);
  raw(["config", "user.name", "Test"]);
  raw(["config", "user.email", "test@example.com"]);
  raw(["config", "commit.gpgsign", "false"]);
  raw(["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "-file.txt"), "initial\n");
  writeFileSync(join(dir, "ünï cødé.txt"), "unicode\n");
  commit("initial");
  return { root, dir, raw, commit };
}

const runners: readonly { name: string; run: RunGit | RunGitAsync }[] = [
  { name: "sync", run: runGitCapturing },
  { name: "async", run: runGitCapturingAsync },
];

describe("local git separator parity with raw git", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(process.cwd(), ".git-parity-test-")));
    // No user config, helpers or signing settings; identical fixture commits
    // also make mutation stdout and resulting revisions directly comparable.
    const config = join(root, "global.config");
    writeFileSync(config, "");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z");
    vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves stdout across production read shapes, refs, ranges and literal paths", async () => {
    const { dir, raw, commit } = repository(join(root, "reads"));
    // A local remote-tracking ref is sufficient: parity requires no network.
    raw(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    raw(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    for (const branch of ["feat/ü-x", "a@b", "x{y}", "dots.and_under", "feat/--double"]) {
      raw(["branch", branch]);
    }
    writeFileSync(join(dir, "two.txt"), "two\n");
    commit("second");
    const head = raw(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "two.txt"), "changed\nextra\n");
    writeFileSync(join(dir, "untracked.txt"), "untracked\n");
    writeFileSync(join(dir, ".gitignore"), "ignored/\n");
    mkdirSync(join(dir, "ignored"));
    writeFileSync(join(dir, "ignored", "file.txt"), "ignored\n");
    raw(["config", "credential.helper", "parity-test-helper"]);

    // Every separator-inserting read branch of localGitArgs is represented.
    // Keep representative option combinations too: moving the fence can turn
    // a ref into a path, or an option into an operand, without making git fail.
    const reads: readonly (readonly string[])[] = [
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      ["branch", "--show-current"],
      ["for-each-ref", "refs/heads", "--sort=-committerdate", "--format=%(refname:short)"],
      ["for-each-ref", "refs/remotes", "--sort=-committerdate", "--format=%(refname:short)"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "main"],
      ["rev-parse", "origin/main"],
      ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"],
      ["rev-parse", "--verify", "main^{commit}"],
      ...["feat/ü-x", "a@b", "x{y}", "dots.and_under", "feat/--double"].map((branch) => [
        "rev-parse",
        "--verify",
        "--quiet",
        branch,
      ]),
      ["rev-parse", "--git-dir"],
      ["rev-parse", "--git-common-dir"],
      ["rev-parse", "--git-path", "FETCH_HEAD"],
      ["rev-parse", "--git-path", "HEAD"],
      ["status", "--porcelain"],
      ["status", "--porcelain=v2", "-z", "-uall"],
      ["rev-list", "--left-right", "--count", "main...feat/ü-x"],
      ["rev-list", "--count", "refs/remotes/origin/main..main"],
      ["rev-list", "--count", "feat/ü-x..main"],
      ["diff", "--numstat", "HEAD"],
      ["diff", "--numstat", "origin/main...HEAD"],
      ["diff", "--numstat", "origin/main..main"],
      ["diff", "--numstat", "origin/main", "HEAD"],
      ["diff", "--raw", "--numstat", "-z", "-M", head],
      ["diff", "--raw", "-z", "-M", head],
      ["diff", "--numstat", "-z", "-M", head],
      ["diff", "--name-only", "--diff-filter=U"],
      ["merge-base", "origin/main", "HEAD"],
      ["merge-base", "x{y}", "HEAD"],
      ["cat-file", "-e", `${head}:two.txt`],
      ["cat-file", "-e", `${head}:-file.txt`],
      ["cat-file", "-e", head],
      ["show", `${head}:ünï cødé.txt`],
      ["show", `${head}:-file.txt`],
      ["log", "-1", "--format=%ct", "HEAD"],
      ["log", "-1", "--format=%ct", "feat/ü-x"],
      ["log", "HEAD", "--not", "origin/main", "--remotes", "--max-count=1", "--format=%H"],
      ["log", "HEAD", "--not", "--remotes", "--max-count=1", "--format=%H"],
      ["--no-optional-locks", "log", "-1", "--format=%ct", "a@b"],
      [
        "--no-optional-locks",
        "log",
        "main",
        "--not",
        "origin/main",
        "--remotes",
        "--max-count=1",
        "--format=%H",
      ],
      ["--no-optional-locks", "log", "HEAD", "--not", "--remotes", "--max-count=1", "--format=%H"],
      ["--no-optional-locks", "status", "--porcelain"],
      ["--no-optional-locks", "worktree", "list", "--porcelain"],
      ["--no-optional-locks", "submodule", "status"],
      ["--no-optional-locks", "rev-parse", "--git-dir"],
      ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"],
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      ["ls-files", "-z", "--", "-file.txt"],
      ["ls-files", "-z", "--", "ünï cødé.txt"],
      ["ls-files", "-z", "--", "--"],
      [
        "config",
        "--includes",
        "--null",
        "--show-scope",
        "--show-origin",
        "--get-all",
        "credential.helper",
      ],
    ];
    for (const args of reads) {
      const expected = raw(args);
      for (const { name, run } of runners) {
        expect(await run(args, dir), `${name}: ${JSON.stringify(args)}`).toBe(expected);
      }
    }
  }, 60_000);

  it.each(runners)(
    "preserves mutation stdout and state with the $name runner",
    async ({ run }) => {
      const reference = repository(join(root, "raw"));
      const candidate = repository(join(root, "fenced"));
      const parity = async (args: readonly string[], checkout?: string): Promise<string> => {
        const expectedCwd = checkout ? join(reference.root, checkout) : reference.dir;
        const actualCwd = checkout ? join(candidate.root, checkout) : candidate.dir;
        // Mutation paths must differ between fixtures, but only paths do: refs,
        // contents and commit IDs are identical, so stdout is otherwise exact.
        const expectedArgs = args.map((arg) => arg.replaceAll(candidate.root, reference.root));
        const expected = reference.raw(expectedArgs, expectedCwd);
        const actual = await run(args, actualCwd);
        expect(normalize(actual, candidate), JSON.stringify(args)).toBe(
          normalize(expected, reference),
        );
        return actual;
      };
      const stateParity = async (): Promise<void> => {
        await parity(["worktree", "list", "--porcelain"]);
        await parity(["rev-parse", "HEAD"]);
        await parity(["status", "--porcelain"]);
      };
      for (const repo of [reference, candidate]) {
        repo.raw(["branch", "reuse-me"]);
        repo.raw(["update-ref", "refs/remotes/origin/main", "HEAD"]);
        writeFileSync(join(repo.dir, "two.txt"), "two\n");
        repo.commit("main moves");
      }
      const first = join(candidate.root, "wt ü one");
      const second = join(candidate.root, "wt two");
      await parity(["worktree", "add", "-b", "ticket/ü-1", first, "origin/main"]);
      await parity(["worktree", "add", second, "reuse-me"]);
      await stateParity();
      expect(await parity(["branch", "--show-current"], "wt two")).toBe("reuse-me\n");
      expect(await parity(["merge", "--no-edit", "main"], "wt ü one")).toContain("Fast-forward");
      expect(await parity(["merge", "--no-edit", "main"], "wt ü one")).toContain(
        "Already up to date",
      );

      for (const repo of [reference, candidate]) {
        const checkout = join(repo.root, "wt two");
        writeFileSync(join(checkout, "two.txt"), "conflict\n");
        repo.commit("topic side", checkout);
        writeFileSync(join(repo.dir, "two.txt"), "main side\n");
        repo.commit("main side");
      }
      // Conflict stdout is carried on the raw exec error (the runner exposes
      // stderr only). Compare the exit outcome, then the actual unmerged state.
      expect(() =>
        reference.raw(["merge", "--no-edit", "main"], join(reference.root, "wt two")),
      ).toThrow();
      await expect(
        Promise.resolve().then(() => run(["merge", "--no-edit", "main"], second)),
      ).rejects.toBeInstanceOf(GitError);
      await parity(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], "wt two");
      expect(await parity(["diff", "--name-only", "--diff-filter=U"], "wt two")).toBe("two.txt\n");
      await parity(["merge", "--abort"], "wt two");
      expect(() =>
        reference.raw(
          ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
          join(reference.root, "wt two"),
        ),
      ).toThrow();
      await expect(
        Promise.resolve().then(() =>
          run(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], second),
        ),
      ).rejects.toBeInstanceOf(GitError);
      await parity(["status", "--porcelain"], "wt two");
      for (const repo of [reference, candidate]) {
        const checkout = join(repo.root, "wt ü one");
        writeFileSync(join(checkout, "topic-only.txt"), "topic work\n");
        repo.commit("non-conflicting topic work", checkout);
      }
      expect(await parity(["merge", "--no-edit", "main"], "wt ü one")).toContain("Merge made");
      await parity(["rev-parse", "HEAD"], "wt ü one");
      await parity(["worktree", "repair", first, second]);
      await parity(["worktree", "repair"]);
      await parity(["worktree", "remove", first]);
      expect(existsSync(first)).toBe(false);
      for (const repo of [reference, candidate]) {
        writeFileSync(join(repo.root, "wt two", "untracked.txt"), "dirty\n");
      }
      await parity(["worktree", "remove", "--force", second]);
      expect(existsSync(second)).toBe(false);
      // Give prune a real stale admin record, not only a no-op invocation.
      const stale = join(candidate.root, "stale checkout");
      await parity(["worktree", "add", stale, "reuse-me"]);
      for (const repo of [reference, candidate]) {
        rmSync(join(repo.root, "stale checkout"), { recursive: true, force: true });
      }
      await parity(["worktree", "prune"]);
      await stateParity();
      expect(candidate.raw(["worktree", "list", "--porcelain"])).not.toContain("stale checkout");
    },
    60_000,
  );
});
