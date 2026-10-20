/**
 * The one registration rule every door applies (VC-623): desktop's Add
 * Project and the operator's `volli project add` both run this.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  detachProject,
  findProjectByPath,
  insertProject,
  isProjectAttached,
  listProjects,
  listProjectSessionIds,
} from "./db/projects-repo";
import { insertTicket, listAllTickets } from "./db/tickets-repo";
import { openTestDb, testProject, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";

import { createProject, planProjectCreate } from "./project-create";

let ctx: TestDb;
let root: string;

beforeEach(() => {
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "project-create-"));
});

afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

function dir(name: string): string {
  const path = join(root, name);
  mkdirSync(path);
  return path;
}

describe("createProject", () => {
  it("announces only a committed new registration across both registration doors", async () => {
    const path = dir("announced");
    const onCreated = vi.fn((project) => {
      expect(findProjectByPath(ctx.db, path)?.id).toBe(project.id);
    });
    const ports = { db: ctx.db, detectBaseBranch: async () => "main", onCreated };
    await planProjectCreate(ports, { path, name: "Announced" }, { write: false });
    expect(onCreated).not.toHaveBeenCalled();
    await createProject(ports, { path, name: "Announced" });
    expect(onCreated).toHaveBeenCalledOnce();
    await createProject(ports, { path, name: "Announced" });
    await planProjectCreate(ports, { path, name: "Announced" }, { write: true });
    expect(onCreated).toHaveBeenCalledOnce();
  });
  it("creates a project with the detected base branch, colour and order", async () => {
    insertProject(ctx.db, testProject({ id: "p0", path: "/elsewhere", ticketPrefix: "EL" }));
    const path = dir("acme");

    const outcome = await createProject(
      { db: ctx.db, detectBaseBranch: async () => "trunk", now: () => 7, newId: () => "p1" },
      { path, name: "Acme Rockets" },
    );

    expect(outcome).toEqual({
      ok: true,
      created: true,
      project: {
        id: "p1",
        name: "Acme Rockets",
        path,
        ticketPrefix: "AR",
        baseBranch: "trunk",
        colorIndex: 1,
        sortOrder: 1,
        createdAt: 7,
        updatedAt: 7,
      },
    });
    expect(findProjectByPath(ctx.db, path)).toMatchObject({ id: "p1" });
  });

  it("answers with the project already tracked at the path", async () => {
    const path = dir("acme");
    insertProject(ctx.db, testProject({ id: "known", path, ticketPrefix: "KN" }));
    const detect = vi.fn(async () => "main");

    expect(
      await createProject({ db: ctx.db, detectBaseBranch: detect }, { path, name: "Acme" }),
    ).toMatchObject({ ok: true, created: false, project: { id: "known" } });
    expect(detect).not.toHaveBeenCalled();
  });

  it("answers with a project registered while the base branch was being detected", async () => {
    const path = dir("acme");
    const outcome = await createProject(
      {
        db: ctx.db,
        detectBaseBranch: async () => {
          insertProject(ctx.db, testProject({ id: "racer", path, ticketPrefix: "RA" }));
          return "main";
        },
      },
      { path, name: "Acme" },
    );

    expect(outcome).toMatchObject({ ok: true, created: false, project: { id: "racer" } });
    expect(listProjects(ctx.db)).toHaveLength(1);
  });

  it("refuses a missing path, a file, and a prefix another project holds", async () => {
    const file = join(root, "file");
    writeFileSync(file, "");
    insertProject(ctx.db, testProject({ id: "p0", name: "Acme", path: "/x", ticketPrefix: "AC" }));
    const ports = { db: ctx.db, detectBaseBranch: async () => null };

    expect(await createProject(ports, { path: join(root, "nope"), name: "N" })).toEqual({
      ok: false,
      error: "Project path does not exist",
    });
    expect(await createProject(ports, { path: file, name: "N" })).toEqual({
      ok: false,
      error: "Project path is not a directory",
    });
    expect(await createProject(ports, { path: dir("acme"), name: "Acme" })).toEqual({
      ok: false,
      error: 'Ticket prefix "AC" is already used by Acme.',
    });
  });

  it("defaults the clock, the id and the detector", async () => {
    const path = dir("plain");

    const outcome = await createProject({ db: ctx.db }, { path, name: "Plain" });

    // Not a git repository, so the real detector finds no branch.
    expect(outcome).toMatchObject({ ok: true, created: true, project: { baseBranch: null } });
    if (outcome.ok) expect(outcome.project.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("planProjectCreate", () => {
  it("judges without writing when asked for a preview", async () => {
    const path = dir("preview");

    expect(
      await planProjectCreate(
        { db: ctx.db, detectBaseBranch: async () => "main" },
        { path, name: "Preview" },
        { write: false },
      ),
    ).toMatchObject({ kind: "new", project: { path, ticketPrefix: "PR" } });
    expect(listProjects(ctx.db)).toEqual([]);
  });
});

/**
 * VC-822: removing a project detaches it, so adding its folder again finds the
 * same row and puts it back on the rail with everything it held.
 */
