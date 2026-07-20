import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket, updateTicketFields } from "../db/tickets-repo";
import { scriptedGit } from "./scripted-git";
import { sweepOrphans } from "./sweep";

let ctx: TestDb;
let tempDirs: string[] = [];

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

describe("sweepOrphans", () => {
  it("prunes per project, auto-removes clean orphans (keeping the branch), and reports dirty ones", async () => {
    const projectPath = tempDir("proj");
    const knownWt = tempDir("known"); // has a DB row → not an orphan
    const home = tempDir("home");
    const root = join(home, ".volli", "worktrees");
    // Auto-removal is scoped to the app-owned root, so the orphans live there.
    const cleanOrphan = join(root, "proj-abc", "clean"); // no DB row, clean → auto-remove
    const dirtyOrphan = join(root, "proj-abc", "dirty"); // no DB row, dirty → reported
    mkdirSync(cleanOrphan, { recursive: true });
    mkdirSync(dirtyOrphan, { recursive: true });
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

    const report = await sweepOrphans({ db: ctx.db, git, home });

    expect(report.pruned).toEqual(["proj-1"]);
    expect(report.removedClean).toEqual([cleanOrphan]);
    expect(removed).toEqual([cleanOrphan]); // the DB-known + dirty ones were never removed
    expect(report.dirty).toEqual([
      { path: dirtyOrphan, projectId: "proj-1", reason: expect.stringMatching(/untracked/) },
    ]);
    // The dirty check reuses the project's one listing — never a per-orphan
    // re-spawn from the worktree cwd (fix 10).
    expect(listCalls).toEqual([projectPath]);
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

    const report = await sweepOrphans({ db: ctx.db, git, home });

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
    const report = await sweepOrphans({ db: ctx.db, git, home });
    expect(report).toEqual({ pruned: [], removedClean: [], dirty: [] });
  });
});
