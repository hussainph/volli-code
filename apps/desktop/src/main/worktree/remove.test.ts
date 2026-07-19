import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { listTicketEvents } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { getTicketRow, insertTicket, updateTicketFields } from "../db/tickets-repo";
import { getPhase, resetPhasesForTest, setPhase } from "./phase";
import { remove } from "./remove";
import { scriptedGit } from "./scripted-git";

let ctx: TestDb;
let tempDirs: string[] = [];

beforeEach(() => {
  ctx = openTestDb();
  resetPhasesForTest();
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

function seed(worktreePath: string | null) {
  insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
  insertTicket(ctx.db, testTicket("proj-1", { id: "ticket-1", status: "doing" }));
  if (worktreePath) {
    updateTicketFields(
      ctx.db,
      "ticket-1",
      { worktreePath, branch: "volli/VC-1-x", baseBranch: "main" },
      1,
    );
  }
}

/** A git that reports the worktree clean (or dirty via `dirty: true`) and records removes. */
function statusGit(wt: string, gitDir: string, dirty = false) {
  return scriptedGit((args) => {
    if (args[0] === "status") return dirty ? "?? junk\n" : "";
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
    if (args[0] === "log") return "";
    if (args[0] === "worktree" && args[1] === "list") {
      return `worktree ${wt}\nHEAD abc\nbranch refs/heads/volli/VC-1-x\n`;
    }
    if (args[0] === "submodule") return "";
    return ""; // worktree remove
  });
}

describe("remove", () => {
  it("no-ops when the ticket has no worktree path", async () => {
    seed(null);
    const { git, calls } = scriptedGit(() => "");
    const result = await remove({ db: ctx.db, git }, "ticket-1", { force: false });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.args[1] === "remove")).toBe(false);
  });

  it("removes a clean worktree, clears the path but KEEPS the branch, and records worktree_changed", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    setPhase("ticket-1", "ready");
    const { git, calls } = statusGit(wt, gitDir, false);

    const result = await remove({ db: ctx.db, git }, "ticket-1", { force: false });

    expect(result.ok).toBe(true);
    // Plain remove — never --force for a clean worktree.
    const removeCall = calls.find((c) => c.args[1] === "remove");
    expect(removeCall?.args).toEqual(["worktree", "remove", wt]);

    const row = getTicketRow(ctx.db, "ticket-1")!;
    expect(row.worktree_path).toBeNull();
    // Branch identity survives removal: the branch still exists in git, and a
    // re-ensure must reuse it (never mint a new one off an edited title).
    expect(row.branch).not.toBeNull();
    expect(getPhase("ticket-1")).toBeNull();
    expect(listTicketEvents(ctx.db, "ticket-1").map((e) => e.payload.kind)).toContain(
      "worktree_changed",
    );
  });

  it("prunes and clears the path when the dir is already gone (no dead end)", async () => {
    const gone = join(tempDir("wt"), "vanished"); // parent exists, target does not
    seed(gone);
    const { git, calls } = scriptedGit(() => "");

    const result = await remove({ db: ctx.db, git }, "ticket-1", { force: false });

    expect(result.ok).toBe(true);
    // Never `worktree remove` a missing path — prune the stale metadata instead.
    expect(calls.some((c) => c.args[1] === "remove")).toBe(false);
    expect(calls.some((c) => c.args[1] === "prune")).toBe(true);
    const row = getTicketRow(ctx.db, "ticket-1")!;
    expect(row.worktree_path).toBeNull();
    expect(row.branch).not.toBeNull();
  });

  it("refuses a dirty worktree without force, and never runs the delete", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, calls } = statusGit(wt, gitDir, true);

    const result = await remove({ db: ctx.db, git }, "ticket-1", { force: false });

    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.args[1] === "remove")).toBe(false);
    // Identity retained — nothing was destroyed.
    expect(getTicketRow(ctx.db, "ticket-1")!.worktree_path).toBe(wt);
  });

  it("force-removes a dirty worktree when the caller has confirmed", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, calls } = statusGit(wt, gitDir, true);

    const result = await remove({ db: ctx.db, git }, "ticket-1", { force: true });

    expect(result.ok).toBe(true);
    const removeCall = calls.find((c) => c.args[1] === "remove");
    expect(removeCall?.args).toEqual(["worktree", "remove", "--force", wt]);
    expect(getTicketRow(ctx.db, "ticket-1")!.worktree_path).toBeNull();
  });
});
