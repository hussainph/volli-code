/**
 * Reconnecting a project to the folder it moved to (VC-430).
 *
 * Every assertion reads back through the repository the rest of the app reads
 * through — `getProjectById`, `listTicketsByProject`, `listWorktreePathsByProject`
 * — rather than inspecting the rows this module wrote. The whole point of a
 * relink is that the record survives the move, and only a read taken the way
 * the app takes it can say so.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AgentRequest } from "@volli/shared";

import { insertProject, getProjectById, listProjects } from "@volli/host-core/db/projects-repo";
import { projectForCreate } from "@volli/host-core/agent-dispatch/resolution";
import {
  insertTicket,
  listTicketsByProject,
  listWorktreePathsByProject,
} from "@volli/host-core/db/tickets-repo";
import { openTestDb, testProject, testTicket } from "@volli/host-core/db/test-helpers";
import type { TestDb } from "@volli/host-core/db/test-helpers";
import { scriptedGit } from "@volli/host-core/worktree/scripted-git";
import { inspectProjectFolder, relinkProject } from "@volli/host-core/project-relink";
import type { FolderProbe, ProjectRelinkDeps } from "@volli/host-core/project-relink";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

/** A folder that is there, identified by whatever makes it distinct in a test. */
function present(folder: string): FolderProbe {
  return { state: "present", folder };
}

/**
 * Deps whose disk says every folder is present — each at its OWN identity, so
 * nothing is accidentally read as the same directory — and whose git and
 * directory moves always succeed.
 */
function deps(overrides: Partial<ProjectRelinkDeps> = {}): ProjectRelinkDeps {
  return {
    db: ctx.db,
    probeFolder: async (path) => present(`dev:${path}`),
    gitAsync: scriptedGit(() => "").gitAsync,
    moveDirectory: async () => undefined,
    now: () => 1_000,
    ...overrides,
  };
}

