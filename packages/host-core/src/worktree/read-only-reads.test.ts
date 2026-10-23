/**
 * VC-834: the background worktree reads run read-only git.
 *
 * A plain `git status` holds the checkout's `index.lock` for its whole run so it
 * can write back the stat data it refreshed (git-status(1), "BACKGROUND
 * REFRESH"). These reads run in the background — the Change Set and its path
 * set within a second of any write in the worktree, the rail status on every
 * watch event, the venue snapshot against a Main checkout many Sessions share —
 * so an agent's own `git add`/`commit` in the same checkout could find the lock
 * taken and fail with "index.lock: File exists". `--no-optional-locks` is git's
 * switch for exactly this: the read never takes the lock and never writes.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { changeSetPaths, changeSetSnapshot } from "./change-set";
import { diffStat } from "./diff";
import { runGitCapturingAsync } from "./git";
import { scriptedGit } from "./scripted-git";
import { getWorktreeStatus } from "./status";
import type { RunGitAsync } from "./types";
import { venueSnapshot } from "./venue";

/** Plausible answers so each read walks its whole path, status included. */
function answer(args: readonly string[]): string {
  const [verb, first] = args[0] === "--no-optional-locks" ? args.slice(1) : args;
  if (verb === "rev-parse" && first === "--verify") throw new Error("no such ref");
  if (verb === "merge-base") return "basesha\n";
  if (verb === "rev-parse") return "sha\n";
  if (verb === "rev-list") return "0\t0\n";
  if (verb === "branch") return "topic\n";
  return "";
}

describe("background worktree reads issue read-only git (VC-834)", () => {
  const reads: Array<
    [string, (git: ReturnType<typeof scriptedGit>["gitAsync"]) => Promise<unknown>]
  > = [
    [
      "changeSetSnapshot",
      (git) => changeSetSnapshot(git, { worktreePath: "/wt", baseBranch: "main" }),
    ],
    ["changeSetPaths", (git) => changeSetPaths(git, { worktreePath: "/wt", baseBranch: "main" })],
    [
      "getWorktreeStatus",
      (git) => getWorktreeStatus(git, { worktreePath: "/wt", branch: "topic", baseBranch: "main" }),
    ],
    [
      "venueSnapshot",
      (git) => venueSnapshot(git, { path: "/wt", kind: "worktree", baseBranch: "main" }),
    ],
    [
      "diffStat (working-tree)",
      (git) => diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "working-tree"),
    ],
    [
      "diffStat (merge-base)",
      (git) => diffStat(git, { worktreePath: "/wt", baseBranch: "main" }, "merge-base"),
    ],
  ];

  it.each(reads)("%s leads every git call with --no-optional-locks", async (_name, read) => {
    const { gitAsync, calls } = scriptedGit(answer);

    await read(gitAsync);

    const issued = calls.map((call) => call.args.join(" "));
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every((line) => line.startsWith("--no-optional-locks "))).toBe(true);
  });
});

// The scripted runner proves the argv; this proves what the argv buys against
// real git. Before every `status` a read issues, the fixture makes a tracked
// file stat-dirty (same bytes, new mtime) — exactly what a plain status
// refreshes under `index.lock` and writes back. A status that never takes the
// lock never writes, so the index bytes after it are the bytes before it.
//
// Calls are serialized so each `status` is measured on its own. `git diff` is
// deliberately not measured: porcelain diff refreshes the index at its end
// regardless of `--no-optional-locks` (it is gated by `diff.autoRefreshIndex`
// instead), which is a shorter lock window this switch cannot close.
describe("background worktree status reads leave the index untouched (real git)", () => {
  let dir: string;
  let tick = 0;
  const raw = (args: readonly string[]): string =>
    execFileSync("git", [...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const index = (): Buffer => readFileSync(join(dir, ".git", "index"));
  const makeStatDirty = (): void => {
    tick += 1;
    const past = new Date(Date.now() - tick * 3_600_000);
    utimesSync(join(dir, "tracked.txt"), past, past);
  };

  /** Real git, one call at a time, recording whether each `status` wrote the index. */
  function measuringGit(): { git: RunGitAsync; statuses: Array<{ args: string; wrote: boolean }> } {
    const statuses: Array<{ args: string; wrote: boolean }> = [];
    let queue: Promise<unknown> = Promise.resolve();
    const git: RunGitAsync = (args, cwd) => {
      const run = queue.then(async () => {
        if (!args.includes("status")) return runGitCapturingAsync(args, cwd);
        makeStatDirty();
        const before = index();
        const out = await runGitCapturingAsync(args, cwd);
        statuses.push({ args: args.join(" "), wrote: !index().equals(before) });
        return out;
      });
      queue = run.catch(() => undefined);
      return run;
    };
    return { git, statuses };
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(process.cwd(), ".git-read-only-test-")));
    raw(["init", "--quiet", "--initial-branch=main"]);
    raw(["config", "user.name", "Test"]);
    raw(["config", "user.email", "test@example.com"]);
    raw(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "tracked.txt"), "tracked\n");
    raw(["add", "-A"]);
    raw(["commit", "--quiet", "-m", "initial"]);
    raw(["checkout", "--quiet", "-b", "topic"]);
    writeFileSync(join(dir, "untracked.txt"), "untracked\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a plain status writes the stat-dirty index back (the fixture can see the lock taken)", async () => {
    const { git, statuses } = measuringGit();
    await git(["status", "--porcelain=v2", "-z", "-uall"], dir);
    expect(statuses).toEqual([{ args: "status --porcelain=v2 -z -uall", wrote: true }]);
  });

  it("the Change Set, its path set, the rail status, the venue and diffStat never write it", async () => {
    const { git, statuses } = measuringGit();

    const snapshot = await changeSetSnapshot(git, { worktreePath: dir, baseBranch: "main" });
    expect(snapshot.ok && snapshot.value.files.map((file) => file.path)).toEqual(["untracked.txt"]);
    expect(await changeSetPaths(git, { worktreePath: dir, baseBranch: "main" })).toEqual({
      ok: true,
      value: ["untracked.txt"],
    });
    const status = await getWorktreeStatus(git, {
      worktreePath: dir,
      branch: "topic",
      baseBranch: "main",
    });
    expect(status.uncommitted).toBe(true);
    expect((await venueSnapshot(git, { path: dir, kind: "worktree", baseBranch: "main" })).ok).toBe(
      true,
    );
    expect(
      (await diffStat(git, { worktreePath: dir, baseBranch: "main" }, "working-tree")).ok,
    ).toBe(true);

    expect(statuses).toEqual([
      { args: "--no-optional-locks status --porcelain=v2 -z -uall", wrote: false },
      { args: "--no-optional-locks status --porcelain=v2 -z -uall", wrote: false },
      { args: "--no-optional-locks status --porcelain", wrote: false },
      { args: "--no-optional-locks status --porcelain=v2 -z -uall", wrote: false },
      { args: "--no-optional-locks status --porcelain", wrote: false },
    ]);
  });
});
