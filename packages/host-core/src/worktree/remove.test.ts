import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { listTicketEvents } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { archiveTicket, getTicketRow, insertTicket, updateTicketFields } from "../db/tickets-repo";
import { projectContainerName } from "./containers";
import {
  acquireDeletionLease,
  acquireWorktreeStartLease,
  isUnderDeletion,
  resetDeletionLeasesForTest,
  UNDER_DELETION_REFUSAL,
} from "./deletion-lease";
import { getPhase, resetPhasesForTest, setPhase } from "./phase";
import { remove } from "./remove";
import { resetRepositoryTurnsForTest, withRepositoryWorktreeTurn } from "./repository-turn";
import { scriptedGit } from "./scripted-git";

let ctx: TestDb;
let tempDirs: string[] = [];

beforeEach(() => {
  ctx = openTestDb();
  resetPhasesForTest();
  resetDeletionLeasesForTest();
  resetRepositoryTurnsForTest();
});

afterEach(() => {
  resetDeletionLeasesForTest();
  resetRepositoryTurnsForTest();
  ctx.cleanup();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

/** Lets real macrotasks run, so "it has not removed anything yet" is evidence. */
async function settleRemoval(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("remove — the repository's turn", () => {
  it("waits for the repository's turn before running git worktree remove", async () => {
    // The deletion lease orders this against work starting in THIS DIRECTORY.
    // The turn orders its git command against every other change to the same
    // REPOSITORY — a different hazard with a different key, because git does
    // not promise concurrent `worktree add`/`remove`/`prune` are safe.
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, gitAsync, calls } = statusGit(wt, gitDir, false);
    const removedYet = (): boolean => calls.some((call) => call.args[1] === "remove");

    let releaseTurn!: () => void;
    const turn = withRepositoryWorktreeTurn(
      "/repo",
      () => new Promise<void>((resolve) => (releaseTurn = resolve)),
    );

    const removal = remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
      force: true,
    });
    await settleRemoval();
    expect(removedYet()).toBe(false);

    releaseTurn();
    await turn;
    await expect(removal).resolves.toMatchObject({ ok: true });

    // It waited rather than failing, and then did the whole job.
    expect(removedYet()).toBe(true);
    expect(getTicketRow(ctx.db, "ticket-1")?.worktree_path).toBeNull();
  });

  it("reaches git worktree remove within the same settle budget when no turn is held", async () => {
    // The negative control. Without it, the assertion above proves only that
    // `settleRemoval()` is too short for the pipeline to have got there — which
    // would still pass with the repository turn deleted.
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, gitAsync, calls } = statusGit(wt, gitDir, false);

    const removal = remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
      force: true,
    });
    await settleRemoval();

    expect(calls.some((call) => call.args[1] === "remove")).toBe(true);
    await expect(removal).resolves.toMatchObject({ ok: true });
  });

  it("waits for the repository's turn before pruning a directory that is already gone", async () => {
    // The other mutation site here is `worktree prune`, which drops admin
    // records across the WHOLE repository — the last command that may run
    // beside another ticket's `worktree add`.
    seed(join(tempDir("gone"), "missing"));
    const { git, gitAsync, calls } = scriptedGit(() => "");
    const prunedYet = (): boolean => calls.some((call) => call.args[1] === "prune");

    let releaseTurn!: () => void;
    const turn = withRepositoryWorktreeTurn(
      "/repo",
      () => new Promise<void>((resolve) => (releaseTurn = resolve)),
    );

    const removal = remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
      force: false,
    });
    await settleRemoval();
    expect(prunedYet()).toBe(false);

    releaseTurn();
    await turn;
    await expect(removal).resolves.toMatchObject({ ok: true });

    expect(prunedYet()).toBe(true);
    // Best-effort metadata: the identity clear happens either way.
    expect(getTicketRow(ctx.db, "ticket-1")?.worktree_path).toBeNull();
  });

  it("still clears identity when the queued prune rejects", async () => {
    // The turn must not turn a best-effort prune into a dead-ended ticket.
    seed(join(tempDir("gone"), "missing"));
    const { git, gitAsync } = scriptedGit(() => {
      throw new Error("prune exploded");
    });

    await expect(
      remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", { force: false }),
    ).resolves.toMatchObject({ ok: true });
    expect(getTicketRow(ctx.db, "ticket-1")?.worktree_path).toBeNull();
  });
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
    const { git, gitAsync, calls } = scriptedGit(() => "");
    const result = await remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
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
    const { git, gitAsync, calls, syncCalls } = statusGit(wt, gitDir, false);

    const result = await remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
      force: false,
    });

    expect(result.ok).toBe(true);
    // Plain remove — never --force for a clean worktree.
    const removeCall = calls.find((c) => c.args[1] === "remove");
    expect(removeCall?.args).toEqual(["worktree", "remove", wt]);
    // VC-383's guarantee is the seam, not only the eventual command list: a
    // sync `deps.git` regression must fail even when it returns the same text.
    expect(syncCalls).toHaveLength(0);

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
    const { git, gitAsync, calls } = scriptedGit(() => "");

    const result = await remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
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
    const { git, gitAsync } = scriptedGit(() => "");

    const result = await remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
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
    const { git, gitAsync, calls } = statusGit(wt, gitDir, true);

    const result = await remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
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
    const { git, gitAsync, calls } = statusGit(wt, gitDir, true);

    const result = await remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
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
    const { git, gitAsync, calls } = statusGit(wt, gitDir, false);
    const order: string[] = [];
    const released: string[] = [];

    const tracedGit = async (args: readonly string[], cwd: string): Promise<string> => {
      order.push(`git:${args[1] ?? args[0]}`);
      return gitAsync(args, cwd);
    };

    const result = await remove(
      { db: ctx.db, git, gitAsync: tracedGit, blobsRoot: "unused" },
      "ticket-1",
      {
        force: false,
        releaseAgentSites: async (directory) => {
          order.push("release");
          released.push(directory);
          return { released: ["chat-1"], stillOpen: [] };
        },
      },
    );

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
    const { git, gitAsync } = statusGit(wt, gitDir, true);
    let releases = 0;

    const result = await remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
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
    const { git, gitAsync } = scriptedGit(() => "");
    const released: string[] = [];

    const result = await remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
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
    const { git, gitAsync, calls } = statusGit(wt, gitDir, false);

    const result = await remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
      force: false,
      releaseAgentSites: async () => ({ released: [], stillOpen: ["chat-1"] }),
    });

    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.args[1] === "remove")).toBe(true);
    expect(getTicketRow(ctx.db, "ticket-1")!.worktree_path).toBeNull();
  });
});

