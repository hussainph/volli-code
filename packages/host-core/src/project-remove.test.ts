/**
 * Removing a project (VC-796, VC-822): its live work stops while it is still
 * on the rail, then it is DETACHED, keeping its tickets and Sessions, and the
 * windows hear about it after.
 *
 * Every port records the step it was called at together with what the
 * database held then, so "before the detach" is read off the database rather
 * than inferred from call order alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { OpenNativeBinding } from "@volli/session-engine";

import {
  getProjectById,
  insertProject,
  isProjectAttached,
  listProjects,
  listProjectSessionIds,
} from "./db/projects-repo";
import { ProjectFrozenError } from "./cloud-move/freeze";
import { insertTicket } from "./db/tickets-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "./db/test-helpers";
import {
  hostProjectLiveWork,
  ProjectRemovalRefused,
  removeProject,
  type ProjectLiveWork,
  type ProjectLiveWorkSources,
  type ProjectRemovalPorts,
} from "./project-remove";
import type { AgentSiteRuntime } from "./worktree/agent-sites";

let ctx: TestDb;

beforeEach(() => {
  seed();
});

afterEach(() => {
  ctx.cleanup();
});

function insertSession(id: string, projectId: string): void {
  ctx.db
    .prepare(
      "INSERT INTO sessions (id, project_id, ticket_id, title, created_at) VALUES (?, ?, NULL, ?, 1)",
    )
    .run(id, projectId, id);
}

/** A move of p1 in its first frozen state, as the move engine journals it. */
function freezeP1(): void {
  ctx.db.exec(`
    INSERT INTO cloud_move_queues VALUES ('q', 'u', 'w', 'r', 1, 0, 'pending', NULL, 'running', 1, 1);
    INSERT INTO cloud_moves (move_id, queue_id, project_id, position, user_id, workspace_id,
      runner_id, state, app_version, mapper_version, created_at, updated_at)
    VALUES ('m', 'q', 'p1', 0, 'u', 'w', 'r', 'frozen', 'test', 3, 1, 1);
  `);
}

function removedAt(projectId: string): number | null {
  return (
    ctx.db.prepare("SELECT removed_at FROM projects WHERE id = ?").get(projectId) as {
      removed_at: number | null;
    }
  ).removed_at;
}

interface Step {
  step: string;
  /** Whether the project was still on the rail when the step ran. */
  onRail: boolean;
  /** The project's Session rows when the step ran. */
  sessions: readonly string[];
  arg?: unknown;
}

function recorder(overrides: Partial<ProjectLiveWork> = {}) {
  const steps: Step[] = [];
  const note = (step: string, arg?: unknown) => {
    steps.push({
      step,
      onRail: isProjectAttached(ctx.db, "p1"),
      sessions: listProjectSessionIds(ctx.db, "p1"),
      ...(arg === undefined ? {} : { arg }),
    });
  };
  const live: ProjectLiveWork = {
    releaseBindings: async (ids) => {
      note("releaseBindings", [...ids].toSorted());
      return { stillOpen: [] };
    },
    disposeShells: (ids) => note("disposeShells", [...ids].toSorted()),
    killTerminals: (ids) => note("killTerminals", [...ids].toSorted()),
    closeBrowserTabs: (projectId) => note("closeBrowserTabs", projectId),
    mcp: {
      disconnect: (projectId) => {
        note("mcp.disconnect", projectId);
        return ["server-1"];
      },
      forget: (serverIds) => note("mcp.forget", serverIds),
    },
    ...overrides,
  };
  const ports: ProjectRemovalPorts = {
    db: ctx.db,
    live,
    disposeFeed: (projectId) => note("disposeFeed", projectId),
    announce: () => note("announce"),
    now: () => 42,
  };
  return { steps, ports };
}

