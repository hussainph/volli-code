import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

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
  it("reports success for a real commit of 30,000 new files", async () => {
    const dir = tempDir("large-commit");
    const raw = (args: readonly string[]) => runNet("git", args, dir);
    await raw(["init", "--quiet", "--initial-branch=main", "--template="]);
    await raw(["config", "user.name", "Test"]);
    await raw(["config", "user.email", "test@example.com"]);
    await raw(["config", "commit.gpgsign", "false"]);
    await raw(["config", "core.hooksPath", join(dir, ".git", "hooks")]);
    await raw(["config", "core.autocrlf", "false"]);

    // Each ordinary summary line is 38 bytes: 30,000 short paths produce
    // 1,140,000 bytes, exceeding execFile's default 1 MiB stdout ceiling.
    // Identical tiny contents keep object creation cheap even at this scale.
    const fileCount = 30_000;
    for (let i = 0; i < fileCount; i += 1) {
      writeFileSync(join(dir, `fixture-${String(i).padStart(5, "0")}.txt`), "fixture\n");
    }

    const result = await commitRemaining(runGitCapturingAsync, runNet, {
      worktreePath: dir,
      displayId: "VC-12",
    });
    expect(result).toEqual({
      ok: true,
      value: { committed: true, message: "chore(VC-12): commit remaining work" },
    });
    // Check the landed tree as well as the reported result, and measure the
    // summary suppressed by --quiet rather than assuming the fixture is big.
    const { stdout: summary } = await raw(["show", "--format=", "--summary", "HEAD"]);
    expect(Buffer.byteLength(summary)).toBeGreaterThan(1024 * 1024);
    expect(summary.trim().split("\n")).toHaveLength(fileCount);
    expect((await raw(["log", "-1", "--format=%s"])).stdout.trim()).toBe(
      "chore(VC-12): commit remaining work",
    );
    expect((await raw(["status", "--porcelain"])).stdout).toBe("");
  }, 60_000);

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
    // add -A precedes a quiet commit with the exact message, both through the async runner.
    expect(calls[0]).toMatchObject({ file: "git", args: ["add", "-A"], cwd: "/wt" });
    expect(calls[1]).toMatchObject({
      file: "git",
      args: ["commit", "--quiet", "-m", "chore(VC-12): commit remaining work"],
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
    expect(calls[1]?.args).toEqual([
      "commit",
      "--quiet",
      "-m",
      "fix(VC-12): the thing\n\nwith a body",
    ]);
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
    expect(calls[0]?.args).toEqual([
      "commit",
      "--quiet",
      "-m",
      "chore(VC-12): commit remaining work",
    ]);
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
});
