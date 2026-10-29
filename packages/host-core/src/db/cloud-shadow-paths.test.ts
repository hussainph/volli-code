import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { openVolliDb } from "./index";
import { cloudShadowPath, normalizeCloudShadowPaths } from "./cloud-shadow-paths";
import { localMachinePaths } from "../machine-paths";
import { findProjectByPath, insertProject } from "./projects-repo";
import { createProject } from "../project-create";
import { createRunnerPathRegistry } from "../cloud-store/paths";
import { openTestDb, testProject, type TestDb } from "./test-helpers";

let fixture: TestDb;
afterEach(() => fixture?.cleanup());

it("does not invent runner tables for a pre-registry compatibility reader", () => {
  fixture = openTestDb();
  const { db } = fixture;
  db.exec("DROP TABLE cloud_shadow_rows");
  insertProject(db, testProject({ id: "legacy", path: "/legacy/folder" }));
  const schema = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
  const rows = db.prepare("SELECT * FROM projects").all();
  normalizeCloudShadowPaths(db);
  expect(localMachinePaths(db).projectPath("legacy")).toBe("/legacy/folder");
  expect(db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
  expect(db.prepare("SELECT * FROM projects").all()).toEqual(rows);
});

it("repairs every account's canary shadows on a local-first open, before Add Project can return a hidden identity", async () => {
  fixture = openTestDb();
  const { db, dbPath } = fixture;
  const home = dirname(dbPath);
  const frozen = testProject({ id: "local", path: join(home, "local") });
  insertProject(db, frozen);
  const registry = createRunnerPathRegistry(db, { runnerId: "runner" });
  for (const owner of ["a", "b"]) {
    const path = join(home, owner);
    mkdirSync(path);
    insertProject(db, testProject({ id: owner, path }));
    db.prepare("INSERT INTO cloud_shadow_rows VALUES ('project', ?, ?)").run(owner, owner);
    registry.checkouts.register({ projectId: owner, projectRepoId: owner, absPath: path });
  }
  const checkouts = db.prepare("SELECT * FROM project_checkout_paths ORDER BY project_id").all();
  const local = db.prepare("SELECT * FROM projects WHERE id='local'").get();
  const version = db.pragma("user_version", { simple: true });
  db.close();
  // Staging and verification are not launches: a recovery candidate keeps
  // its identity fields until the installed profile is actually opened.
  const candidate = openVolliDb(dbPath, { normalizeCloudShadows: false });
  try {
    for (const owner of ["a", "b"])
      expect(candidate.prepare("SELECT path FROM projects WHERE id=?").get(owner)).toEqual({
        path: join(home, owner),
      });
  } finally {
    candidate.close();
  }
  // No Cloud store, account restore, or schema bump: just the production open.
  const reopened = openVolliDb(dbPath);
  try {
    for (const owner of ["a", "b"]) {
      expect(reopened.prepare("SELECT path FROM projects WHERE id=?").get(owner)).toEqual({
        path: cloudShadowPath(reopened, owner, owner),
      });
      expect(findProjectByPath(reopened, join(home, owner))).toBeUndefined();
      const created = await createProject(
        { db: reopened, detectBaseBranch: async () => null, newId: () => `new-${owner}` },
        { name: `Local ${owner}`, path: join(home, owner) },
      );
      expect(created).toMatchObject({ ok: true, created: true, project: { id: `new-${owner}` } });
    }
    expect(reopened.prepare("SELECT * FROM projects WHERE id='local'").get()).toEqual(local);
    expect(
      reopened.prepare("SELECT * FROM project_checkout_paths ORDER BY project_id").all(),
    ).toEqual(checkouts);
    expect(reopened.pragma("user_version", { simple: true })).toBe(version);
  } finally {
    reopened.close();
  }
});