describe("relinkProject", () => {
  it("keeps the project's id, settings and tickets when its folder is renamed", async () => {
    ctx = openTestDb();
    const project = testProject({
      id: "p1",
      name: "Volli",
      path: "/Users/me/volli",
      ticketPrefix: "VC",
      setupCommand: "pnpm install",
    });
    insertProject(ctx.db, project);
    insertTicket(ctx.db, testTicket("p1", { title: "Relink me" }));

    const outcome = await relinkProject(deps(), {
      projectId: "p1",
      path: "/Users/me/code/volli",
    });

    expect(outcome.ok).toBe(true);
    const stored = getProjectById(ctx.db, "p1");
    expect(stored?.path).toBe("/Users/me/code/volli");
    expect(stored?.name).toBe("Volli");
    expect(stored?.ticketPrefix).toBe("VC");
    expect(stored?.setupCommand).toBe("pnpm install");
    expect(listTicketsByProject(ctx.db, "p1").map((ticket) => ticket.title)).toEqual(["Relink me"]);
  });

  // The duplicate this ticket exists to prevent, seen from the other side: the
  // folder is fine, it is simply somebody else's. Refusing leaves BOTH rows as
  // they were rather than pointing two projects at one checkout.
  it("refuses a folder another project already tracks, and changes nothing", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));
    insertProject(ctx.db, testProject({ id: "p2", name: "Atlas", path: "/Users/me/atlas" }));

    const outcome = await relinkProject(deps(), { projectId: "p1", path: "/Users/me/atlas" });

    expect(outcome).toEqual({
      ok: false,
      refusal: "claimed",
      error: "Atlas already tracks that folder.",
    });
    expect(getProjectById(ctx.db, "p1")?.path).toBe("/Users/me/volli");
    expect(getProjectById(ctx.db, "p2")?.path).toBe("/Users/me/atlas");
  });

  // macOS is case-insensitive by default, so these two paths name ONE folder.
  // The strings differ, so only the disk can say they are the same — and it is
  // the disk this asks. Without it, two rows end up on one checkout and every
  // path-keyed lookup answers with whichever it finds first.
  it("refuses a folder another project tracks under a different spelling", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));
    insertProject(ctx.db, testProject({ id: "p2", name: "Atlas", path: "/Users/me/atlas" }));

    const outcome = await relinkProject(
      deps({
        // Both spellings are the same directory, as a case-insensitive volume
        // reports it.
        probeFolder: async (path) =>
          present(path.toLowerCase() === "/users/me/atlas" ? "dev:atlas" : `dev:${path}`),
      }),
      { projectId: "p1", path: "/Users/me/Atlas" },
    );

    expect(outcome).toEqual({
      ok: false,
      refusal: "claimed",
      error: "Atlas already tracks that folder.",
    });
    expect(getProjectById(ctx.db, "p1")?.path).toBe("/Users/me/volli");
  });

  it("refuses a replacement folder that is not on disk", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));

    const outcome = await relinkProject(
      deps({ probeFolder: async () => ({ state: "missing", folder: null }) }),
      { projectId: "p1", path: "/Users/me/nowhere" },
    );

    expect(outcome).toEqual({
      ok: false,
      refusal: "missing",
      error: "That folder doesn't exist.",
    });
    expect(getProjectById(ctx.db, "p1")?.path).toBe("/Users/me/volli");
  });

  it("refuses a project it has never heard of", async () => {
    ctx = openTestDb();

    await expect(
      relinkProject(deps(), { projectId: "ghost", path: "/Users/me/volli" }),
    ).resolves.toEqual({ ok: false, error: "Unknown project" });
  });

  // Moving the main checkout breaks git's two-way link with every worktree
  // hanging off it: each worktree's `.git` file still points into the old
  // location. `git worktree repair`, run from the moved main checkout, is git's
  // own answer — and it is run from the NEW path because that is the only place
  // the repository now is.
  it("repairs git's links to the ticket worktrees from the folder it moved to", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));
    insertTicket(
      ctx.db,
      testTicket("p1", { worktreePath: "/Users/me/.volli/worktrees/volli-p1/VC-1-a" }),
    );
    const git = scriptedGit(() => "");

    const outcome = await relinkProject(deps({ gitAsync: git.gitAsync }), {
      projectId: "p1",
      // Same folder name, a new parent: the container never moves, so every
      // worktree is still where git's own records say. The BARE command is the
      // documented fix for that, and naming paths git can already reach would
      // add nothing.
      path: "/Users/me/code/volli",
    });

    expect(git.calls).toEqual([{ args: ["worktree", "repair"], cwd: "/Users/me/code/volli" }]);
    expect(outcome.ok && outcome.aftermath).toMatchObject({
      worktrees: 1,
      worktreesRepaired: true,
    });
  });

  // The relink has already committed by the time git is asked, so a repair
  // that fails is reported rather than thrown: undoing the row would put the
  // project back to pointing at a folder that is definitely not there.
  it("reports a failed repair instead of failing the relink", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));
    insertTicket(
      ctx.db,
      testTicket("p1", { worktreePath: "/Users/me/.volli/worktrees/volli-p1/VC-1-a" }),
    );
    const git = scriptedGit(() => {
      throw new Error("fatal: not a git repository");
    });

    const outcome = await relinkProject(deps({ gitAsync: git.gitAsync }), {
      projectId: "p1",
      path: "/Users/me/code/volli",
    });

    expect(outcome.ok).toBe(true);
    expect(getProjectById(ctx.db, "p1")?.path).toBe("/Users/me/code/volli");
    expect(outcome.ok && outcome.aftermath).toMatchObject({
      worktrees: 1,
      worktreesRepaired: false,
    });
  });

  // A project with no worktrees is not a git question at all — it may not even
  // be a repository — so git is never run, and "repaired" stays vacuously true.
  it("never runs git for a project with no worktrees on disk", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));
    const git = scriptedGit(() => "");

    const outcome = await relinkProject(deps({ gitAsync: git.gitAsync }), {
      projectId: "p1",
      path: "/Users/me/code/volli",
    });

    expect(git.calls).toEqual([]);
    expect(outcome.ok && outcome.aftermath.worktrees).toBe(0);
  });

  // A worktree row whose directory was deleted is not something git can
  // repair, and counting it would promise a person a reconnection that never
  // happened.
  it("counts only the worktrees still on disk", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));
    insertTicket(ctx.db, testTicket("p1", { worktreePath: "/Users/me/.volli/wt/kept" }));
    insertTicket(ctx.db, testTicket("p1", { worktreePath: "/Users/me/.volli/wt/deleted" }));

    const outcome = await relinkProject(
      deps({
        probeFolder: async (path) =>
          path.endsWith("deleted") ? { state: "missing", folder: null } : present(`dev:${path}`),
      }),
      { projectId: "p1", path: "/Users/me/code/volli" },
    );

    expect(outcome.ok && outcome.aftermath.worktrees).toBe(1);
  });

  // Nothing a database write does can move a running process: a terminal or an
  // agent spawned in the old folder keeps that cwd until it is restarted. The
  // relink still happens — this is a warning, not a refusal.
  it("counts the live sessions still working in the folder the project left", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));

    const asked: string[] = [];
    const outcome = await relinkProject(
      deps({
        busyWorktreeSites: async (target) => {
          asked.push(target);
          return [
            { directory: "/Users/me/volli", surface: "terminal" },
            { directory: "/Users/me/volli/packages/cli", surface: "agent" },
            { directory: "/Users/me/somewhere-else", surface: "terminal" },
          ];
        },
      }),
      { projectId: "p1", path: "/Users/me/code/volli" },
    );

    // Asked about the folder being LEFT: that is where the live work is.
    expect(asked).toEqual(["/Users/me/volli"]);
    expect(outcome.ok && outcome.aftermath.liveSessions).toBe(2);
  });

  it("reports no live sessions when nothing can say what is running", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));

    const outcome = await relinkProject(deps({ busyWorktreeSites: undefined }), {
      projectId: "p1",
      path: "/Users/me/code/volli",
    });

    expect(outcome.ok && outcome.aftermath.liveSessions).toBe(0);
  });
});

