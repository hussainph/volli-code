import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { commitRemaining } from "./commit";
import { GitError } from "./git";
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

describe("commitRemaining", () => {
  it("stages -A and commits with the fixed chore(<id>) message when the tree is dirty", () => {
    const gitDir = tempDir("gitdir");
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
      if (args[0] === "status") return " M src/a.ts\n";
      return "";
    });
    const result = commitRemaining(git, { worktreePath: "/wt", displayId: "VC-12" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.message).toBe("chore(VC-12): commit remaining work");
    // add -A precedes commit -m with the exact message.
    expect(calls.some((c) => c.args[0] === "add" && c.args[1] === "-A")).toBe(true);
    const commit = calls.find((c) => c.args[0] === "commit");
    expect(commit?.args).toEqual(["commit", "-m", "chore(VC-12): commit remaining work"]);
  });

  it("refuses (err) when a sequencer operation is in progress, never staging or committing", () => {
    const gitDir = tempDir("gitdir");
    writeFileSync(join(gitDir, "REBASE_HEAD"), "abc\n");
    writeFileSync(join(gitDir, "MERGE_HEAD"), "abc\n");
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
      if (args[0] === "status") return " M src/a.ts\n";
      return "";
    });
    const result = commitRemaining(git, { worktreePath: "/wt", displayId: "VC-12" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/in progress|finish|merge|rebase/i);
    expect(calls.some((c) => c.args[0] === "add")).toBe(false);
    expect(calls.some((c) => c.args[0] === "commit")).toBe(false);
  });

  it("errs with a clear message when there is nothing to commit (clean tree)", () => {
    const gitDir = tempDir("gitdir");
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
      if (args[0] === "status") return "";
      return "";
    });
    const result = commitRemaining(git, { worktreePath: "/wt", displayId: "VC-12" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/nothing to commit/i);
    expect(calls.some((c) => c.args[0] === "commit")).toBe(false);
  });

  it("surfaces the real stderr when a commit hook fails", () => {
    const gitDir = tempDir("gitdir");
    const { git } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
      if (args[0] === "status") return " M src/a.ts\n";
      if (args[0] === "add") return "";
      if (args[0] === "commit") {
        throw new GitError("failed", "pre-commit hook: lint failed on src/a.ts", args);
      }
      return "";
    });
    const result = commitRemaining(git, { worktreePath: "/wt", displayId: "VC-12" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("pre-commit hook: lint failed");
  });
});
