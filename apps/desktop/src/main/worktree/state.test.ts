import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { scriptedGit } from "./scripted-git";
import { listBranches } from "./state";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

describe("listBranches", () => {
  it("returns local branch short names", () => {
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git, calls } = scriptedGit(() => "main\nfeature/x\nvolli/VC-1-x\n");
    const result = listBranches({ db: ctx.db, git }, "proj-1");
    expect(result).toEqual({ ok: true, value: ["main", "feature/x", "volli/VC-1-x"] });
    expect(calls[0]?.args).toEqual(["for-each-ref", "refs/heads", "--format=%(refname:short)"]);
  });

  it("errors for an unknown project", () => {
    const { git } = scriptedGit(() => "");
    expect(listBranches({ db: ctx.db, git }, "nope")).toEqual({
      ok: false,
      error: "Unknown project",
    });
  });
});
