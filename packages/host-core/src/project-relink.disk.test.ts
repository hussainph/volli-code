import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, type TestDb } from "./db/test-helpers";
import { inspectProjectFolder, relinkProject } from "./project-relink";

let ctx: TestDb;
let root: string;

beforeEach(() => {
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "volli-project-relink-disk-"));
});

afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

// The moved relink suite injects folder probes for its rules. These cases
// exercise the default disk probe and clock without desktop's IPC adapter,
// so their answers are protected in the Linux host gate too.
describe("project relinking on disk", () => {
  it("relinks with the default disk probe and clock", async () => {
    const oldPath = join(root, "old-project");
    const path = join(root, "new-project");
    mkdirSync(path);
    insertProject(ctx.db, testProject({ id: "p1", path: oldPath }));
    const before = Date.now();

    const result = await relinkProject({ db: ctx.db }, { projectId: "p1", path });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.project.path).toBe(path);
    expect(result.project.updatedAt).toBeGreaterThanOrEqual(before);
    expect(result.project.updatedAt).toBeLessThanOrEqual(Date.now());
    expect(result.aftermath.worktrees).toBe(0);
  });

  it("reports a directory at the registered path", async () => {
    const path = join(root, "project");
    mkdirSync(path);
    insertProject(ctx.db, testProject({ id: "p1", path }));

    await expect(inspectProjectFolder(ctx.db, "p1")).resolves.toEqual({
      ok: true,
      path,
      state: "present",
    });
  });

  it("reports a registered path that no longer exists", async () => {
    const path = join(root, "missing");
    insertProject(ctx.db, testProject({ id: "p1", path }));

    await expect(inspectProjectFolder(ctx.db, "p1")).resolves.toEqual({
      ok: true,
      path,
      state: "missing",
    });
  });

  it("distinguishes a file from a directory at the registered path", async () => {
    const path = join(root, "project.txt");
    writeFileSync(path, "not a directory");
    insertProject(ctx.db, testProject({ id: "p1", path }));

    await expect(inspectProjectFolder(ctx.db, "p1")).resolves.toEqual({
      ok: true,
      path,
      state: "not-a-directory",
    });
  });
});
