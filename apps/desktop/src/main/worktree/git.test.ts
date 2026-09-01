import { describe, expect, it } from "vite-plus/test";

import { createGitCapturingAsyncRunner, GitError } from "./git";

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
