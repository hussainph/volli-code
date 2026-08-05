import { afterEach, describe, expect, it } from "vite-plus/test";
import type { NativeProbeResult } from "@volli/session-engine";

import { deleteProject, insertProject } from "./db/projects-repo";
import { openTestDb, testProject, type TestDb } from "./db/test-helpers";
import { createRuntimeCatalogHub } from "./runtime-catalog-hub";

const UNAVAILABLE: NativeProbeResult = {
  status: "unavailable",
  runtime: null,
  reason: "not installed",
};

let testDb: TestDb | null = null;

afterEach(() => {
  testDb?.cleanup();
  testDb = null;
});

function setup() {
  testDb = openTestDb();
  const directories: string[] = [];
  const hub = createRuntimeCatalogHub({
    db: testDb.db,
    adapters: [
      {
        id: "opencode",
        profileId: "native",
        discover: async (context) => {
          directories.push(context.directory);
          return UNAVAILABLE;
        },
      },
    ],
    fallbackDirectory: "/home/volli",
    now: () => 1_000,
  });
  return { db: testDb.db, hub, directories };
}

describe("createRuntimeCatalogHub", () => {
  it("resolves an undefined project id to the fallback directory", async () => {
    const { hub, directories } = setup();

    await hub().inspect({ adapterId: "opencode" });

    expect(directories).toEqual(["/home/volli"]);
  });

  it("resolves a known project id to that project's own path", async () => {
    const { db, hub, directories } = setup();
    insertProject(db, testProject({ id: "project-1", path: "/repo/project-1" }));

    await hub("project-1").inspect({ adapterId: "opencode" });

    expect(directories).toEqual(["/repo/project-1"]);
  });

  it("throws naming the project id when it is unknown, never falling back silently", () => {
    const { hub } = setup();

    expect(() => hub("missing-project")).toThrow(/missing-project/);
  });

  it("caches one catalog instance per resolved directory", () => {
    const { db, hub } = setup();
    insertProject(db, testProject({ id: "project-1", path: "/repo/project-1" }));

    expect(hub()).toBe(hub(undefined));
    expect(hub("project-1")).toBe(hub("project-1"));
  });

  // `projects.path` is UNIQUE (migrations.ts), so two project rows can never
  // literally share a path — the cache key is the resolved DIRECTORY, not the
  // caller's projectId, and a project whose path equals the fallback
  // directory is the one way to prove that without violating the schema.
  it("shares one catalog instance between two keys that resolve to the same directory", () => {
    const { db, hub } = setup();
    insertProject(db, testProject({ id: "project-1", path: "/home/volli" }));

    expect(hub("project-1")).toBe(hub());
  });

  // Nothing moves a project's `path` in place (the column is UNIQUE and no
  // repo function updates it), so a rename or re-add is a delete plus an
  // insert. The hub re-reads the row on every call instead of remembering
  // which directory an id once meant, which is what makes the unbounded cache
  // safe: the entry under the OLD directory becomes unreachable garbage rather
  // than a catalog still answering for the id that moved away from it.
  it("follows a re-added project to its new path, never serving the cached old directory", async () => {
    const { db, hub, directories } = setup();
    insertProject(db, testProject({ id: "project-1", path: "/repo/before" }));
    const before = hub("project-1");
    await before.inspect({ adapterId: "opencode" });

    deleteProject(db, "project-1");
    insertProject(db, testProject({ id: "project-1", path: "/repo/after" }));
    const after = hub("project-1");
    await after.inspect({ adapterId: "opencode" });

    expect(after).not.toBe(before);
    expect(directories).toEqual(["/repo/before", "/repo/after"]);
  });

  it("gives a project its own catalog instance, distinct from the fallback", () => {
    const { db, hub } = setup();
    insertProject(db, testProject({ id: "project-1", path: "/repo/project-1" }));

    expect(hub("project-1")).not.toBe(hub());
  });
});
