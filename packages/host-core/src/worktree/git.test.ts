import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createGitCapturingAsyncRunner,
  GIT_COMMAND_TIMEOUT_MS,
  GIT_MAX_CONCURRENT_CHILDREN,
  GitError,
  parseWorktreeList,
  resetGitChildSlotsForTest,
  runGitCapturing,
  runGitCapturingAsync,
  stderrOf,
  withGitChildSlot,
} from "./git";

describe("the local git argument boundary", () => {
  const unsafe: readonly (readonly string[])[] = [
    ["--upload-pack=echo injected"],
    ["-c", "core.sshCommand=echo injected", "status"],
    ["ls-remote", "--upload-pack=echo injected", "."],
    ["clone", "--upload-pack=echo injected", "."],
    ["fetch", "--upload-pack=echo injected", "origin"],
    ["rev-parse", "--verify", "--quiet", "--upload-pack=echo injected"],
    ["rev-parse", "-ref"],
    ["rev-parse", "--end-of-options", "-ref"],
    ["rev-parse", "--verify", "--end-of-options", "-ref"],
    ["merge-base", "-ref", "HEAD"],
    ["merge", "--no-edit", "--upload-pack=echo injected"],
    ["diff", "--numstat", "-ref...HEAD"],
    ["diff", "--ext-diff", "HEAD"],
    ["rev-list", "--count", "-ref..HEAD"],
    ["show", "--output=unexpected-file"],
    ["cat-file", "-e", "-ref:path"],
    ["ls-files", "--upload-pack=echo injected", "--", "file.txt"],
    ["symbolic-ref", "--quiet", "-ref"],
    ["log", "-1", "--format=%ct", "-ref"],
    ["log", "HEAD", "--not", "-ref", "--remotes", "--max-count=1", "--format=%H"],
    ["for-each-ref", "-ref", "--sort=-committerdate", "--format=%(refname:short)"],
    ["worktree", "add", "-b", "-branch", "./path", "HEAD"],
    ["worktree", "add", "-path", "HEAD"],
    ["worktree", "add", "-b", "branch", "./path", "-ref"],
    ["worktree", "repair", "-path"],
    ["worktree", "repair", "--", "-path"],
    ["worktree", "remove", "-path"],
    ["worktree", "remove", "--force", "-path"],
    ["worktree", "remove", "--force", "--", "-path"],
    ["worktree", "remove", "--force", "./path", "./another-path"],
    ["rev-parse", "--git-path", "-path"],
    ["rev-parse", "HEAD\0"],
  ];

  it("rejects option-prefixed refs, repository operands and network commands before sync spawn", () => {
    for (const args of unsafe) {
      // An unusable cwd proves rejection happened before invoking git, not
      // because a command failed after its injected option was interpreted.
      expect(() => runGitCapturing(args, "/nonexistent-volli-git-argument-test")).toThrow(
        "Unsafe or unsupported local git arguments.",
      );
    }
  });

  it("enforces the same boundary on the async runner", async () => {
    for (const args of unsafe) {
      await expect(
        runGitCapturingAsync(args, "/nonexistent-volli-git-argument-test"),
      ).rejects.toThrow("Unsafe or unsupported local git arguments.");
    }
  });

  it("preserves local reads, ranges, literal -prefixed filenames and worktree lifecycle", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".git-args-test-"));
    const raw = (args: readonly string[]): string =>
      execFileSync("git", [...args], { cwd: dir, encoding: "utf8" });
    try {
      raw(["init", "--quiet", "--initial-branch=main"]);
      writeFileSync(join(dir, "-file.txt"), "literal option-looking path\n");
      writeFileSync(join(dir, "space name.txt"), "spaces remain valid\n");
      raw(["add", "--", "-file.txt", "space name.txt"]);
      raw([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ]);
      raw(["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const reads = [
        // These non-verifying forms must return just the revision, not echo
        // the runner's option fence into sync / Change Set measurements.
        ["rev-parse", "HEAD"],
        ["rev-parse", "main"],
        ["rev-parse", "origin/main"],
        ["rev-parse", "main^{commit}"],
        ["rev-parse", "--verify", "--quiet", "main^{commit}"],
        ["rev-parse", "--git-dir"],
        ["rev-parse", "--git-common-dir"],
        ["rev-parse", "--git-path", "FETCH_HEAD"],
        ["merge-base", "main", "HEAD"],
        ["diff", "--numstat", "main...HEAD"],
        ["diff", "--raw", "--numstat", "-z", "-M", "main"],
        ["rev-list", "--left-right", "--count", "main...HEAD"],
        ["show", "HEAD:-file.txt"],
        ["cat-file", "-e", "HEAD:space name.txt"],
        ["ls-files", "-z", "--", "-file.txt"],
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        ["log", "-1", "--format=%ct", "main"],
        ["log", "HEAD", "--not", "main", "--remotes", "--max-count=1", "--format=%H"],
        ["log", "HEAD", "--not", "--remotes", "--max-count=1", "--format=%H"],
        ["for-each-ref", "refs/heads", "--sort=-committerdate", "--format=%(refname:short)"],
        ["--no-optional-locks", "worktree", "list", "--porcelain"],
      ];
      for (const args of reads) {
        const expected = raw(args);
        expect(runGitCapturing(args, dir)).toBe(expected);
        expect(await runGitCapturingAsync(args, dir)).toBe(expected);
      }
      await runGitCapturingAsync(
        ["worktree", "add", "-b", "topic", "./space checkout", "main"],
        dir,
      );
      expect(existsSync(join(dir, "space checkout", "-file.txt"))).toBe(true);
      runGitCapturing(["worktree", "repair", "./space checkout"], dir);
      expect(await runGitCapturingAsync(["merge", "--no-edit", "main"], dir)).toContain(
        "Already up to date",
      );
      await runGitCapturingAsync(["worktree", "remove", "./space checkout"], dir);
      // Removal and confirmed orphan cleanup use both runners. Exercise clean
      // and forced dirty removal, not just creation through the argument fence.
      for (const runner of [runGitCapturing, runGitCapturingAsync]) {
        await runner(["worktree", "add", "./clean checkout", "topic"], dir);
        await runner(["worktree", "remove", "./clean checkout"], dir);
        expect(existsSync(join(dir, "clean checkout"))).toBe(false);
        await runner(["worktree", "add", "./dirty checkout", "topic"], dir);
        writeFileSync(join(dir, "dirty checkout", "untracked.txt"), "keep unless forced\n");
        await runner(["worktree", "remove", "--force", "./dirty checkout"], dir);
        expect(existsSync(join(dir, "dirty checkout"))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the runner factory's deadline", () => {
  it("refuses a deadline that is not a positive finite number", () => {
    // The factory exists so the suite can shorten the deadline; a caller that
    // shortened it to zero or NaN would get a runner whose children are killed
    // on the spot, or never, and either is a worse failure than this throw.
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createGitCapturingAsyncRunner({ timeoutMs })).toThrow(/positive finite number/);
    }
  });

  it("falls back to the shared deadline when none is given", () => {
    expect(GIT_COMMAND_TIMEOUT_MS).toBe(8_000);
    expect(() => createGitCapturingAsyncRunner()).not.toThrow();
    expect(() =>
      createGitCapturingAsyncRunner({ timeoutMs: GIT_COMMAND_TIMEOUT_MS }),
    ).not.toThrow();
  });
});

describe("parseWorktreeList edges", () => {
  it("answers nothing for empty output", () => {
    // `worktree list` on a repository with no linked worktrees, and the shape a
    // failed-but-not-throwing read leaves behind.
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("\n\n")).toEqual([]);
  });

  it("ignores attribute lines that precede any worktree block", () => {
    // Defensive against a truncated or reordered porcelain stream: an attribute
    // with no block to attach to must be dropped, never applied to the next
    // block, which would report the WRONG checkout as locked or prunable.
    const entries = parseWorktreeList(
      ["branch refs/heads/orphaned", "locked", "prunable gone", "", "worktree /repo", "bare"].join(
        "\n",
      ),
    );
    expect(entries).toEqual([
      { path: "/repo", branch: null, locked: false, bare: true, prunable: null },
    ]);
  });
});

