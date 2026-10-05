import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import {
  isOwnedWorktreePath,
  ownedContainers,
  projectContainerName,
  projectContainerPath,
} from "./containers";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
});
afterEach(() => ctx.cleanup());

describe("projectContainerName", () => {
  it("is the repo dirname plus the first 8 chars of the project id", () => {
    expect(projectContainerName("/Users/me/code/volli-code", "f3732f45-40a9-4b54-a90f")).toBe(
      "volli-code-f3732f45",
    );
  });

  it("survives a trailing slash rather than naming the container '-<id>'", () => {
    expect(projectContainerName("/Users/me/code/volli-code/", "f3732f45-40a9")).toBe(
      "volli-code-f3732f45",
    );
  });

  // The whole reason VC-113 exists: the SAME repo tracked by two databases has
  // two project uuids, so it has two containers under one shared root.
  it("gives the same repo a different container per database", () => {
    const a = projectContainerName("/Users/me/code/volli-code", "f3732f45-prod");
    const b = projectContainerName("/Users/me/code/volli-code", "f8e04558-dev");
    expect(a).not.toBe(b);
  });
});

describe("ownedContainers", () => {
  it("names one container per tracked project", () => {
    insertProject(ctx.db, testProject({ id: "aaaaaaaa-1111", path: "/repos/alpha" }));
    insertProject(ctx.db, testProject({ id: "bbbbbbbb-2222", path: "/repos/beta" }));

    expect(ownedContainers(ctx.db, "/home/me")).toEqual([
      { projectId: "aaaaaaaa-1111", path: "/home/me/.volli/worktrees/alpha-aaaaaaaa" },
      { projectId: "bbbbbbbb-2222", path: "/home/me/.volli/worktrees/beta-bbbbbbbb" },
    ]);
  });
});

describe("isOwnedWorktreePath", () => {
  const home = "/home/me";
  const mine = { projectId: "p1", path: projectContainerPath(home, "/repos/alpha", "aaaaaaaa-1") };
  const containers = [mine];

  it("accepts a leaf inside a container this database owns", () => {
    expect(isOwnedWorktreePath(containers, join(mine.path, "VC-1-thing"))).toBe(true);
  });

  it("rejects the container itself — deleting it would take every checkout at once", () => {
    expect(isOwnedWorktreePath(containers, mine.path)).toBe(false);
  });

  it("rejects the shared worktree root", () => {
    expect(isOwnedWorktreePath(containers, join(home, ".volli", "worktrees"))).toBe(false);
  });

  // VC-113: same root, same repo, another install's uuid.
  it("rejects another install's container under the same root", () => {
    const theirs = projectContainerPath(home, "/repos/alpha", "f8e04558-dev");
    expect(isOwnedWorktreePath(containers, join(theirs, "VC-9-theirs"))).toBe(false);
  });

  it("rejects a sibling container whose name merely starts the same", () => {
    expect(isOwnedWorktreePath(containers, `${mine.path}-extra/VC-1`)).toBe(false);
  });

  it("rejects a path outside the worktree home entirely", () => {
    expect(isOwnedWorktreePath(containers, "/Users/me/Desktop/code/repo")).toBe(false);
  });
});
