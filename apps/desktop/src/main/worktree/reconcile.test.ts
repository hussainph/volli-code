import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { GitError } from "./git";
import { reconcile } from "./reconcile";
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

const BRANCH = "volli/VC-1-x";
/** Another branch of the SAME ticket — what an agent in the worktree cuts. */
const SAME_TICKET_BRANCH = "volli/VC-1-narrower-fix";
const PROJECT = "/repo";
const MAIN_ENTRY = `worktree ${PROJECT}\nHEAD abc\nbranch refs/heads/main\n`;

/** A git whose `worktree list` returns `MAIN_ENTRY` plus any extra porcelain blocks. */
function listGit(extra = "") {
  return scriptedGit((args) => {
    if (args[0] === "worktree" && args[1] === "list") return MAIN_ENTRY + extra;
    return "";
  });
}

/** The reconcile input for ticket VC-1, expecting {@link BRANCH} at `target`. */
function forTarget(target: string) {
  return { projectPath: PROJECT, worktreePath: target, branch: BRANCH, displayId: "VC-1" };
}

/** A porcelain block registering `path` on `branch`. */
function onBranch(path: string, branch: string): string {
  return `worktree ${path}\nHEAD def\nbranch refs/heads/${branch}\n`;
}

describe("reconcile matrix", () => {
  it("creates cleanly when nothing is registered and the dir is missing", async () => {
    const target = join(tempDir("home"), "wt-missing"); // does not exist
    const { gitAsync: git } = listGit();
    const result = await reconcile(git, forTarget(target));
    expect(result).toEqual({ ok: true, value: { kind: "create", prune: false, branch: BRANCH } });
  });

  it("is an idempotent no-op when registered and the dir is present", async () => {
    const target = tempDir("wt");
    const { gitAsync: git } = listGit(onBranch(target, BRANCH));
    const result = await reconcile(git, forTarget(target));
    expect(result).toEqual({ ok: true, value: { kind: "already-present", branch: BRANCH } });
  });

  it("prunes and recreates when registered but the dir is missing (stale metadata)", async () => {
    const target = join(tempDir("home"), "wt-gone");
    const { gitAsync: git } = listGit(onBranch(target, BRANCH));
    const result = await reconcile(git, forTarget(target));
    expect(result).toEqual({ ok: true, value: { kind: "create", prune: true, branch: BRANCH } });
  });

  it("creates into an existing EMPTY unregistered dir (git accepts an empty target)", async () => {
    const target = tempDir("wt"); // exists, empty
    const { gitAsync: git } = listGit();
    const result = await reconcile(git, forTarget(target));
    expect(result).toEqual({ ok: true, value: { kind: "create", prune: false, branch: BRANCH } });
  });

  it("refuses an unregistered dir carrying a .git worktree file with the orphan message", async () => {
    const target = tempDir("wt");
    writeFileSync(join(target, ".git"), "gitdir: /repo/.git/worktrees/wt\n");
    const { gitAsync: git } = listGit();
    const result = await reconcile(git, forTarget(target));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/orphaned worktree/);
  });

  it("refuses a plain non-empty unregistered directory rather than blind rm -rf", async () => {
    const target = tempDir("wt"); // someone's real dir with real contents
    writeFileSync(join(target, "notes.txt"), "keep me\n");
    const { gitAsync: git } = listGit();
    const result = await reconcile(git, forTarget(target));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a Volli worktree/);
  });

  it("hard-fails (no --force) when the branch is checked out elsewhere", async () => {
    const target = join(tempDir("home"), "wt-new");
    const { gitAsync: git } = listGit(onBranch("/somewhere/else", BRANCH));
    const result = await reconcile(git, forTarget(target));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already checked out/);
  });

  it("refuses when a non-volli branch is registered at our target path", async () => {
    const target = tempDir("wt");
    const { gitAsync: git } = listGit(onBranch(target, "other"));
    const result = await reconcile(git, forTarget(target));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/on branch other, not volli\/VC-1-x/);
      expect(result.error).toMatch(/Check out volli\/VC-1-x there/);
    }
  });

  it("refuses when ANOTHER ticket's branch is registered at our target path", async () => {
    // `volli/VC-10-…` must not read as VC-1's: the display id ends at the
    // number, never at a prefix of it.
    const target = tempDir("wt");
    const { gitAsync: git } = listGit(onBranch(target, "volli/VC-10-someone-elses-work"));
    const result = await reconcile(git, forTarget(target));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/on branch volli\/VC-10-someone-elses-work, not volli\/VC-1-x/);
    }
  });

  it("refuses a DETACHED-HEAD registration at our target path, naming detached HEAD", async () => {
    // A detached HEAD (no `branch` line) would otherwise pass the wrong-branch
    // guard vacuously and boot a session that strands its commits off any
    // branch — refuse just as hard, and say why (fix 2).
    const target = tempDir("wt");
    const { gitAsync: git } = listGit(`worktree ${target}\nHEAD def\ndetached\n`);
    const result = await reconcile(git, forTarget(target));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/detached HEAD/);
      expect(result.error).toMatch(/not volli\/VC-1-x/);
    }
  });

  it("surfaces an error when the worktree list can't be read", async () => {
    const target = join(tempDir("home"), "wt");
    const { gitAsync: git } = scriptedGit(() => {
      throw new GitError("fatal", "not a git repository", ["worktree", "list"]);
    });
    const result = await reconcile(git, forTarget(target));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a git repository/);
  });
});

