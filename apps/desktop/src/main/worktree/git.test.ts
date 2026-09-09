import { describe, expect, it } from "vite-plus/test";

import { createGitCapturingAsyncRunner, GitError, parseWorktreeList } from "./git";

describe("the bounded async git runner", () => {
  it("returns from a hung spawn without blocking the main event loop", async () => {
    // A hook or filter can leave git alive indefinitely. Use Node itself as the
    // stand-in executable so this test exercises a real child that never exits,
    // rather than a fake runner that merely says it timed out.
    const git = createGitCapturingAsyncRunner({ file: process.execPath, timeoutMs: 100 });
    const started = Date.now();
    const hung = git(["-e", "setInterval(() => {}, 1_000)"], process.cwd()).then(
      () => null,
      (error: unknown) => error,
    );

    // execFileSync would prevent this turn from running until the child died.
    // The sync verb must await an async child instead, leaving Electron main
    // free to serve the rest of the app while its deadline runs.
    let eventLoopTurned = false;
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        eventLoopTurned = true;
        resolve();
      }),
    );
    expect(eventLoopTurned).toBe(true);

    const failure = await hung;
    expect(failure).toBeInstanceOf(GitError);
    expect(failure).toMatchObject({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("parseWorktreeList", () => {
  // `prunable` is how the read-only scan (VC-284) learns which admin records a
  // cleanup would drop WITHOUT running prune: `prune --dry-run` reports on
  // stderr, which this module's runner only captures on failure.
  it("reads the lock and prunable markers, with git's own reason", () => {
    const entries = parseWorktreeList(
      "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\n" +
        "worktree /repo/wt-locked\nHEAD bbb\nbranch refs/heads/wt\nlocked in use\n\n" +
        "worktree /repo/wt-gone\nHEAD ccc\nprunable gitdir file points to non-existent location\n\n" +
        "worktree /repo/wt-bare\nbare\nprunable\n",
    );

    expect(entries).toEqual([
      { path: "/repo", branch: "main", locked: false, bare: false, prunable: null },
      { path: "/repo/wt-locked", branch: "wt", locked: true, bare: false, prunable: null },
      {
        path: "/repo/wt-gone",
        branch: null,
        locked: false,
        bare: false,
        prunable: "gitdir file points to non-existent location",
      },
      // A bare `prunable` line still marks the record; it just has no reason.
      {
        path: "/repo/wt-bare",
        branch: null,
        locked: false,
        bare: true,
        prunable: "stale worktree record",
      },
    ]);
  });
});
