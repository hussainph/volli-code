import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { changeSetSnapshot } from "./change-set";
import { resolveChangeSetBaseRevision } from "./comparison-ref";
import { runGitCapturingAsync } from "./git";
import { syncWithBase } from "./sync";

// These are integration regressions: scripted runners cannot detect a separator
// leaking into rev-parse's stdout and corrupting downstream revision operands.
describe("worktree revision consumers with real git", () => {
  let dir: string;
  const raw = (args: readonly string[]): string =>
    execFileSync("git", [...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const commit = (message: string): void => {
    raw(["add", "-A"]);
    raw(["commit", "--quiet", "-m", message]);
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(process.cwd(), ".git-regression-test-")));
    raw(["init", "--quiet", "--initial-branch=main"]);
    raw(["config", "user.name", "Test"]);
    raw(["config", "user.email", "test@example.com"]);
    raw(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "base.txt"), "base\n");
    commit("initial");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stamps a Change Set with the bare HEAD revision", async () => {
    raw(["checkout", "--quiet", "-b", "topic"]);
    writeFileSync(join(dir, "topic.txt"), "topic\n");
    commit("topic work");

    const result = await changeSetSnapshot(runGitCapturingAsync, {
      worktreePath: dir,
      baseBranch: "main",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.headRevision).toBe(raw(["rev-parse", "HEAD"]).trim());
    expect(result.value.headRevision).toMatch(/^[0-9a-f]+$/);
    expect(result.value.files).toEqual([
      { path: "topic.txt", status: "added", insertions: 1, deletions: 0, binary: false },
    ]);
  });

  it("uses the local tip for unrelated history and still computes the Change Set", async () => {
    const mainTip = raw(["rev-parse", "main"]).trim();
    raw(["checkout", "--quiet", "--orphan", "island"]);
    raw(["rm", "-rf", "--quiet", "."]);
    writeFileSync(join(dir, "island.txt"), "island\n");
    commit("unrelated history");

    // No origin/main, and no shared ancestor: exercise the non-verifying
    // rev-parse fallback, not the successful remote probe or merge-base path.
    expect(() => raw(["rev-parse", "--verify", "refs/remotes/origin/main"])).toThrow();
    expect(() => raw(["merge-base", "main", "HEAD"])).toThrow();
    expect(await resolveChangeSetBaseRevision(runGitCapturingAsync, dir, "main")).toBe(mainTip);
    const result = await changeSetSnapshot(runGitCapturingAsync, {
      worktreePath: dir,
      baseBranch: "main",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.baseRevision).toBe(mainTip);
    expect(result.value.headRevision).toBe(raw(["rev-parse", "HEAD"]).trim());
    expect(result.value.files).toEqual([
      { path: "base.txt", status: "deleted", insertions: 0, deletions: 1, binary: false },
      { path: "island.txt", status: "added", insertions: 1, deletions: 0, binary: false },
    ]);
    expect(result.value).toMatchObject({ insertions: 1, deletions: 1, totalCount: 2 });
  });

  it("reports populated commits and diff after syncing a moving base", async () => {
    raw(["branch", "topic"]);
    writeFileSync(join(dir, "main.txt"), "first line\nsecond line\n");
    commit("main moves");
    const mainTip = raw(["rev-parse", "main"]).trim();
    raw(["checkout", "--quiet", "topic"]);

    const result = await syncWithBase(
      runGitCapturingAsync,
      { worktreePath: dir, branch: "topic", baseBranch: "main" },
      "merge",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(raw(["rev-parse", "HEAD"]).trim()).toBe(mainTip);
    expect(result.value).toMatchObject({
      status: "merged",
      mergedRef: "main",
      commits: 1,
      diff: {
        files: [{ path: "main.txt", insertions: 2, deletions: 0 }],
        insertions: 2,
        deletions: 0,
      },
      conflicts: [],
    });
  });
});