function seed(): void {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "p1", path: "/repo/one" }));
  insertProject(ctx.db, testProject({ id: "p2", path: "/repo/two" }));
  insertTicket(ctx.db, testTicket("p1", { id: "t-live", ticketNumber: 1 }));
  insertTicket(ctx.db, testTicket("p1", { id: "t-archived", ticketNumber: 2 }));
  ctx.db.prepare("UPDATE tickets SET archived_at = 5 WHERE id = 't-archived'").run();
  insertSession("s-board", "p1");
  insertSession("s-ticket", "p1");
  insertSession("s-other", "p2");
}

describe("removeProject", () => {
  it("stops every Session's live work while the project is on the rail, then detaches it", async () => {
    const { steps, ports } = recorder();

    await removeProject(ports, "p1");

    const both = ["s-board", "s-ticket"];
    expect(steps).toEqual([
      { step: "releaseBindings", onRail: true, sessions: both, arg: both },
      { step: "disposeShells", onRail: true, sessions: both, arg: both },
      { step: "killTerminals", onRail: true, sessions: both, arg: both },
      { step: "closeBrowserTabs", onRail: true, sessions: both, arg: "p1" },
      { step: "mcp.disconnect", onRail: true, sessions: both, arg: "p1" },
      // Detached by now, and nothing cascaded: its Sessions are all still there.
      { step: "mcp.forget", onRail: false, sessions: both, arg: ["server-1"] },
      { step: "disposeFeed", onRail: false, sessions: both, arg: "p1" },
      { step: "announce", onRail: false, sessions: both },
    ]);
    expect(isProjectAttached(ctx.db, "p2")).toBe(true);
    expect(listProjectSessionIds(ctx.db, "p2")).toEqual(["s-other"]);
  });

  // The defect (VC-822): removal used to delete the row, and the cascades took
  // every ticket, live or archived, and every Session with its history.
  it("keeps the project's tickets and Sessions, and only hides it from the rail", async () => {
    const { ports } = recorder();

    await removeProject(ports, "p1");

    expect(listProjects(ctx.db).map(({ id }) => id)).toEqual(["p2"]);
    expect(getProjectById(ctx.db, "p1")).toMatchObject({ id: "p1", path: "/repo/one" });
    expect(removedAt("p1")).toBe(42);
    expect(
      ctx.db
        .prepare("SELECT id, archived_at FROM tickets WHERE project_id = 'p1' ORDER BY id")
        .all(),
    ).toEqual([
      { id: "t-archived", archived_at: 5 },
      { id: "t-live", archived_at: null },
    ]);
    expect(listProjectSessionIds(ctx.db, "p1")).toEqual(["s-board", "s-ticket"]);
  });

  it("refuses, stopping and detaching nothing else, when a binding will not close", async () => {
    const { steps, ports } = recorder({
      releaseBindings: async () => ({ stillOpen: ["s-ticket"] }),
    });

    const refusal = removeProject(ports, "p1");

    await expect(refusal).rejects.toBeInstanceOf(ProjectRemovalRefused);
    await expect(refusal).rejects.toThrow(
      "A Session in this project is still running, so nothing was removed. Stop it and try again.",
    );
    expect(steps).toEqual([]);
    expect(isProjectAttached(ctx.db, "p1")).toBe(true);
    expect(listProjectSessionIds(ctx.db, "p1").toSorted()).toEqual(["s-board", "s-ticket"]);
  });

  it("refuses when a Session started while the others were being released", async () => {
    const { steps, ports } = recorder({
      releaseBindings: async () => {
        insertSession("s-late", "p1");
        insertSession("s-later", "p1");
        return { stillOpen: [] };
      },
    });

    const refusal = removeProject(ports, "p1");

    await expect(refusal).rejects.toThrow(
      "2 Sessions in this project are still running, so nothing was removed. Stop them and try again.",
    );
    await expect(refusal).rejects.toMatchObject({ stillOpen: ["s-late", "s-later"] });
    expect(steps).toEqual([]);
    expect(isProjectAttached(ctx.db, "p1")).toBe(true);
  });

  // VC-993: a project moving to Volli Cloud stays on the rail until its move settles.
  it("refuses a project a move froze, releasing nothing", async () => {
    freezeP1();
    const { steps, ports } = recorder();

    await expect(removeProject(ports, "p1")).rejects.toBeInstanceOf(ProjectFrozenError);

    expect(steps).toEqual([]);
    expect(isProjectAttached(ctx.db, "p1")).toBe(true);
  });

  // VC-1016: the release awaits, and an idle project is exactly what a move freezes.
  it("refuses, detaching nothing, when a move freezes the project during the release", async () => {
    const { steps, ports } = recorder({
      releaseBindings: async () => {
        freezeP1();
        return { stillOpen: [] };
      },
    });

    await expect(removeProject(ports, "p1")).rejects.toThrow("moving to Volli Cloud");

    expect(steps).toEqual([]);
    expect(isProjectAttached(ctx.db, "p1")).toBe(true);
    expect(removedAt("p1")).toBeNull();
  });

  it("removes a project on a host that keeps no MCP settings, stamped by the wall clock", async () => {
    const { steps, ports } = recorder({ mcp: null });
    const { now: _clock, ...unclocked } = ports;
    const before = Date.now();

    await removeProject(unclocked, "p1");

    expect(steps.map(({ step }) => step)).toEqual([
      "releaseBindings",
      "disposeShells",
      "killTerminals",
      "closeBrowserTabs",
      "disposeFeed",
      "announce",
    ]);
    expect(isProjectAttached(ctx.db, "p1")).toBe(false);
    expect(removedAt("p1")).toBeGreaterThanOrEqual(before);
  });

  it("does nothing for an id no project on the rail has", async () => {
    const { steps, ports } = recorder();

    await removeProject(ports, "missing");
    await removeProject(ports, "p1");
    steps.length = 0;
    // Removed already: there is nothing left to stop, and nothing to tell.
    await removeProject({ ...ports, now: () => 99 }, "p1");

    expect(steps).toEqual([]);
    expect(removedAt("p1")).toBe(42);
    expect(isProjectAttached(ctx.db, "p2")).toBe(true);
  });
});