describe("stderrOf", () => {
  it("prefers a GitError's captured stderr", () => {
    expect(stderrOf(new GitError("failed", "fatal: not a working tree", ["worktree"]))).toBe(
      "fatal: not a working tree",
    );
  });

  it("falls back to the message when a GitError captured nothing", () => {
    // Blank stderr is not an excerpt: a `worktree_failed` event carrying "   "
    // tells the person nothing about what git refused.
    expect(stderrOf(new GitError("git worktree add failed", "   ", ["worktree"]))).toBe(
      "git worktree add failed",
    );
  });

  it("stringifies a throw that is not an Error at all", () => {
    // The event has to say something; a rejected non-Error must not surface as
    // "undefined" in the ticket's failure record.
    expect(stderrOf("plain string failure")).toBe("plain string failure");
    expect(stderrOf({ code: 128 })).toBe("[object Object]");
  });
});

// The gate is module state that only drains on a settled child, so a test that
// fails an assertion before opening its gates would strand every slot for the
// life of the worker and the NEXT test would hang on admission instead of
// failing with its own message.
afterEach(() => resetGitChildSlotsForTest());

/** A promise the test resolves by hand, standing in for a child that is still running. */
interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Lets every microtask the gate queued run before the next assertion. The
 * hand-off between a finishing caller and a waiting one is several microtasks
 * long, so asserting in the same turn would read a half-finished hand-off.
 */
