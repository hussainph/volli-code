import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { scriptedGit } from "./scripted-git";
import { listBranches } from "./state";
import type { StatMtimeMs } from "./types";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

/** A scripted git that answers each of `listBranches`' reads by its verb. */
function branchGit(answers: {
  heads?: string;
  current?: string;
  remotes?: string;
  gitPath?: string;
  packedRefsPath?: string;
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
    if (args[0] === "rev-parse" && args[2] === "FETCH_HEAD") {
      if (answers.gitPath === undefined) throw new Error("not a repo");
      return answers.gitPath;
    }
    if (args[0] === "rev-parse" && args[2] === "packed-refs") {
      if (answers.packedRefsPath === undefined) throw new Error("not a repo");
      return answers.packedRefsPath;
    }
    throw new Error(`unscripted: ${args.join(" ")}`);
  });
}

const deps = (git: ReturnType<typeof scriptedGit>["git"], statMtimeMs?: StatMtimeMs) => ({
  db: ctx.db,
  git,
  statMtimeMs,
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

    const result = listBranches(
      deps(git, () => 1_700_000_000_000),
      "proj-1",
    );

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

    listBranches(
      deps(git, (path) => {
        seen.push(path);
        return 42;
      }),
      "proj-1",
    );

    expect(seen).toEqual(["/repo/.git/worktrees/x/FETCH_HEAD"]);
  });

  it("still lists branches for a detached, remote-less, never-fetched repo", () => {
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git } = branchGit({ heads: "main\n" });

    expect(
      listBranches(
        deps(git, () => null),
        "proj-1",
      ),
    ).toEqual({
      ok: true,
      value: { branches: ["main"], current: null, remotes: [], fetchedAt: null },
    });
  });

  // The bug this fallback exists for: `git clone` writes no FETCH_HEAD, so a
  // repo whose remote refs are minutes old reported "never fetched" — the one
  // lie the field is there to prevent, told about the freshest repo there is.
  it("dates a fresh clone's remote refs from packed-refs when FETCH_HEAD does not exist", () => {
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git } = branchGit({
      heads: "main\n",
      remotes: "origin/main\n",
      gitPath: ".git/FETCH_HEAD\n",
      packedRefsPath: ".git/packed-refs\n",
    });
    const seen: string[] = [];

    const result = listBranches(
      deps(git, (path) => {
        seen.push(path);
        return path.endsWith("packed-refs") ? 1_700_000_000_000 : null;
      }),
      "proj-1",
    );

    expect(result).toEqual({
      ok: true,
      value: {
        branches: ["main"],
        current: null,
        remotes: ["origin/main"],
        fetchedAt: 1_700_000_000_000,
      },
    });
    expect(seen).toEqual(["/repo/.git/FETCH_HEAD", "/repo/.git/packed-refs"]);
  });

  it("does not fall back to packed-refs for a repo with no remote-tracking refs", () => {
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git } = branchGit({
      heads: "main\n",
      gitPath: ".git/FETCH_HEAD\n",
      packedRefsPath: ".git/packed-refs\n",
    });
    const seen: string[] = [];

    const result = listBranches(
      deps(git, (path) => {
        seen.push(path);
        return 1_700_000_000_000;
      }),
      "proj-1",
    );

    // FETCH_HEAD answered, so the fallback never ran; had it not, a local-only
    // repo would report a fetch age for refs it does not have.
    expect(result).toMatchObject({ ok: true, value: { remotes: [] } });
    expect(seen).toEqual(["/repo/.git/FETCH_HEAD"]);
  });

  it("reports null fetchedAt when neither FETCH_HEAD nor packed-refs exists", () => {
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git } = branchGit({
      heads: "main\n",
      remotes: "origin/main\n",
      gitPath: ".git/FETCH_HEAD\n",
      packedRefsPath: ".git/packed-refs\n",
    });

    const result = listBranches(
      deps(git, () => null),
      "proj-1",
    );

    expect(result).toEqual({
      ok: true,
      value: { branches: ["main"], current: null, remotes: ["origin/main"], fetchedAt: null },
    });
  });

  it("reports null fetchedAt when git cannot resolve the git dir at all", () => {
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git } = branchGit({ heads: "main\n", remotes: "origin/main\n" });

    expect(
      listBranches(
        deps(git, () => 1),
        "proj-1",
      ),
    ).toEqual({
      ok: true,
      value: { branches: ["main"], current: null, remotes: ["origin/main"], fetchedAt: null },
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