describe("remove — deletion lease", () => {
  it("holds the lease across the destructive step and refuses a contending remove", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, gitAsync } = statusGit(wt, gitDir, false);
    let signalDelete!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      signalDelete = () => resolve();
    });
    let releaseDelete!: () => void;
    const deleteMayFinish = new Promise<void>((resolve) => {
      releaseDelete = () => resolve();
    });
    const tracedGit = async (args: readonly string[], cwd: string): Promise<string> => {
      if (args[0] === "worktree" && args[1] === "remove") {
        signalDelete();
        await deleteMayFinish;
      }
      return gitAsync(args, cwd);
    };
    const worktree = { db: ctx.db, git, gitAsync: tracedGit, blobsRoot: "unused" };

    const first = remove(worktree, "ticket-1", { force: false });
    await deleteStarted;

    // The git call has begun but cannot return. Both a nested start and another
    // remover must lose the same non-waiting overlap contest during that span.
    expect(isUnderDeletion(wt)).toBe(true);
    expect(acquireWorktreeStartLease(join(wt, "nested-terminal"))).toBeNull();
    await expect(remove(worktree, "ticket-1", { force: false })).resolves.toEqual({
      ok: false,
      error: UNDER_DELETION_REFUSAL,
    });

    releaseDelete();
    await expect(first).resolves.toEqual({ ok: true, value: undefined });
    const next = acquireDeletionLease(wt);
    expect(next).not.toBeNull();
    next?.release();
  });

  it("releases the lease after a dirty refusal", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, gitAsync } = statusGit(wt, gitDir, true);
    let heldDuringDirtyProbe = false;
    const tracedGit = async (args: readonly string[], cwd: string): Promise<string> => {
      if (args[0] === "status") heldDuringDirtyProbe = isUnderDeletion(wt);
      return gitAsync(args, cwd);
    };

    const result = await remove(
      { db: ctx.db, git, gitAsync: tracedGit, blobsRoot: "unused" },
      "ticket-1",
      { force: false },
    );

    expect(result.ok).toBe(false);
    expect(heldDuringDirtyProbe).toBe(true);
    expect(isUnderDeletion(wt)).toBe(false);
    const next = acquireDeletionLease(wt);
    expect(next).not.toBeNull();
    next?.release();
  });

  it("releases the lease after an unverifiable refusal", async () => {
    const home = tempDir("home");
    const wt = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName("/repo", "proj-1"),
      "VC-1-stranded",
    );
    mkdirSync(wt, { recursive: true });
    seed(wt);
    const { git, gitAsync } = forgottenGit(wt);
    let heldDuringListing = false;
    const tracedGit = async (args: readonly string[], cwd: string): Promise<string> => {
      if (args[0] === "worktree" && args[1] === "list") {
        heldDuringListing = isUnderDeletion(wt);
      }
      return gitAsync(args, cwd);
    };

    const result = await remove(
      { db: ctx.db, git, gitAsync: tracedGit, home, blobsRoot: "unused" },
      "ticket-1",
      { force: false },
    );

    expect(result.ok).toBe(false);
    expect(heldDuringListing).toBe(true);
    expect(isUnderDeletion(wt)).toBe(false);
    const next = acquireDeletionLease(wt);
    expect(next).not.toBeNull();
    next?.release();
  });

  it("releases the lease when a bound-site release throws", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, gitAsync } = statusGit(wt, gitDir, false);
    let heldDuringThrow = false;

    await expect(
      remove({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "ticket-1", {
        force: false,
        releaseAgentSites: async () => {
          heldDuringThrow = isUnderDeletion(wt);
          throw new Error("release failed");
        },
      }),
    ).rejects.toThrow("release failed");

    expect(heldDuringThrow).toBe(true);
    expect(isUnderDeletion(wt)).toBe(false);
    const next = acquireDeletionLease(wt);
    expect(next).not.toBeNull();
    next?.release();
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
    const { git, gitAsync, calls } = forgottenGit(wt);

    const result = await remove(
      { db: ctx.db, git, gitAsync, home, blobsRoot: "unused" },
      "ticket-1",
      {
        force: true,
      },
    );

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
    const { git, gitAsync } = forgottenGit(wt);

    const result = await remove(
      { db: ctx.db, git, gitAsync, home, blobsRoot: "unused" },
      "ticket-1",
      {
        force: false,
      },
    );

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
    const { git, gitAsync } = forgottenGit(outside);

    const result = await remove(
      { db: ctx.db, git, gitAsync, home, blobsRoot: "unused" },
      "ticket-1",
      {
        force: true,
      },
    );

    expect(result.ok).toBe(false);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
    expect(getTicketRow(ctx.db, "ticket-1")!.worktree_path).toBe(outside);
  });

  it("routes back to git's own refusal when the listing cannot be read at all", async () => {
    const home = tempDir("home");
    const wt = seedStranded(home);
    const { git, gitAsync } = scriptedGit((args) => {
      if (args[0] === "worktree" && args[1] === "list") throw new Error("not a git repository");
      if (args[0] === "worktree" && args[1] === "remove") throw new Error("fatal: nope");
      return "";
    });

    const result = await remove(
      { db: ctx.db, git, gitAsync, home, blobsRoot: "unused" },
      "ticket-1",
      {
        force: true,
      },
    );

    // Ambiguity must never reach the rm -rf branch.
    expect(result.ok).toBe(false);
    expect(existsSync(wt)).toBe(true);
  });
});