const settleAdmissions = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** A child that leaves one observable trace behind: the file it wrote. */
const writeMarker = (path: string): readonly string[] => [
  "-e",
  `require("node:fs").writeFileSync(${JSON.stringify(path)}, "x")`,
];

describe("the shared bound on concurrent git children", () => {
  it("never runs more children at once than the bound, and admits exactly one per freed slot", async () => {
    const callers = GIT_MAX_CONCURRENT_CHILDREN + 3;
    const gates: Gate[] = [];
    const startOrder: number[] = [];
    let live = 0;
    let peak = 0;

    const runs = Array.from({ length: callers }, (_, index) =>
      withGitChildSlot(async () => {
        startOrder.push(index);
        live += 1;
        peak = Math.max(peak, live);
        const held = gate();
        gates.push(held);
        await held.promise;
        live -= 1;
        return index;
      }),
    );

    await settleAdmissions();
    // More callers asked than there are slots, so the surplus is waiting rather
    // than running: this is the whole point of the bound.
    expect(live).toBe(GIT_MAX_CONCURRENT_CHILDREN);
    expect(startOrder).toEqual([0, 1, 2, 3, 4]);

    // Freeing ONE slot admits exactly ONE waiter, and no more: a release that
    // woke the whole queue would show up here as every remaining caller
    // starting at once. (The narrower hazard — a slot left unowned for a
    // microtask, which a caller arriving in between can also take — needs a
    // caller to arrive at that exact moment, and no caller arrives mid-hand-off
    // in this test. "gives a freed slot to the caller already waiting, not to a
    // newcomer" below is the one that stages it.)
    gates[0]!.open();
    await settleAdmissions();
    expect(live).toBe(GIT_MAX_CONCURRENT_CHILDREN);
    expect(startOrder.length).toBe(GIT_MAX_CONCURRENT_CHILDREN + 1);

    let index = 1;
    while (index < gates.length) {
      gates[index]!.open();
      index += 1;
      await settleAdmissions();
    }

    // Waiting is not refusing: every caller gets its own answer back.
    await expect(Promise.all(runs)).resolves.toEqual(
      Array.from({ length: callers }, (_, id) => id),
    );
    expect(peak).toBe(GIT_MAX_CONCURRENT_CHILDREN);
  });

  it("gives every slot back once a burst has drained", async () => {
    // The hand-off is where slot accounting goes wrong: a release that passes
    // the slot on AND counts a new one leaks capacity on every hand-off, so the
    // gate silently shrinks until git stops running in this process at all.
    // Nothing in a single burst shows it — it only appears afterwards.
    await Promise.all(
      Array.from({ length: GIT_MAX_CONCURRENT_CHILDREN + 3 }, () =>
        withGitChildSlot(async () => undefined),
      ),
    );

    const gates: Gate[] = [];
    let live = 0;
    const second = Array.from({ length: GIT_MAX_CONCURRENT_CHILDREN }, () =>
      withGitChildSlot(async () => {
        live += 1;
        const held = gate();
        gates.push(held);
        await held.promise;
      }),
    );

    await settleAdmissions();
    expect(live).toBe(GIT_MAX_CONCURRENT_CHILDREN);
    for (const held of gates) held.open();
    await Promise.all(second);
  });

  it("gives a freed slot to the caller already waiting, not to a newcomer", async () => {
    // The hazard behind the hand-off. A release that decrements the in-flight
    // count and then resumes the waiter leaves the slot unowned for a microtask
    // — long enough for a caller arriving in between to take it as well, so
    // both run and the bound is one over for as long as they last.
    const gates: Gate[] = [];
    let live = 0;
    let peak = 0;
    const body = async (): Promise<void> => {
      live += 1;
      peak = Math.max(peak, live);
      const held = gate();
      gates.push(held);
      await held.promise;
      live -= 1;
    };
    const holding = Array.from({ length: GIT_MAX_CONCURRENT_CHILDREN }, () =>
      withGitChildSlot(body),
    );
    await settleAdmissions();
    const waiting = withGitChildSlot(body);

    // One holder finishes and the waiter inherits its slot — the gate is full
    // again — and only THEN does a new caller ask.
    gates[0]!.open();
    await settleAdmissions();
    const newcomer = withGitChildSlot(body);
    await settleAdmissions();

    expect(live).toBe(GIT_MAX_CONCURRENT_CHILDREN);
    expect(peak).toBe(GIT_MAX_CONCURRENT_CHILDREN);

    let index = 1;
    while (index < gates.length) {
      gates[index]!.open();
      index += 1;
      await settleAdmissions();
    }
    await Promise.all([...holding, waiting, newcomer]);
    expect(peak).toBe(GIT_MAX_CONCURRENT_CHILDREN);
  });

  it("admits waiting callers in the order they asked", async () => {
    const gates: Gate[] = [];
    const holding = Array.from({ length: GIT_MAX_CONCURRENT_CHILDREN }, () =>
      withGitChildSlot(async () => {
        const held = gate();
        gates.push(held);
        await held.promise;
      }),
    );
    await settleAdmissions();

    const admitted: string[] = [];
    const queued = ["first", "second", "third"].map((name) =>
      withGitChildSlot(async () => {
        admitted.push(name);
      }),
    );
    await settleAdmissions();
    expect(admitted).toEqual([]);

    for (const held of gates) {
      held.open();
      await settleAdmissions();
    }
    await Promise.all([...holding, ...queued]);

    // FIFO, not a stack: a Session start that asked first must not be left
    // behind every start that asked after it.
    expect(admitted).toEqual(["first", "second", "third"]);
  });

  it("holds a queued git child unspawned until a slot frees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "volli-git-slot-"));
    const control = join(dir, "control.marker");
    const queued = join(dir, "queued.marker");
    // Node stands in for git so this exercises a REAL child: the claim is that
    // the process is never started, which a scripted runner could not show.
    const git = createGitCapturingAsyncRunner({ file: process.execPath });
    const gates: Gate[] = [];
    let holders: Promise<void>[] = [];

    try {
      // Control: with a free slot the same command runs to completion, which is
      // what makes the absence below evidence rather than a slow machine.
      await git(writeMarker(control), dir);
      expect(existsSync(control)).toBe(true);

      holders = Array.from({ length: GIT_MAX_CONCURRENT_CHILDREN }, () =>
        withGitChildSlot(async () => {
          const held = gate();
          gates.push(held);
          await held.promise;
        }),
      );
      await settleAdmissions();

      const read = git(writeMarker(queued), dir);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(existsSync(queued)).toBe(false);

      gates[0]!.open();
      await read;
      expect(existsSync(queued)).toBe(true);
    } finally {
      for (const held of gates) held.open();
      await Promise.allSettled(holders);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("admits nothing more once the gate is reset mid-flight", async () => {
    // The seam itself, because every other test in this file depends on it: a
    // reset that only cleared the count would leave parked callers on promises
    // nothing can ever settle, and the file would hang rather than fail.
    const gates: Gate[] = [];
    const holding = Array.from({ length: GIT_MAX_CONCURRENT_CHILDREN }, () =>
      withGitChildSlot(async () => {
        const held = gate();
        gates.push(held);
        await held.promise;
      }),
    );
    await settleAdmissions();
    let waiterRan = false;
    const waiting = withGitChildSlot(async () => {
      waiterRan = true;
    });
    await settleAdmissions();
    expect(waiterRan).toBe(false);

    resetGitChildSlotsForTest();
    await settleAdmissions();
    expect(waiterRan).toBe(true);

    for (const held of gates) held.open();
    await Promise.all([...holding, waiting]);
  });

  it("returns the slot when a child fails, so the next caller is not stranded", async () => {
    const git = createGitCapturingAsyncRunner({ file: process.execPath });
    const failures = await Promise.all(
      Array.from({ length: GIT_MAX_CONCURRENT_CHILDREN }, () =>
        git(["-e", "process.exit(3)"], process.cwd()).then(
          () => null,
          (error: unknown) => error,
        ),
      ),
    );
    for (const failure of failures) expect(failure).toBeInstanceOf(GitError);

    // A release that only runs on success strands this caller forever; the
    // failure mode is a hung test rather than a wrong value.
    let ran = false;
    await withGitChildSlot(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

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