function binding(sessionId: string, directory: string): OpenNativeBinding {
  return {
    sessionId,
    directory,
    attachmentId: `attachment-${sessionId}`,
    lastProgressAt: 0,
    inFlightTools: [],
  };
}

/** A runtime holding bindings with turns open; a release closes one unless it is stuck. */
function runtime(stuck: ReadonlySet<string> = new Set()) {
  const bound = new Map([
    // A ticket worktree need not sit under the project folder: the Session
    // id, not the directory, is what selects it.
    ["s-board", binding("s-board", "/repo/one")],
    ["s-ticket", binding("s-ticket", "/elsewhere/worktrees/VC-1")],
    ["s-other", binding("s-other", "/repo/two")],
  ]);
  const released: { sessionId: string; origin: unknown }[] = [];
  const port: AgentSiteRuntime = {
    openNativeBindings: () => [...bound.values()],
    projection: async () => ({ projection: { turnActive: true } }),
    command: async (request) => {
      if (request.sessionId === "s-throws") throw new Error("executor would not stop");
      released.push({ sessionId: request.sessionId, origin: request.origin });
      if (!stuck.has(request.sessionId)) bound.delete(request.sessionId);
      return {};
    },
  };
  return { port, bound, released };
}

function sources(overrides: Partial<ProjectLiveWorkSources> = {}) {
  const calls: string[] = [];
  const closedTabs: string[] = [];
  const errors: string[] = [];
  const built: ProjectLiveWorkSources = {
    runtime: () => null,
    shells: { disposeSession: (sessionId) => calls.push(`shell:${sessionId}`) },
    terminals: () => ({
      killSessions: (ids) => calls.push(`terminals:${[...ids].join(",")}`),
    }),
    browser: {
      list: ({ projectId }) =>
        projectId === "p1" ? [{ tabId: "tab-person" }, { tabId: "tab-agent" }] : [],
      close: (tabId) => closedTabs.push(tabId),
    },
    mcp: {
      disconnectProject: (projectId) => {
        calls.push(`mcp.disconnect:${projectId}`);
        return ["server-1"];
      },
      forgetRemovedServers: (ids) => calls.push(`mcp.forget:${ids.join(",")}`),
    },
    newCommandId: () => "command-1",
    onReleaseError: (sessionId) => errors.push(sessionId),
    ...overrides,
  };
  return { built, calls, closedTabs, errors };
}