describe("re-adding a removed project's folder", () => {
  function removedProject(path: string): void {
    insertProject(
      ctx.db,
      testProject({ id: "old", name: "Old", path, ticketPrefix: "OL", baseBranch: "trunk" }),
    );
    insertTicket(ctx.db, testTicket("old", { id: "t1", ticketNumber: 4 }));
    ctx.db.prepare("UPDATE projects SET next_ticket_number = 5 WHERE id = 'old'").run();
    ctx.db
      .prepare(
        "INSERT INTO sessions (id, project_id, ticket_id, title, created_at) VALUES ('s1', 'old', 't1', 's1', 1)",
      )
      .run();
    insertProject(ctx.db, testProject({ id: "other", path: "/other", ticketPrefix: "OT" }));
    detachProject(ctx.db, "old", 3);
  }

  it("re-attaches the same project, its tickets, Sessions and counter included", async () => {
    const path = dir("old");
    removedProject(path);
    const detect = vi.fn(async () => "main");
    const onCreated = vi.fn();
    const ports = { db: ctx.db, detectBaseBranch: detect, now: () => 9, onCreated };

    const outcome = await createProject(ports, { path, name: "Renamed" });

    // The row it always was: its own id, name, prefix and base branch, at the
    // end of the rail. Nothing is detected again.
    expect(outcome).toMatchObject({
      ok: true,
      created: false,
      project: { id: "old", name: "Old", ticketPrefix: "OL", baseBranch: "trunk", updatedAt: 9 },
    });
    expect(listProjects(ctx.db).map(({ id }) => id)).toEqual(["other", "old"]);
    expect(detect).not.toHaveBeenCalled();
    expect(listAllTickets(ctx.db).map(({ id }) => id)).toEqual(["t1"]);
    expect(listProjectSessionIds(ctx.db, "old")).toEqual(["s1"]);
    expect(
      ctx.db.prepare("SELECT next_ticket_number, removed_at FROM projects WHERE id = 'old'").get(),
    ).toEqual({ next_ticket_number: 5, removed_at: null });
    // Announced once, as a registration: every window re-reads its board.
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "old" }));

    await createProject(ports, { path, name: "Renamed" });
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("previews the re-attach without writing it", async () => {
    const path = dir("old");
    removedProject(path);

    const plan = await planProjectCreate({ db: ctx.db }, { path, name: "Old" }, { write: false });

    expect(plan).toMatchObject({ kind: "reattached", project: { id: "old" } });
    expect(isProjectAttached(ctx.db, "old")).toBe(false);
    // A door that announces nothing still re-attaches it.
    expect(await createProject({ db: ctx.db }, { path, name: "Old" })).toMatchObject({
      ok: true,
      created: false,
    });
    expect(isProjectAttached(ctx.db, "old")).toBe(true);
  });

  it("re-attaches once when the folder is added twice at the same time", async () => {
    const path = dir("old");
    removedProject(path);
    const onCreated = vi.fn();
    const ports = { db: ctx.db, onCreated };

    const outcomes = await Promise.all([
      createProject(ports, { path, name: "Old" }),
      createProject(ports, { path, name: "Old" }),
    ]);

    expect(outcomes).toMatchObject([
      { ok: true, created: false, project: { id: "old" } },
      { ok: true, created: false, project: { id: "old" } },
    ]);
    expect(onCreated).toHaveBeenCalledOnce();
  });

  // Prefixes cannot be changed, so a new folder taking a removed project's
  // prefix would leave the old folder impossible to add again.
  it("refuses a new project the prefix a removed one keeps for its return", async () => {
    removedProject(dir("old"));

    expect(await createProject({ db: ctx.db }, { path: dir("olive"), name: "Old Lane" })).toEqual({
      ok: false,
      error: 'Ticket prefix "OL" is used by Old, which was removed. Add its folder again first.',
    });
    expect(listProjects(ctx.db).map(({ id }) => id)).toEqual(["other"]);
  });

  it("refuses while a project on the rail holds its ticket prefix, or its folder is gone", async () => {
    const path = dir("old");
    removedProject(path);
    // An older build, which does not see the removal, could add a project with
    // the prefix: two projects on the rail with one would make every display id
    // ambiguous.
    insertProject(
      ctx.db,
      testProject({ id: "new", name: "New", path: "/new", ticketPrefix: "OL" }),
    );

    expect(await createProject({ db: ctx.db }, { path, name: "Old" })).toEqual({
      ok: false,
      error: 'Ticket prefix "OL" is already used by New.',
    });
    rmSync(path, { recursive: true });
    expect(await createProject({ db: ctx.db }, { path, name: "Old" })).toEqual({
      ok: false,
      error: "Project path does not exist",
    });
    expect(isProjectAttached(ctx.db, "old")).toBe(false);
  });
});
