/**
 * The one registration rule every door applies (VC-623): desktop's Add
 * Project and the operator's `volli project add` both run this.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { findProjectByPath, insertProject, listProjects } from "./db/projects-repo";
import { openTestDb, testProject } from "./db/test-helpers";
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
