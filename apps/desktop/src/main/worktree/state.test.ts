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

/** A scripted git that answers each of `listBranches`' four reads by its verb. */
function branchGit(answers: {
  heads?: string;
  current?: string;
  remotes?: string;
  gitPath?: string;
}) {
  return scriptedGit((args) => {
    if (args[0] === "for-each-ref" && args[1] === "refs/heads") return answers.heads ?? "";
    if (args[0] === "for-each-ref" && args[1] === "refs/remotes") {
      if (answers.remotes === undefined) throw new Error("no remotes");
      return answers.remotes;
    }
    if (args[0] === "branch") {
      if (answers.current === undefined) throw new Error("detached");
      return answers.current;
    }
    if (args[0] === "rev-parse") {
      if (answers.gitPath === undefined) throw new Error("not a repo");
      return answers.gitPath;
    }
    throw new Error(`unscripted: ${args.join(" ")}`);
  });
}

const deps = (git: ReturnType<typeof scriptedGit>["git"]) => ({
  db: ctx.db,
  git,
  attachmentsRoot: "unused",
});

describe("listBranches", () => {
  it("reports local branches, the checkout's branch, remote-tracking refs and the fetch time", () => {
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git, calls } = branchGit({
      heads: "main\nfeature/x\nvolli/VC-1-x\n",
      current: "feature/x\n",
      remotes: "origin/HEAD\norigin/main\nupstream/main\n",
      gitPath: ".git/FETCH_HEAD\n",
    });

    const result = listBranches(deps(git), "proj-1", () => 1_700_000_000_000);

    expect(result).toEqual({
      ok: true,
      value: {
        branches: ["main", "feature/x", "volli/VC-1-x"],
        current: "feature/x",
        // origin/HEAD is dropped — it is an alias for a branch already listed.
        remotes: ["origin/main", "upstream/main"],
        fetchedAt: 1_700_000_000_000,
      },
    });
    expect(calls[0]?.args).toEqual([
      "for-each-ref",
      "refs/heads",
      "--sort=-committerdate",
      "--format=%(refname:short)",
    ]);
  });

  it("resolves FETCH_HEAD against the project path", () => {
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git } = branchGit({ heads: "main\n", gitPath: ".git/worktrees/x/FETCH_HEAD\n" });
    const seen: string[] = [];

    listBranches(deps(git), "proj-1", (path) => {
      seen.push(path);
      return 42;
    });

    expect(seen).toEqual(["/repo/.git/worktrees/x/FETCH_HEAD"]);
  });

  it("still lists branches for a detached, remote-less, never-fetched repo", () => {
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git } = branchGit({ heads: "main\n" });

    expect(listBranches(deps(git), "proj-1", () => null)).toEqual({
      ok: true,
      value: { branches: ["main"], current: null, remotes: [], fetchedAt: null },
    });
  });

  it("reports null fetchedAt when FETCH_HEAD does not exist", () => {
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git } = branchGit({ heads: "main\n", gitPath: ".git/FETCH_HEAD\n" });

    const result = listBranches(deps(git), "proj-1", () => null);

    expect(result).toEqual({
      ok: true,
      value: { branches: ["main"], current: null, remotes: [], fetchedAt: null },
    });
  });

  it("fails when the local branch read fails", () => {
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git } = scriptedGit(() => {
      throw new Error("not a git repository");
    });

    expect(listBranches(deps(git), "proj-1")).toEqual({
      ok: false,
      error: "not a git repository",
    });
  });

  it("errors for an unknown project", () => {
    const { git } = scriptedGit(() => "");
    expect(listBranches(deps(git), "nope")).toEqual({ ok: false, error: "Unknown project" });
  });
});
