/**
 * Reconnecting a project to the folder it moved to (VC-430).
 *
 * Every assertion reads back through the repository the rest of the app reads
 * through — `getProjectById`, `listTicketsByProject` — rather than inspecting
 * the row this module wrote. The whole point of a relink is that the record
 * survives the move, and only a read taken the way the app takes it can say so.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AgentRequest } from "@volli/shared";

import { insertProject, getProjectById, listProjects } from "./db/projects-repo";
import { projectForCreate } from "./agent-dispatch/resolution";
import { insertTicket, listTicketsByProject } from "./db/tickets-repo";
import { openTestDb, testProject, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { scriptedGit } from "./worktree/scripted-git";
import { inspectProjectFolder, relinkProject } from "./project-relink";
import type { ProjectRelinkDeps } from "./project-relink";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

/** Deps whose disk says every folder is present and whose git always succeeds. */
function deps(overrides: Partial<ProjectRelinkDeps> = {}): ProjectRelinkDeps {
  return {
    db: ctx.db,
    inspectFolder: () => "present",
    worktreeExists: () => true,
    gitAsync: scriptedGit(() => "").gitAsync,

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

  it("refuses a replacement folder that is not on disk", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));

    const outcome = await relinkProject(deps({ inspectFolder: () => "missing" }), {
      projectId: "p1",
      path: "/Users/me/nowhere",
    });

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
  // location. `git worktree repair`, run from the moved main checkout, is
  // git's own answer, and it is run from the NEW path because that is the
  // only place the repository now is.
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

    const outcome = await relinkProject(deps({ worktreeExists: (path) => path.endsWith("kept") }), {
      projectId: "p1",
      path: "/Users/me/code/volli",
    });

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

  // New worktrees are grouped in a container named after the project folder,
  // so a RENAME sends the next one somewhere the existing ones are not. A move
  // that keeps the folder's name changes nothing about where they land.
  it("notes when the rename changes where new worktrees will be created", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));

    const renamed = await relinkProject(deps(), { projectId: "p1", path: "/Users/me/volli-2" });
    expect(renamed.ok && renamed.aftermath.containerRenamed).toBe(true);
  });

  it("says nothing about worktree grouping when only the parent folder moved", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));

    const moved = await relinkProject(deps(), { projectId: "p1", path: "/Users/me/code/volli" });
    expect(moved.ok && moved.aftermath.containerRenamed).toBe(false);
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
  it("reports a registered folder that is no longer on disk, with the path it wanted", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));

    expect(inspectProjectFolder(ctx.db, "p1", () => "missing")).toEqual({
      ok: true,
      path: "/Users/me/volli",
      state: "missing",
    });
  });

  it("reports a registered folder that is still there", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", name: "Volli", path: "/Users/me/volli" }));

    expect(inspectProjectFolder(ctx.db, "p1", () => "present")).toEqual({
      ok: true,
      path: "/Users/me/volli",
      state: "present",
    });
  });

  it("refuses a project it has never heard of", () => {
    ctx = openTestDb();

    expect(inspectProjectFolder(ctx.db, "ghost", () => "present")).toEqual({
      ok: false,
      error: "Unknown project",
    });
  });
});