/**
 * The container a project's ticket worktrees live in is named after the project
 * folder, and OWNERSHIP is decided by recomputing that name from the project
 * row (VC-113). So a rename that left the container behind would take every
 * existing worktree out of the set this database recognises as its own: the
 * remove path would refuse to delete an untracked checkout, the orphan-delete
 * channel would refuse, and the orphan scan would not see the container at all.
 */
describe("the worktree container after a rename", () => {
  const OLD_CONTAINER = "/Users/me/.volli/worktrees/volli-p1";
  const NEW_CONTAINER = "/Users/me/.volli/worktrees/volli-2-p1";

  function projectWithTwoWorktrees(): void {
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));
    insertTicket(ctx.db, testTicket("p1", { worktreePath: `${OLD_CONTAINER}/VC-1-a` }));
    insertTicket(ctx.db, testTicket("p1", { worktreePath: `${OLD_CONTAINER}/VC-2-b` }));
  }

  it("moves the container and rewrites every ticket's stamped path", async () => {
    ctx = openTestDb();
    projectWithTwoWorktrees();
    const moves: Array<[string, string]> = [];
    const git = scriptedGit(() => "");

    const outcome = await relinkProject(
      deps({
        gitAsync: git.gitAsync,
        moveDirectory: async (from, to) => {
          moves.push([from, to]);
        },
      }),
      { projectId: "p1", path: "/Users/me/volli-2" },
    );

    expect(moves).toEqual([[OLD_CONTAINER, NEW_CONTAINER]]);
    // Read back the way the app reads them: a directory that moved without its
    // row is a path Volli would go on opening where it no longer is.
    expect(listWorktreePathsByProject(ctx.db, "p1").toSorted()).toEqual([
      `${NEW_CONTAINER}/VC-1-a`,
      `${NEW_CONTAINER}/VC-2-b`,
    ]);
    // And git is told where they went, because the repository's own records
    // still name the locations they left.
    expect(git.calls).toEqual([
      {
        args: ["worktree", "repair", `${NEW_CONTAINER}/VC-1-a`, `${NEW_CONTAINER}/VC-2-b`],
        cwd: "/Users/me/volli-2",
      },
    ]);
    expect(outcome.ok && outcome.aftermath.worktreesRepaired).toBe(true);
    expect(outcome.ok && outcome.aftermath).toMatchObject({
      worktrees: 2,
      containerMoveNeeded: true,
      containerMoved: true,
    });
  });

  it("leaves the container alone when only the parent folder moved", async () => {
    ctx = openTestDb();
    projectWithTwoWorktrees();
    const moves: Array<[string, string]> = [];

    const outcome = await relinkProject(
      deps({
        moveDirectory: async (from, to) => {
          moves.push([from, to]);
        },
      }),
      { projectId: "p1", path: "/Users/me/code/volli" },
    );

    expect(moves).toEqual([]);
    expect(listWorktreePathsByProject(ctx.db, "p1").toSorted()).toEqual([
      `${OLD_CONTAINER}/VC-1-a`,
      `${OLD_CONTAINER}/VC-2-b`,
    ]);
    expect(outcome.ok && outcome.aftermath).toMatchObject({
      containerMoveNeeded: false,
      containerMoved: true,
    });
  });

  // A move that fails must not fail the relink or half-rewrite the rows: the
  // project is already pointing at its new folder, and the worktrees are still
  // exactly where they were. What changes is that the person is told.
  it("reports a container that could not move, and leaves every row alone", async () => {
    ctx = openTestDb();
    projectWithTwoWorktrees();

    const outcome = await relinkProject(
      deps({
        moveDirectory: async () => {
          throw new Error("EPERM");
        },
      }),
      { projectId: "p1", path: "/Users/me/volli-2" },
    );

    expect(outcome.ok).toBe(true);
    expect(getProjectById(ctx.db, "p1")?.path).toBe("/Users/me/volli-2");
    expect(listWorktreePathsByProject(ctx.db, "p1").toSorted()).toEqual([
      `${OLD_CONTAINER}/VC-1-a`,
      `${OLD_CONTAINER}/VC-2-b`,
    ]);
    expect(outcome.ok && outcome.aftermath).toMatchObject({
      containerMoveNeeded: true,
      containerMoved: false,
    });
  });

  // A row stamped somewhere else entirely — a hand-made checkout, or a path
  // from before the container convention — is not this move's business, and
  // guessing a container for it is how a rename would move a directory nobody
  // asked it to touch.
  it("moves nothing when no worktree sits in the container the project owns", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));
    insertTicket(ctx.db, testTicket("p1", { worktreePath: "/Users/me/elsewhere/VC-1-a" }));
    const moves: Array<[string, string]> = [];

    const outcome = await relinkProject(
      deps({
        moveDirectory: async (from, to) => {
          moves.push([from, to]);
        },
      }),
      { projectId: "p1", path: "/Users/me/volli-2" },
    );

    expect(moves).toEqual([]);
    expect(listWorktreePathsByProject(ctx.db, "p1")).toEqual(["/Users/me/elsewhere/VC-1-a"]);
    expect(outcome.ok && outcome.aftermath).toMatchObject({
      containerMoveNeeded: true,
      containerMoved: false,
    });
  });

  // A worktree that moved and then turned out not to be on disk is named to
  // nobody: git is asked only about directories that are actually there, so a
  // deleted checkout cannot turn a good repair into a reported failure.
  it("never names a moved worktree git could not find anyway", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));
    insertTicket(ctx.db, testTicket("p1", { worktreePath: `${OLD_CONTAINER}/VC-1-a` }));
    insertTicket(ctx.db, testTicket("p1", { worktreePath: `${OLD_CONTAINER}/VC-2-gone` }));
    const git = scriptedGit(() => "");

    const outcome = await relinkProject(
      deps({
        gitAsync: git.gitAsync,
        probeFolder: async (path) =>
          path.endsWith("VC-2-gone") ? { state: "missing", folder: null } : present(`dev:${path}`),
      }),
      { projectId: "p1", path: "/Users/me/volli-2" },
    );

    expect(git.calls).toEqual([
      { args: ["worktree", "repair", `${NEW_CONTAINER}/VC-1-a`], cwd: "/Users/me/volli-2" },
    ]);
    expect(outcome.ok && outcome.aftermath.worktrees).toBe(1);
  });

  // Against the REAL filesystem and the REAL git runner, with no seams at all:
  // every other case here proves a rule, and this one proves the wiring those
  // rules hang off actually moves a directory and actually runs a command. The
  // temp folder is deliberately not a repository, so git fails — which is the
  // other half of the claim, that a failed repair costs a notice and not the
  // relink.
  it("moves a real container on disk, and reports a real repair that failed", async () => {
    ctx = openTestDb();
    const home = mkdtempSync(join(tmpdir(), "volli-relink-"));
    const from = join(home, "volli");
    const to = join(home, "volli-renamed");
    mkdirSync(from);
    mkdirSync(to);
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: from }));

    const container = join(home, "worktrees", "volli-p1");
    const inside = join(container, "VC-1-a");
    mkdirSync(inside, { recursive: true });
    insertTicket(ctx.db, testTicket("p1", { worktreePath: inside }));
    // A row stamped outside the container the project owns: it must keep the
    // path it has, because nothing moved it.
    const outside = join(home, "hand-made");
    mkdirSync(outside);
    insertTicket(ctx.db, testTicket("p1", { worktreePath: outside }));

    try {
      const outcome = await relinkProject(
        { db: ctx.db, now: () => 1_000 },
        {
          projectId: "p1",
          path: to,
        },
      );

      expect(existsSync(join(home, "worktrees", "volli-renamed-p1", "VC-1-a"))).toBe(true);
      expect(existsSync(inside)).toBe(false);
      expect(listWorktreePathsByProject(ctx.db, "p1").toSorted()).toEqual(
        [join(home, "worktrees", "volli-renamed-p1", "VC-1-a"), outside].toSorted(),
      );
      expect(outcome.ok && outcome.aftermath).toMatchObject({
        worktrees: 2,
        containerMoveNeeded: true,
        containerMoved: true,
        worktreesRepaired: false,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // No worktrees means no container on disk to move, so the rename costs
  // nothing and says nothing.
  it("has nothing to move for a project with no worktrees", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));

    const outcome = await relinkProject(deps(), { projectId: "p1", path: "/Users/me/volli-2" });

    expect(outcome.ok && outcome.aftermath).toMatchObject({
      worktrees: 0,
      containerMoveNeeded: true,
      containerMoved: true,
    });
  });
});

