import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { commitRemaining } from "./commit";
import { runGitCapturingAsync } from "./git";
import { runNet } from "./net";
import { netFailure, scriptedNet } from "./scripted-net";
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

/** An async git runner answering the quick probes (sequencer git-dir + status). */
function probeGit(gitDir: string, status: string) {
  return scriptedGit((args) => {
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
    if (args[0] === "status") return status;
    return "";
  }).gitAsync;
}

describe("commitRemaining", () => {
  it("stages -A and commits (async runner) with the generated chore(<id>) message when no choices are given", async () => {
    const git = probeGit(tempDir("gitdir"), " M src/a.ts\n");
    const { run, calls } = scriptedNet(() => ({}));
    const result = await commitRemaining(git, run, { worktreePath: "/wt", displayId: "VC-12" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      committed: true,
      message: "chore(VC-12): commit remaining work",
    });
    // add -A precedes commit -m with the exact message, both through the async runner.
    expect(calls[0]).toMatchObject({ file: "git", args: ["add", "-A"], cwd: "/wt" });
    expect(calls[1]).toMatchObject({
      file: "git",
      args: ["commit", "-m", "chore(VC-12): commit remaining work"],
      cwd: "/wt",
    });
  });

  it("refuses (err) when a sequencer operation is in progress, never staging or committing", async () => {
    const gitDir = tempDir("gitdir");
    writeFileSync(join(gitDir, "REBASE_HEAD"), "abc\n");
    writeFileSync(join(gitDir, "MERGE_HEAD"), "abc\n");
    const git = probeGit(gitDir, " M src/a.ts\n");
    const { run, calls } = scriptedNet(() => ({}));
    const result = await commitRemaining(git, run, { worktreePath: "/wt", displayId: "VC-12" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/in progress|finish|merge|rebase/i);
    expect(calls).toHaveLength(0);
  });

  it("returns the committed:false no-op (ok, not err) when the tree is already clean", async () => {
    const git = probeGit(tempDir("gitdir"), "");
    const { run, calls } = scriptedNet(() => ({}));
    const result = await commitRemaining(git, run, { worktreePath: "/wt", displayId: "VC-12" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ committed: false });
    expect(calls).toHaveLength(0);
  });

  it("commits the caller's message verbatim, multi-line included", async () => {
    const git = probeGit(tempDir("gitdir"), " M src/a.ts\n");
    const { run, calls } = scriptedNet(() => ({}));
    const result = await commitRemaining(git, run, {
      worktreePath: "/wt",
      displayId: "VC-12",
      message: "  fix(VC-12): the thing\n\nwith a body  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Trimmed at the edges (git's own -m cleanup does the same), untouched inside.
    expect(result.value).toEqual({
      committed: true,
      message: "fix(VC-12): the thing\n\nwith a body",
    });
    expect(calls[1]?.args).toEqual(["commit", "-m", "fix(VC-12): the thing\n\nwith a body"]);
  });

  it("falls back to the generated message when the caller's is blank", async () => {
    const git = probeGit(tempDir("gitdir"), " M src/a.ts\n");
    const { run } = scriptedNet(() => ({}));
    const result = await commitRemaining(git, run, {
      worktreePath: "/wt",
      displayId: "VC-12",
      message: "   \n  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      committed: true,
      message: "chore(VC-12): commit remaining work",
    });
  });

  it("skips `add` entirely under includeUnstaged: false, committing the index as it stands", async () => {
    // `M ` = staged modification, ` M` = unstaged, `??` = untracked: the commit
    // must take the first and leave the other two where they are.
    const git = probeGit(tempDir("gitdir"), "M  src/a.ts\n M src/b.ts\n?? src/c.ts\n");
    const { run, calls } = scriptedNet(() => ({}));
    const result = await commitRemaining(git, run, {
      worktreePath: "/wt",
      displayId: "VC-12",
      includeUnstaged: false,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["commit", "-m", "chore(VC-12): commit remaining work"]);
  });

  it("errs rather than committing nothing when includeUnstaged: false leaves an empty index", async () => {
    const git = probeGit(tempDir("gitdir"), " M src/a.ts\n?? src/c.ts\n");
    const { run, calls } = scriptedNet(() => ({}));
    const result = await commitRemaining(git, run, {
      worktreePath: "/wt",
      displayId: "VC-12",
      includeUnstaged: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/nothing is staged/i);
    // Not the clean-tree no-op, and nothing ran: the tree is visibly dirty.
    expect(calls).toHaveLength(0);
  });

  it("keeps the clean-tree no-op under includeUnstaged: false (an empty index is expected there)", async () => {
    const git = probeGit(tempDir("gitdir"), "");
    const { run, calls } = scriptedNet(() => ({}));
    const result = await commitRemaining(git, run, {
      worktreePath: "/wt",
      displayId: "VC-12",
      includeUnstaged: false,
    });
    expect(result).toEqual({ ok: true, value: { committed: false } });
    expect(calls).toHaveLength(0);
  });

  it("surfaces the real stderr when a commit hook fails", async () => {
    const git = probeGit(tempDir("gitdir"), " M src/a.ts\n");
    const { run } = scriptedNet((_file, args) => {
      if (args[0] === "commit") {
        throw netFailure({ stderr: "pre-commit hook: lint failed on src/a.ts", code: 1 });
      }
      return {};
    });
    const result = await commitRemaining(git, run, { worktreePath: "/wt", displayId: "VC-12" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("pre-commit hook: lint failed");
  });

  it.each(["UU", "AA", "DD", "AU", "UA", "DU", "UD"])(
    "refuses an unmerged %s entry with no sequencer marker, never staging or committing",
    async (xy) => {
      const git = probeGit(tempDir("gitdir"), ` M src/a.ts\n${xy} src/conflicted.ts\n`);
      const { run, calls } = scriptedNet(() => ({}));
      const result = await commitRemaining(git, run, { worktreePath: "/wt", displayId: "VC-12" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/unresolved conflicts/i);
      expect(calls).toHaveLength(0);
    },
  );

  it("refuses unmerged entries under includeUnstaged: false too (nothing runs)", async () => {
    const git = probeGit(tempDir("gitdir"), "UU src/conflicted.ts\n");
    const { run, calls } = scriptedNet(() => ({}));
    const result = await commitRemaining(git, run, {
      worktreePath: "/wt",
      displayId: "VC-12",
      includeUnstaged: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unresolved conflicts/i);
    expect(calls).toHaveLength(0);
  });
});

// VC-838: the conflicts that leave unmerged index entries but NO sequencer
// marker (stash pop, merge --squash). Real git, because the bug is the gap
// between what the marker probe sees and what `git add -A` silently resolves.
describe("commitRemaining with real git", () => {
  let dir: string;
  const raw = (args: readonly string[]): string =>
    execFileSync("git", [...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  const commitAll = (message: string): void => {
    raw(["add", "-A"]);
    raw(["commit", "--quiet", "-m", message]);
  };
  const head = (): string => raw(["rev-parse", "HEAD"]).trim();
  const run = (input: { includeUnstaged?: boolean } = {}) =>
    commitRemaining(runGitCapturingAsync, runNet, {
      worktreePath: dir,
      displayId: "VC-838",
      ...input,
    });

  beforeEach(() => {
    dir = realpathSync(tempDir("commit-real"));
    raw(["init", "--quiet", "--initial-branch=main"]);
    raw(["config", "user.name", "Test"]);
    raw(["config", "user.email", "test@example.com"]);
    raw(["config", "commit.gpgsign", "false"]);
    // No inherited global hooks: the commit outcome must be git's alone.
    raw(["config", "core.hooksPath", tempDir("no-hooks")]);
    writeFileSync(join(dir, "file.txt"), "base\n");
    commitAll("initial");
  });

  it("refuses a stash-pop conflict: HEAD does not move and nothing is staged", async () => {
    writeFileSync(join(dir, "file.txt"), "stashed\n");
    raw(["stash", "--quiet"]);
    writeFileSync(join(dir, "file.txt"), "committed\n");
    commitAll("diverge");
    expect(() => raw(["stash", "pop"])).toThrow();
    // The premise: a conflict-marked file, an unmerged entry, and no sequencer marker.
    expect(readFileSync(join(dir, "file.txt"), "utf8")).toContain("<<<<<<<");
    expect(raw(["status", "--porcelain"])).toContain("UU file.txt");
    const before = head();

    for (const includeUnstaged of [true, false]) {
      const result = await run({ includeUnstaged });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/unresolved conflicts/i);
    }
    expect(head()).toBe(before);
    // Still unmerged: the refusal resolved nothing behind the person's back.
    expect(raw(["status", "--porcelain"])).toContain("UU file.txt");
  });

  it("refuses a merge --squash conflict (git writes no MERGE_HEAD for --squash)", async () => {
    raw(["checkout", "--quiet", "-b", "topic"]);
    writeFileSync(join(dir, "file.txt"), "topic\n");
    commitAll("topic");
    raw(["checkout", "--quiet", "main"]);
    writeFileSync(join(dir, "file.txt"), "main\n");
    commitAll("main");
    expect(() => raw(["merge", "--squash", "topic"])).toThrow();
    expect(() => raw(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).toThrow();
    expect(readFileSync(join(dir, "file.txt"), "utf8")).toContain("<<<<<<<");
    const before = head();

    const result = await run();
    expect(result.ok).toBe(false);
    expect(head()).toBe(before);
  });

  it("still commits a clean squash merge with no conflicts", async () => {
    raw(["checkout", "--quiet", "-b", "topic"]);
    writeFileSync(join(dir, "topic.txt"), "topic\n");
    commitAll("topic");
    raw(["checkout", "--quiet", "main"]);
    raw(["merge", "--squash", "--quiet", "topic"]);
    const before = head();

    const result = await run();
    expect(result).toEqual({
      ok: true,
      value: { committed: true, message: "chore(VC-838): commit remaining work" },
    });
    expect(head()).not.toBe(before);
    expect(raw(["status", "--porcelain"])).toBe("");
  });
});
