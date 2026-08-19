import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket, updateTicketFields } from "../db/tickets-repo";
import { projectContainerName } from "./containers";
import { scriptedGit } from "./scripted-git";
import { sweepOrphans } from "./sweep";

let ctx: TestDb;
let tempDirs: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;
/** A fixed "now" so the dwell-time gate is judged against a clock the test owns. */
const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);
const now = () => NOW;

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** Backdates a directory's mtime so the sweep reads it as untouched for `days`. */
function ageDir(dir: string, days: number): void {
  const seconds = (NOW - days * DAY_MS) / 1000;
  utimesSync(dir, seconds, seconds);
}

describe("sweepOrphans", () => {
  it("prunes per project, auto-removes STALE clean orphans (keeping the branch), and reports dirty ones", async () => {
    const projectPath = tempDir("proj");
    const knownWt = tempDir("known"); // has a DB row → not an orphan
    const home = tempDir("home");
    // Auto-removal is scoped to the container THIS db's project owns.
    const container = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName(projectPath, "proj-1"),
    );
    const cleanOrphan = join(container, "clean"); // no DB row, clean, stale → auto-remove
    const dirtyOrphan = join(container, "dirty"); // no DB row, dirty → reported
    mkdirSync(cleanOrphan, { recursive: true });
    mkdirSync(dirtyOrphan, { recursive: true });
    ageDir(cleanOrphan, 30);
    const gitDir = tempDir("gitdir"); // empty: no sequencer files

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
    insertTicket(ctx.db, testTicket("proj-1", { id: "ticket-1", status: "doing" }));
    updateTicketFields(ctx.db, "ticket-1", { worktreePath: knownWt, branch: "volli/VC-1-x" }, 1);

    const listPorcelain =
      `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
      `worktree ${knownWt}\nHEAD b\nbranch refs/heads/volli/VC-1-x\n` +
      `worktree ${cleanOrphan}\nHEAD c\nbranch refs/heads/orphan-clean\n` +
      `worktree ${dirtyOrphan}\nHEAD d\nbranch refs/heads/orphan-dirty\n`;

    const removed: string[] = [];
    const listCalls: string[] = [];
    const { git } = scriptedGit((args, cwd) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") {
        listCalls.push(cwd);
        return listPorcelain;
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        removed.push(args[2]!);
        return "";
      }
      // dirty probes, keyed by cwd: only the dirty orphan reports changes.
      if (args[0] === "status") return cwd === dirtyOrphan ? "?? junk\n" : "";
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
      if (args[0] === "log") return "";
      if (args[0] === "submodule") return "";
      return "";
    });

    const report = await sweepOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.pruned).toEqual(["proj-1"]);
    expect(report.removedClean).toEqual([
      {
        path: cleanOrphan,
        projectId: "proj-1",
        branch: "orphan-clean",
        lastTouchedAt: expect.any(Number),
      },
    ]);
    expect(removed).toEqual([cleanOrphan]); // the DB-known + dirty ones were never removed
    expect(report.dirty).toEqual([
      { path: dirtyOrphan, projectId: "proj-1", reason: expect.stringMatching(/untracked/) },
    ]);
    // The dirty check reuses the project's one listing — never a per-orphan
    // re-spawn from the worktree cwd (fix 10).
    expect(listCalls).toEqual([projectPath]);
  });

  // VC-113: the bug that ate 44 checkouts. Two installs of Volli track the same
  // repo through two databases, so they own two containers under one shared
  // `~/.volli/worktrees`. Judging ownership by the ROOT made every launch of one
  // app delete the other's worktrees — while the owning database went on
  // pointing at the vanished path, with no event and nothing to recover from.
  it("never touches ANOTHER INSTALL's container under the same worktree root", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const root = join(home, ".volli", "worktrees");
    // Ours, by construction: the container our own project row computes.
    const ourContainer = join(root, projectContainerName(projectPath, "proj-1"));
    // The other install's: same repo, same root, DIFFERENT project uuid.
    const theirContainer = join(root, projectContainerName(projectPath, "f8e04558-dev"));
    const theirWorktree = join(theirContainer, "VC-99-their-ticket");
    mkdirSync(ourContainer, { recursive: true });
    mkdirSync(theirWorktree, { recursive: true });
    ageDir(theirWorktree, 400); // ancient AND clean — the sweep must still refuse

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

    const removed: string[] = [];
    const { git } = scriptedGit((args) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") {
        return (
          `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
          `worktree ${theirWorktree}\nHEAD b\nbranch refs/heads/volli/VC-99-their-ticket\n`
        );
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        removed.push(args[2]!);
        return "";
      }
      return ""; // every dirty probe reads clean
    });

    const report = await sweepOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(removed).toEqual([]); // not ours to delete
    expect(report.removedClean).toEqual([]);
    expect(report.keptRecent).toEqual([]);
    expect(report.dirty).toEqual([]); // not ours to report on, either
  });

  // VC-113: "clean" arrives the moment a branch is pushed, which is exactly when
  // a PR opens — so cleanliness alone cannot mean disposable. Time has to pass.
  it("spares a clean orphan that was touched inside the retention window", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const container = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName(projectPath, "proj-1"),
    );
    const justPushed = join(container, "VC-7-just-pushed");
    mkdirSync(justPushed, { recursive: true });
    ageDir(justPushed, 2); // pushed two days ago: clean, but hardly abandoned

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

    const removed: string[] = [];
    const { git } = scriptedGit((args) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") {
        return (
          `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
          `worktree ${justPushed}\nHEAD b\nbranch refs/heads/volli/VC-7-just-pushed\n`
        );
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        removed.push(args[2]!);
        return "";
      }
      return "";
    });

    const report = await sweepOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(removed).toEqual([]);
    expect(report.removedClean).toEqual([]);
    expect(report.keptRecent).toEqual([
      {
        path: justPushed,
        projectId: "proj-1",
        branch: "volli/VC-7-just-pushed",
        lastTouchedAt: NOW - 2 * DAY_MS,
        // Default TTL is 14 days, so it becomes eligible 12 days from now.
        removableAt: NOW - 2 * DAY_MS + 14 * DAY_MS,
      },
    ]);
  });

  // VC-113's dead end: git has forgotten the path but a ticket still points at
  // it, so `git worktree remove` refuses in BOTH modes and `ensure` refuses to
  // recreate over it. It used to be skipped here purely for being DB-known,
  // which left no surface in the app naming it at all.
  it("reports a DB-known directory that git no longer registers", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const container = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName(projectPath, "proj-1"),
    );
    const strandedWt = join(container, "VC-82-stranded");
    mkdirSync(strandedWt, { recursive: true });

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
    insertTicket(ctx.db, testTicket("proj-1", { id: "ticket-82", status: "done" }));
    updateTicketFields(ctx.db, "ticket-82", { worktreePath: strandedWt, branch: "volli/VC-82" }, 1);

    const { git } = scriptedGit((args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n`;
      }
      return "";
    });

    const report = await sweepOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.dirty).toEqual([
      {
        path: strandedWt,
        projectId: "proj-1",
        reason: expect.stringMatching(/ticket still points here/i),
      },
    ]);
    expect(report.removedClean).toEqual([]);
  });

  it("leaves a git-registered worktree OUTSIDE the app root completely untouched (not removed, not reported)", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home"); // app root is home/.volli/worktrees — empty here
    const personalWt = tempDir("personal"); // the user's own `git worktree add ../review`

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

    const removed: string[] = [];
    const { git } = scriptedGit((args) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") {
        return (
          `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
          `worktree ${personalWt}\nHEAD b\nbranch refs/heads/feature\n`
        );
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        removed.push(args[2]!);
        return "";
      }
      return "";
    });

    const report = await sweepOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(removed).toEqual([]); // never deleted — it's not ours
    expect(report.removedClean).toEqual([]);
    expect(report.dirty).toEqual([]); // never even reported
  });

  it("skips a project whose git can't be read", async () => {
    const home = tempDir("home"); // hermetic: never reads the real ~/.volli/worktrees
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git } = scriptedGit((args) => {
      if (args[0] === "worktree" && args[1] === "prune") throw new Error("not a git repo");
      return "";
    });
    const report = await sweepOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });
    expect(report).toEqual({ pruned: [], removedClean: [], keptRecent: [], dirty: [] });
  });
});