/** A bare `volli board` request, as the socket door would hand it over. */
function requestFrom(cwd: string): AgentRequest {
  return { v: 1, cmd: "board", args: {}, ctx: { cwd, env: {} } };
}

/**
 * AC3's other half: the socket door resolves the project an agent means from
 * its cwd (`resolveAgentContext`'s cwd rung), reading the project list out of
 * the same rows the relink wrote. These drive the real `projectForCreate` the
 * dispatch calls, so nothing here can agree with the relink by construction.
 */
describe("CLI context after a relink", () => {
  it("resolves the project from a cwd inside the folder it moved to", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));
    await relinkProject(deps(), { projectId: "p1", path: "/Users/me/code/volli" });

    const resolved = projectForCreate(
      ctx.db,
      listProjects(ctx.db),
      null,
      requestFrom("/Users/me/code/volli/packages/cli"),
    );

    expect(resolved.ok && resolved.project.id).toBe("p1");
  });

  it("no longer resolves anything from the folder the project left", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));
    await relinkProject(deps(), { projectId: "p1", path: "/Users/me/code/volli" });

    const resolved = projectForCreate(
      ctx.db,
      listProjects(ctx.db),
      null,
      requestFrom("/Users/me/volli"),
    );

    expect(resolved.ok).toBe(false);
  });
});