describe("hostProjectLiveWork", () => {
  it("releases only the named Sessions' bindings, wherever they are rooted, as the person's act", async () => {
    const held = runtime();
    const { built } = sources({ runtime: () => held.port });

    const report = await hostProjectLiveWork(built).releaseBindings(
      new Set(["s-board", "s-ticket"]),
    );

    expect(report.stillOpen).toEqual([]);
    expect(held.released).toEqual([
      { sessionId: "s-board", origin: { kind: "user" } },
      { sessionId: "s-ticket", origin: { kind: "user" } },
    ]);
    expect([...held.bound.keys()]).toEqual(["s-other"]);
  });

  it("reports a binding that stayed open, and one whose release threw", async () => {
    const held = runtime(new Set(["s-ticket"]));
    held.bound.set("s-throws", binding("s-throws", "/repo/one"));
    const { built, errors } = sources({ runtime: () => held.port });

    const report = await hostProjectLiveWork(built).releaseBindings(
      new Set(["s-board", "s-ticket", "s-throws"]),
    );

    expect(report.stillOpen.toSorted()).toEqual(["s-throws", "s-ticket"]);
    expect(errors).toEqual(["s-throws"]);
  });

  it("has nothing to release on a launch without a runtime", async () => {
    const { built } = sources();
    expect(await hostProjectLiveWork(built).releaseBindings(new Set(["s-board"]))).toEqual({
      stillOpen: [],
    });
  });

  it("ends each Session's shells and terminals, the project's tabs, and its MCP sign-ins", () => {
    const { built, calls, closedTabs } = sources();
    const live = hostProjectLiveWork(built);

    live.disposeShells(new Set(["s-board", "s-ticket"]));
    live.killTerminals(new Set(["s-board", "s-ticket"]));
    live.closeBrowserTabs("p1");
    expect(live.mcp?.disconnect("p1")).toEqual(["server-1"]);
    live.mcp?.forget(["server-1"]);

    expect(calls).toEqual([
      "shell:s-board",
      "shell:s-ticket",
      "terminals:s-board,s-ticket",
      "mcp.disconnect:p1",
      "mcp.forget:server-1",
    ]);
    expect(closedTabs).toEqual(["tab-person", "tab-agent"]);
  });

  it("skips what this host does not hold: no terminals yet, no browser, no MCP settings", () => {
    const { built, calls } = sources({ terminals: () => null, browser: null, mcp: null });
    const live = hostProjectLiveWork(built);

    live.killTerminals(new Set(["s-board"]));
    live.closeBrowserTabs("p1");

    expect(live.mcp).toBeNull();
    expect(calls).toEqual([]);
  });

  // The acceptance case end to end: a turn open in a ticket worktree outside
  // the project folder, removed through the host's own live work.
  it("leaves no open binding, shell or terminal for a removed project's Sessions", async () => {
    const held = runtime();
    const { built, calls } = sources({ runtime: () => held.port });
    const disposed: string[] = [];

    await removeProject(
      {
        db: ctx.db,
        live: hostProjectLiveWork(built),
        disposeFeed: (projectId) => disposed.push(projectId),
        announce: () => undefined,
      },
      "p1",
    );

    expect([...held.bound.keys()]).toEqual(["s-other"]);
    expect(calls).toEqual([
      "shell:s-board",
      "shell:s-ticket",
      "terminals:s-board,s-ticket",
      "mcp.disconnect:p1",
      "mcp.forget:server-1",
    ]);
    expect(disposed).toEqual(["p1"]);
    expect(isProjectAttached(ctx.db, "p1")).toBe(false);
    expect(listProjectSessionIds(ctx.db, "p1")).toEqual(["s-board", "s-ticket"]);
  });
});