describe("reconcile — a same-ticket branch at the ticket's path is adopted", () => {
  it("answers already-present on the branch actually checked out (VC-297)", async () => {
    const target = tempDir("wt");
    const { gitAsync: git, calls } = listGit(onBranch(target, SAME_TICKET_BRANCH));
    const result = await reconcile(git, forTarget(target));
    expect(result).toEqual({
      ok: true,
      value: { kind: "already-present", branch: SAME_TICKET_BRANCH },
    });
    // A read, and nothing that could move the checkout.
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([["worktree", "list"]]);
  });

  it("recreates a pruned registration on the adopted branch, where the latest work is", async () => {
    const target = join(tempDir("home"), "wt-gone");
    const { gitAsync: git } = listGit(onBranch(target, SAME_TICKET_BRANCH));
    const result = await reconcile(git, forTarget(target));
    expect(result).toEqual({
      ok: true,
      value: { kind: "create", prune: true, branch: SAME_TICKET_BRANCH },
    });
  });

  it("adopts the old-slug branch when a retitle drifted the name the ticket would compute", async () => {
    // A ticket whose path is stamped but whose branch is not falls back to the
    // name computed from the CURRENT title — which a retitle has moved away
    // from the branch the directory was created on.
    const target = tempDir("wt");
    const { gitAsync: git } = listGit(onBranch(target, "volli/VC-1-original-title"));
    const result = await reconcile(git, {
      ...forTarget(target),
      branch: "volli/VC-1-retitled-since",
    });
    expect(result).toEqual({
      ok: true,
      value: { kind: "already-present", branch: "volli/VC-1-original-title" },
    });
  });

  it("no longer collides on the recorded branch being checked out elsewhere once it adopts", async () => {
    // The recorded branch is the one the ticket is moving OFF; another checkout
    // holding it says nothing about the branch this worktree stands on.
    const target = tempDir("wt");
    const { gitAsync: git } = listGit(
      onBranch(target, SAME_TICKET_BRANCH) + onBranch("/somewhere/else", BRANCH),
    );
    const result = await reconcile(git, forTarget(target));
    expect(result).toEqual({
      ok: true,
      value: { kind: "already-present", branch: SAME_TICKET_BRANCH },
    });
  });

  it("still hard-fails when the adopted branch is itself checked out elsewhere", async () => {
    // Unreachable without `--force` in git itself, but the proactive check runs
    // against whichever branch the worktree will stand on, never a stale one.
    const target = join(tempDir("home"), "wt-gone");
    const { gitAsync: git } = listGit(
      onBranch(target, SAME_TICKET_BRANCH) + onBranch("/somewhere/else", SAME_TICKET_BRANCH),
    );
    const result = await reconcile(git, forTarget(target));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/volli\/VC-1-narrower-fix is already checked out/);
    }
  });
});