describe("inspectProjectFolder", () => {
  it("reports a registered folder that is no longer on disk, with the path it wanted", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));

    await expect(
      inspectProjectFolder(ctx.db, "p1", async () => ({ state: "missing", folder: null })),
    ).resolves.toEqual({ ok: true, path: "/Users/me/volli", state: "missing" });
  });

  it("reports a registered folder that is still there", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));

    await expect(inspectProjectFolder(ctx.db, "p1", async () => present("dev:1"))).resolves.toEqual(
      { ok: true, path: "/Users/me/volli", state: "present" },
    );
  });

  // A path that resolves to a FILE is its own fault, distinct from a missing
  // one: the recovery is the same relink, but the sentence a person reads is
  // not, so the state has to survive the trip.
  it("reports a registered path that is a file rather than a folder", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli.zip" }));

    await expect(
      inspectProjectFolder(ctx.db, "p1", async () => ({ state: "not-a-directory", folder: null })),
    ).resolves.toEqual({ ok: true, path: "/Users/me/volli.zip", state: "not-a-directory" });
  });

  it("refuses a project it has never heard of", async () => {
    ctx = openTestDb();

    await expect(
      inspectProjectFolder(ctx.db, "ghost", async () => present("dev:1")),
    ).resolves.toEqual({ ok: false, error: "Unknown project" });
  });
});
