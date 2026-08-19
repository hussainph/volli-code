import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { listTicketEvents } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { archiveTicket, getTicketRow, insertTicket, updateTicketFields } from "../db/tickets-repo";
import { projectContainerName } from "./containers";
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
    const result = await remove({ db: ctx.db, git, blobsRoot: "unused" }, "ticket-1", {
      force: false,
    });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.args[1] === "remove")).toBe(false);
  });

  it("removes a clean worktree, clears the path but KEEPS the branch, and records worktree_changed", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    setPhase("ticket-1", "ready");
    const { git, calls } = statusGit(wt, gitDir, false);

    const result = await remove({ db: ctx.db, git, blobsRoot: "unused" }, "ticket-1", {
      force: false,
    });

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

    const result = await remove({ db: ctx.db, git, blobsRoot: "unused" }, "ticket-1", {
      force: false,
    });

    expect(result.ok).toBe(true);
    // Never `worktree remove` a missing path — prune the stale metadata instead.
    expect(calls.some((c) => c.args[1] === "remove")).toBe(false);
    expect(calls.some((c) => c.args[1] === "prune")).toBe(true);
    const row = getTicketRow(ctx.db, "ticket-1")!;
    expect(row.worktree_path).toBeNull();
    expect(row.branch).not.toBeNull();
  });

  it("clears the checkout pointer even when the ticket is archived (no spurious throw)", async () => {
    // `clearIdentity` goes through `updateTicketFieldsCommand`, which normally
    // refuses an archived ticket — but the dir is already gone, so the pointer
    // MUST still be nulled or the row dead-ends at a vanished path (fix 6).
    const gone = join(tempDir("wt"), "vanished");
    seed(gone);
    archiveTicket(ctx.db, "ticket-1", 2);
    const { git } = scriptedGit(() => "");

    const result = await remove({ db: ctx.db, git, blobsRoot: "unused" }, "ticket-1", {
      force: false,
    });

    expect(result.ok).toBe(true);
    const row = getTicketRow(ctx.db, "ticket-1")!;
    expect(row.worktree_path).toBeNull();
    expect(row.branch).not.toBeNull(); // branch identity still retained
    expect(listTicketEvents(ctx.db, "ticket-1").map((e) => e.payload.kind)).toContain(
      "worktree_changed",
    );
  });

  it("refuses a dirty worktree without force, and never runs the delete", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, calls } = statusGit(wt, gitDir, true);

    const result = await remove({ db: ctx.db, git, blobsRoot: "unused" }, "ticket-1", {
      force: false,
    });

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

    const result = await remove({ db: ctx.db, git, blobsRoot: "unused" }, "ticket-1", {
      force: true,
    });

    expect(result.ok).toBe(true);
    const removeCall = calls.find((c) => c.args[1] === "remove");
    expect(removeCall?.args).toEqual(["worktree", "remove", "--force", wt]);
    expect(getTicketRow(ctx.db, "ticket-1")!.worktree_path).toBeNull();
  });

  // A binding outlives the tab that opened it, so nothing else ends one. Without
  // this the checkout went and the Session kept dispatching into the vanished
  // path — no release, no close, and nothing said.
  it("ends the bindings rooted in the checkout, in the same beat as the delete", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, calls } = statusGit(wt, gitDir, false);
    const order: string[] = [];
    const released: string[] = [];

    const tracedGit = (args: readonly string[], cwd: string): string => {
      order.push(`git:${args[1] ?? args[0]}`);
      return git(args, cwd);
    };

    const result = await remove({ db: ctx.db, git: tracedGit, blobsRoot: "unused" }, "ticket-1", {
      force: false,
      releaseAgentSites: async (directory) => {
        order.push("release");
        released.push(directory);
        return { released: ["chat-1"], stillOpen: [] };
      },
    });

    expect(result.ok).toBe(true);
    expect(released).toEqual([wt]);
    // After the dirty gate (so a refusal costs no chat), before the delete (so
    // the executor stops while its cwd still exists).
    expect(order.slice(-2)).toEqual(["release", "git:remove"]);
    expect(calls.some((c) => c.args[1] === "remove")).toBe(true);
  });

  it("never releases a binding for a remove it is about to refuse as dirty", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git } = statusGit(wt, gitDir, true);
    let releases = 0;

    const result = await remove({ db: ctx.db, git, blobsRoot: "unused" }, "ticket-1", {
      force: false,
      releaseAgentSites: async () => {
        releases += 1;
        return { released: [], stillOpen: [] };
      },
    });

    expect(result.ok).toBe(false);
    expect(releases).toBe(0);
  });

  it("releases the bindings pointed at a checkout that is already gone", async () => {
    const gone = join(tempDir("wt"), "vanished");
    seed(gone);
    const { git } = scriptedGit(() => "");
    const released: string[] = [];

    const result = await remove({ db: ctx.db, git, blobsRoot: "unused" }, "ticket-1", {
      force: false,
      releaseAgentSites: async (directory) => {
        released.push(directory);
        return { released: ["chat-1"], stillOpen: [] };
      },
    });

    expect(result.ok).toBe(true);
    expect(released).toEqual([gone]);
  });

  it("still removes the worktree when a binding refuses to close", async () => {
    // Best-effort by design: a release that cannot succeed must not leave a
    // worktree no route can remove — the failure the busy gate was rewritten to
    // end. The report names what survived; the caller logs it.
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, calls } = statusGit(wt, gitDir, false);

    const result = await remove({ db: ctx.db, git, blobsRoot: "unused" }, "ticket-1", {
      force: false,
      releaseAgentSites: async () => ({ released: [], stillOpen: ["chat-1"] }),
    });

    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.args[1] === "remove")).toBe(true);
    expect(getTicketRow(ctx.db, "ticket-1")!.worktree_path).toBeNull();
  });
});

