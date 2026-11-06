/**
 * The trim's walk runs on a worker thread (VC-1077): planning and removing a
 * `node_modules` must cost the calling thread no file-system callbacks, and a
 * walk that cannot run there refuses rather than falling back to this thread.
 */
import { createHook } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runGitCapturingAsync } from "./git";
import { trimIgnoredArtifacts } from "./trim";
import { runTrimWalk } from "./trim-walk";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Volli Test",
      GIT_AUTHOR_EMAIL: "test@volli.local",
      GIT_COMMITTER_NAME: "Volli Test",
      GIT_COMMITTER_EMAIL: "test@volli.local",
    },
  });
}

describe("trim walk — off the calling thread", () => {
  it("plans, sizes and removes a dependency tree with no file-system callbacks here", async () => {
    const root = mkdtempSync(join(tmpdir(), "volli-trim-walk-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.env\n");
    writeFileSync(join(root, "index.js"), "tracked\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "fixture"]);
    for (let pkg = 0; pkg < 20; pkg += 1) {
      const dir = join(root, "node_modules", `pkg-${pkg}`, "lib");
      mkdirSync(dir, { recursive: true });
      for (let file = 0; file < 10; file += 1) writeFileSync(join(dir, `f${file}.js`), "1234\n");
    }
    writeFileSync(join(root, ".env"), "SECRET=1\n");

    const fsRequests: string[] = [];
    const hook = createHook({
      init(_id, type) {
        if (type.startsWith("FSREQ")) fsRequests.push(type);
      },
    });
    hook.enable();
    let result;
    try {
      result = await trimIgnoredArtifacts(runGitCapturingAsync, {
        worktreePath: root,
        busySites: async () => [],
      });
    } finally {
      hook.disable();
    }

    expect(fsRequests).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Sizes still come back: 200 files of five bytes, in one directory removal.
    expect(result.value.removed).toEqual([{ path: "node_modules/", bytes: 1000 }]);
    expect(result.value.totalBytes).toBe(1000);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    expect(existsSync(join(root, ".env"))).toBe(true);
  });

  it("refuses, rather than walking here, when the worker cannot read the worktree", async () => {
    const missing = join(tmpdir(), "volli-trim-walk-missing", String(process.pid));
    const answer = await runTrimWalk({
      worktreePath: missing,
      candidates: ["node_modules/"],
      patterns: [],
      dryRun: false,
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error).toMatch(/^Volli couldn't read the worktree folder: /);
  });
});
