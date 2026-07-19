import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket, updateTicketFields } from "../db/tickets-repo";
import { resetPhasesForTest, setPhase } from "./phase";
import { scriptedGit } from "./scripted-git";
import { getState, listBranches } from "./state";

let ctx: TestDb;
let tempDirs: string[] = [];

beforeEach(() => {
  ctx = openTestDb();
  resetPhasesForTest();
});

afterEach(() => {
  ctx.cleanup();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function seedTicket(worktreePath: string | null) {
  const project = testProject({ id: "proj-1", path: "/repo" });
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id, { id: "ticket-1", status: "doing" });
  insertTicket(ctx.db, ticket);
  if (worktreePath) {
    updateTicketFields(
      ctx.db,
      "ticket-1",
      { worktreePath, branch: "volli/VC-1-x", baseBranch: "main" },
      1,
    );
  }
  return project;
}

/** A git whose `worktree list` optionally registers `registeredPath`. */
function listGit(registeredPath?: string) {
  return scriptedGit((args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      const extra = registeredPath
        ? `worktree ${registeredPath}\nHEAD def\nbranch refs/heads/volli/VC-1-x\n`
        : "";
      return `worktree /repo\nHEAD abc\nbranch refs/heads/main\n${extra}`;
    }
    return "";
  });
}

describe("getState", () => {
  it("returns null identity + missing disk for an unknown ticket", async () => {
    const { git } = listGit();
    expect(await getState({ db: ctx.db, git }, "nope")).toEqual({
      identity: null,
      phase: null,
      disk: "missing",
    });
  });

  it("returns null identity when the ticket has no persisted worktree path", async () => {
    seedTicket(null);
    const { git } = listGit();
    const state = await getState({ db: ctx.db, git }, "ticket-1");
    expect(state.identity).toBeNull();
    expect(state.disk).toBe("missing");
  });

  it("reports present when the dir exists and git has it registered", async () => {
    const wt = tempDir("wt");
    seedTicket(wt);
    const { git } = listGit(wt);
    const state = await getState({ db: ctx.db, git }, "ticket-1");
    expect(state.identity).toEqual({
      worktreePath: wt,
      branch: "volli/VC-1-x",
      baseBranch: "main",
    });
    expect(state.disk).toBe("present");
  });

  it("reports unregistered when the dir exists but git doesn't know it", async () => {
    const wt = tempDir("wt");
    seedTicket(wt);
    const { git } = listGit(); // not registered
    expect((await getState({ db: ctx.db, git }, "ticket-1")).disk).toBe("unregistered");
  });

  it("reports missing when the persisted dir is gone", async () => {
    seedTicket("/vanished/worktree");
    const { git } = listGit("/vanished/worktree");
    expect((await getState({ db: ctx.db, git }, "ticket-1")).disk).toBe("missing");
  });

  it("surfaces the transient in-memory phase", async () => {
    seedTicket(null);
    setPhase("ticket-1", "creating");
    const { git } = listGit();
    expect((await getState({ db: ctx.db, git }, "ticket-1")).phase).toBe("creating");
  });
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