/** Git that registers only the main checkout — a stranded path is unknown to it. */
function forgottenGit(unregistered: string) {
  return scriptedGit((args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return `worktree /repo\nHEAD abc\nbranch refs/heads/main\n`;
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      throw new Error(`fatal: '${unregistered}' is not a working tree`);
    }
    return "";
  });
}

// VC-113: the state a half-finished removal leaves behind — the checkout is
// still on disk, but git has forgotten it. `git worktree remove` refuses such a
// path in BOTH modes, so before this fallback the ticket could not be cleared
// from anywhere in the app: not from the rail, not from Settings (which skips
// DB-known paths), not by recreating (reconcile refuses to write over it).
describe("remove — a directory git has forgotten", () => {
  /** A stranded checkout inside the container the project owns, with files in it. */
  function seedStranded(home: string): string {
    const container = join(home, ".volli", "worktrees", projectContainerName("/repo", "proj-1"));
    const wt = join(container, "VC-1-stranded");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "note.txt"), "work");
    seed(wt);
    return wt;
  }

  it("deletes the folder itself once the user confirms, and clears the stamp", async () => {
    const home = tempDir("home");
    const wt = seedStranded(home);
    const { git, calls } = forgottenGit(wt);

    const result = await remove({ db: ctx.db, git, home, blobsRoot: "unused" }, "ticket-1", {
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(wt)).toBe(false);
    // Never through `git worktree remove` — it cannot touch a path git forgot.
    expect(calls.some((c) => c.args[1] === "remove")).toBe(false);
    expect(calls.some((c) => c.args[1] === "prune")).toBe(true);
    const row = getTicketRow(ctx.db, "ticket-1")!;
    expect(row.worktree_path).toBeNull();
    // Identity survives, so the ticket can recreate its checkout immediately.
    expect(row.branch).toBe("volli/VC-1-x");
  });

  it("still asks first: an unconfirmed remove refuses with the escalation prefix", async () => {
    const home = tempDir("home");
    const wt = seedStranded(home);
    const { git } = forgottenGit(wt);

    const result = await remove({ db: ctx.db, git, home, blobsRoot: "unused" }, "ticket-1", {
      force: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Its OWN refusal, not the dirty one: the folder cannot be read at all, so
    // claiming uncommitted work would name a cause Volli can't establish. Both
    // prefixes raise the same confirm step in the dialog.
    expect(result.error).toContain("Volli can't check what's inside this worktree");
    expect(existsSync(wt)).toBe(true);
  });

  it("refuses to rm -rf a stamped path outside this workspace's own containers", async () => {
    const home = tempDir("home");
    const outside = tempDir("elsewhere");
    writeFileSync(join(outside, "precious.txt"), "not ours");
    seed(outside);
    const { git } = forgottenGit(outside);

    const result = await remove({ db: ctx.db, git, home, blobsRoot: "unused" }, "ticket-1", {
      force: true,
    });

    expect(result.ok).toBe(false);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
    expect(getTicketRow(ctx.db, "ticket-1")!.worktree_path).toBe(outside);
  });

  it("routes back to git's own refusal when the listing cannot be read at all", async () => {
    const home = tempDir("home");
    const wt = seedStranded(home);
    const { git } = scriptedGit((args) => {
      if (args[0] === "worktree" && args[1] === "list") throw new Error("not a git repository");
      if (args[0] === "worktree" && args[1] === "remove") throw new Error("fatal: nope");
      return "";
    });

    const result = await remove({ db: ctx.db, git, home, blobsRoot: "unused" }, "ticket-1", {
      force: true,
    });

    // Ambiguity must never reach the rm -rf branch.
    expect(result.ok).toBe(false);
    expect(existsSync(wt)).toBe(true);
  });
});
