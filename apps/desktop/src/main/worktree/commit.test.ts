import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { commitRemaining } from "./commit";
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

/** A sync git runner answering the quick probes (sequencer git-dir + status). */
function probeGit(gitDir: string, status: string) {
  return scriptedGit((args) => {
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
    if (args[0] === "status") return status;
    return "";
  }).git;
}

describe("commitRemaining", () => {
  it("stages -A and commits (async runner) with the fixed chore(<id>) message when the tree is dirty", async () => {
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
