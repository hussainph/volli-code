import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { createRunnerPathRegistry, RunnerPathCollision } from "./paths";

let ctx: TestDb;
let root: string;
beforeEach(() => {
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "volli-cloud-paths-"));
});
afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe("runner-local paths", () => {
  it("adopts frozen pointers verbatim without changing the board or event log", () => {
    const project = testProject({ id: "project", path: join(root, "checkout") });
    insertProject(ctx.db, project);
    insertTicket(
      ctx.db,
      testTicket(project.id, { id: "ticket", worktreePath: join(root, "copy") }),
    );
    const before = {
      project: ctx.db.prepare("SELECT * FROM projects").all(),
      ticket: ctx.db.prepare("SELECT * FROM tickets").all(),
      events: ctx.db.prepare("SELECT * FROM ticket_events").all(),
    };
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner-a" });
    expect(registry.checkouts.pathOf("project", "repo")).toBe(project.path);
    expect(registry.workingCopies.pathOf("ticket", "repo")).toBe(join(root, "copy"));
    expect(registry.checkouts.get("project", "repo")?.adoptedFromFrozen).toBe(true);
    expect(registry.workingCopies.get("ticket", "repo")?.adoptedFromFrozen).toBe(true);
    expect({
      project: ctx.db.prepare("SELECT * FROM projects").all(),
      ticket: ctx.db.prepare("SELECT * FROM tickets").all(),
      events: ctx.db.prepare("SELECT * FROM ticket_events").all(),
    }).toEqual(before);
    // Registry wins after adoption, even if an old local build changes its row.
    ctx.db
      .prepare("UPDATE projects SET path = ? WHERE id = 'project'")
      .run(join(root, "elsewhere"));
    expect(registry.checkouts.pathOf("project", "repo")).toBe(project.path);
  });

  it("stores cloud-only paths without a project or ticket FK and survives reconstruction", () => {
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner-a" });
    expect(registry.checkouts.pathOf("cloud-project", "repo")).toBeNull();
    expect(registry.workingCopies.pathOf("cloud-ticket", "repo")).toBeNull();
    registry.checkouts.register({
      projectId: "cloud-project",
      projectRepoId: "repo",
      absPath: join(root, "main"),
    });
    registry.workingCopies.register({
      ticketId: "cloud-ticket",
      projectRepoId: "repo",
      absPath: join(root, "copy"),
    });
    registry.workingCopies.register({
      ticketId: "cloud-ticket",
      projectRepoId: "repo",
      absPath: join(root, "copy"),
      workingCopyId: "copy-id",
    });
    const reopened = createRunnerPathRegistry(ctx.db, { runnerId: "runner-a" });
    expect(reopened.workingCopies.list()).toMatchObject([
      { workingCopyId: "copy-id", adoptedFromFrozen: false },
    ]);
    expect(reopened.workingCopies.pathOf("cloud-ticket", "repo")).toBe(join(root, "copy"));
    expect(ctx.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("scopes by runner and repository and refuses cross-runner canonical directory overlaps", () => {
    mkdirSync(join(root, "main"));
    symlinkSync(join(root, "main"), join(root, "alias"));
    const a = createRunnerPathRegistry(ctx.db, { runnerId: "runner-a" });
    const b = createRunnerPathRegistry(ctx.db, { runnerId: "runner-b" });
    a.checkouts.register({
      projectId: "project",
      projectRepoId: "repo",
      absPath: join(root, "main"),
    });
    for (const path of [
      join(root, "main"),
      join(root, "alias"),
      join(root, "alias", "child"),
      root,
    ]) {
      expect(() =>
        b.checkouts.register({ projectId: "project", projectRepoId: "repo", absPath: path }),
      ).toThrow(RunnerPathCollision);
      expect(() =>
        b.workingCopies.register({ ticketId: "ticket", projectRepoId: "repo", absPath: path }),
      ).toThrow(RunnerPathCollision);
    }
    b.checkouts.register({
      projectId: "project",
      projectRepoId: "repo",
      absPath: join(root, "other-main"),
    });
    a.workingCopies.register({
      ticketId: "ticket",
      projectRepoId: "repo",
      absPath: join(root, "a-copy"),
    });
    a.workingCopies.register({
      ticketId: "ticket",
      projectRepoId: "repo-2",
      absPath: join(root, "a-copy-2"),
    });
    b.workingCopies.register({
      ticketId: "ticket",
      projectRepoId: "repo",
      absPath: join(root, "b-copy"),
    });
    expect(a.workingCopies.list()).toHaveLength(2);
    expect(b.workingCopies.list()).toHaveLength(1);
    expect(() => a.checkouts.get("wrong-project", "repo")).toThrow("another project");
  });

  it("never adopts cloud shadow pointers or nonabsolute legacy data", () => {
    insertProject(ctx.db, testProject({ id: "shadow", path: join(root, "shadow") }));
    insertTicket(
      ctx.db,
      testTicket("shadow", { id: "shadow-ticket", worktreePath: join(root, "shadow-copy") }),
    );
    ctx.db.prepare("INSERT INTO cloud_shadow_rows VALUES ('project', 'shadow', 'owner')").run();
    ctx.db
      .prepare("INSERT INTO cloud_shadow_rows VALUES ('ticket', 'shadow-ticket', 'owner')")
      .run();
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner" });
    expect(registry.checkouts.pathOf("shadow", "repo")).toBeNull();
    expect(registry.workingCopies.pathOf("shadow-ticket", "repo")).toBeNull();
    expect(() =>
      registry.checkouts.register({ projectId: "p", projectRepoId: "r", absPath: "relative" }),
    ).toThrow("absolute");
  });

  it("names a project's checkout read-only: this runner's registration, else an adoptable frozen folder", () => {
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner-a" });
    const other = createRunnerPathRegistry(ctx.db, { runnerId: "runner-b" });
    expect(registry.checkouts.ofProject("project")).toBeNull();
    insertProject(ctx.db, testProject({ id: "project", path: join(root, "frozen") }));
    const before = ctx.db.prepare("SELECT * FROM projects").all();
    expect(registry.checkouts.ofProject("project")).toEqual({
      absPath: join(root, "frozen"),
      adoptable: true,
    });
    // Naming is not adopting: nothing is registered, and the frozen row is untouched.
    expect(registry.checkouts.get("project", "repo-b")).toBeNull();
    expect(ctx.db.prepare("SELECT * FROM projects").all()).toEqual(before);
    other.checkouts.register({
      projectId: "project",
      projectRepoId: "repo-a",
      absPath: join(root, "other-runner"),
    });
    registry.checkouts.register({
      projectId: "project",
      projectRepoId: "repo-b",
      absPath: join(root, "second"),
    });
    registry.checkouts.register({
      projectId: "project",
      projectRepoId: "repo-a",
      absPath: join(root, "first"),
    });
    expect(registry.checkouts.ofProject("project")).toEqual({
      absPath: join(root, "first"),
      adoptable: false,
    });
    expect(other.checkouts.ofProject("project")?.absPath).toBe(join(root, "other-runner"));
  });

  it("never names a shadow row's or a nonabsolute legacy folder as a project's checkout", () => {
    insertProject(ctx.db, testProject({ id: "shadow", path: join(root, "shadow") }));
    ctx.db.prepare("INSERT INTO cloud_shadow_rows VALUES ('project', 'shadow', 'owner')").run();
    insertProject(ctx.db, testProject({ id: "legacy", path: "relative/legacy" }));
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner" });
    expect(registry.checkouts.ofProject("shadow")).toBeNull();
    expect(registry.checkouts.ofProject("legacy")).toBeNull();
  });

  it("retains a minted copy id and rejects replacing it or sharing another copy's path", () => {
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner" });
    registry.workingCopies.register({
      ticketId: "t",
      projectRepoId: "r",
      absPath: join(root, "copy"),
      workingCopyId: "copy",
    });
    registry.workingCopies.register({
      ticketId: "t",
      projectRepoId: "r",
      absPath: join(root, "copy"),
    });
    expect(registry.workingCopies.get("t", "r")?.workingCopyId).toBe("copy");
    expect(() =>
      registry.workingCopies.register({
        ticketId: "t",
        projectRepoId: "r",
        absPath: join(root, "copy"),
        workingCopyId: "different",
      }),
    ).toThrow("another identity");
    expect(() =>
      registry.workingCopies.register({
        ticketId: "t2",
        projectRepoId: "r",
        absPath: join(root, "copy"),
      }),
    ).toThrow(RunnerPathCollision);
  });

  it("shares main-checkout records only at their runner/repository checkout", () => {
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner" });
    const checkout = join(root, "main");
    mkdirSync(checkout);
    const alias = join(root, "main-alias");
    symlinkSync(checkout, alias);
    registry.checkouts.register({ projectId: "project", projectRepoId: "repo", absPath: checkout });
    registry.workingCopies.register({
      ticketId: "main-1",
      projectRepoId: "repo",
      absPath: checkout,
      kind: "main_checkout",
      workingCopyId: "main-copy-1",
    });
    registry.workingCopies.register({
      ticketId: "main-2",
      projectRepoId: "repo",
      absPath: alias,
      kind: "main_checkout",
      workingCopyId: "main-copy-2",
    });
    // Metadata updates without a kind retain the existing machine kind.
    registry.workingCopies.register({
      ticketId: "main-1",
      projectRepoId: "repo",
      absPath: checkout,
      headSha: "head",
    });
    expect(registry.checkouts.pathOf("project", "repo")).toBe(checkout);
    expect(registry.workingCopies.pathOf("main-2", "repo")).toBe(alias);
    expect(registry.workingCopies.list()).toMatchObject([
      { ticketId: "main-1", kind: "main_checkout", headSha: "head" },
      { ticketId: "main-2", kind: "main_checkout" },
    ]);
    expect(() =>
      registry.checkouts.register({
        projectId: "project",
        projectRepoId: "repo",
        absPath: checkout,
      }),
    ).not.toThrow();
    expect(() =>
      registry.workingCopies.register({
        ticketId: "worktree",
        projectRepoId: "repo",
        absPath: checkout,
      }),
    ).toThrow(RunnerPathCollision);
    expect(() =>
      registry.workingCopies.register({
        ticketId: "main-3",
        projectRepoId: "repo",
        absPath: join(root, "elsewhere"),
        kind: "main_checkout",
      }),
    ).toThrow(RunnerPathCollision);
    expect(() =>
      registry.workingCopies.register({
        ticketId: "foreign-repo",
        projectRepoId: "another-repo",
        absPath: checkout,
        kind: "main_checkout",
      }),
    ).toThrow("Register this repository's checkout");
    registry.checkouts.register({
      projectId: "project",
      projectRepoId: "another-repo",
      absPath: join(root, "other-main"),
    });
    expect(() =>
      registry.workingCopies.register({
        ticketId: "foreign-repo",
        projectRepoId: "another-repo",
        absPath: checkout,
        kind: "main_checkout",
      }),
    ).toThrow(RunnerPathCollision);
    const another = createRunnerPathRegistry(ctx.db, { runnerId: "another-runner" });
    expect(() =>
      another.checkouts.register({ projectId: "project", projectRepoId: "repo", absPath: alias }),
    ).toThrow(RunnerPathCollision);
    expect(() =>
      another.checkouts.register({
        projectId: "project",
        projectRepoId: "repo",
        absPath: join(checkout, "child"),
      }),
    ).toThrow(RunnerPathCollision);
  });

  it("refuses checkout remapping while existing main copies would be stranded", () => {
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner" });
    const checkout = join(root, "main");
    registry.checkouts.register({ projectId: "project", projectRepoId: "repo", absPath: checkout });
    registry.workingCopies.register({
      ticketId: "main",
      projectRepoId: "repo",
      absPath: checkout,
      kind: "main_checkout",
    });
    const before = registry.workingCopies.list();
    expect(() =>
      registry.checkouts.register({
        projectId: "project",
        projectRepoId: "repo",
        absPath: join(root, "replacement"),
      }),
    ).toThrow("cannot be remapped");
    expect(registry.checkouts.get("project", "repo")?.absPath).toBe(checkout);
    expect(registry.workingCopies.list()).toEqual(before);
  });

  it("adopts frozen main-checkout tickets from the project checkout, never their stale worktree stamps", () => {
    const project = testProject({ id: "frozen-project", path: join(root, "main") });
    insertProject(ctx.db, project);
    insertTicket(
      ctx.db,
      testTicket(project.id, {
        id: "main-1",
        usesWorktree: false,
        worktreePath: join(root, "stale-copy"),
      }),
    );
    insertTicket(ctx.db, testTicket(project.id, { id: "main-2", usesWorktree: false }));
    const before = {
      project: ctx.db.prepare("SELECT * FROM projects").all(),
      tickets: ctx.db.prepare("SELECT * FROM tickets").all(),
      events: ctx.db.prepare("SELECT * FROM ticket_events").all(),
    };
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner" });
    // A working-copy lookup also adopts the matching frozen project checkout.
    expect(registry.workingCopies.pathOf("main-1", "repo")).toBe(project.path);
    expect(registry.workingCopies.pathOf("main-2", "repo")).toBe(project.path);
    expect(registry.checkouts.get(project.id, "repo")).toMatchObject({
      absPath: project.path,
      adoptedFromFrozen: true,
    });
    expect(registry.workingCopies.list()).toMatchObject([
      { ticketId: "main-1", kind: "main_checkout", adoptedFromFrozen: true },
      { ticketId: "main-2", kind: "main_checkout", adoptedFromFrozen: true },
    ]);
    expect({
      project: ctx.db.prepare("SELECT * FROM projects").all(),
      tickets: ctx.db.prepare("SELECT * FROM tickets").all(),
      events: ctx.db.prepare("SELECT * FROM ticket_events").all(),
    }).toEqual(before);
  });

  it("refuses nested worktree identities before housekeeping can endanger kept uncommitted work", () => {
    const checkout = join(root, "main");
    const outer = join(root, "outer");
    const nested = join(outer, "ignored", "nested");
    mkdirSync(checkout);
    const git = (args: readonly string[], cwd?: string) =>
      execFileSync("git", args, {
        cwd: cwd ?? checkout,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Volli Test",
          GIT_AUTHOR_EMAIL: "test@volli.local",
          GIT_COMMITTER_NAME: "Volli Test",
          GIT_COMMITTER_EMAIL: "test@volli.local",
        },
      });
    git(["init", "-b", "main"]);
    writeFileSync(join(checkout, ".gitignore"), "ignored/\n.env\n");
    git(["add", ".gitignore"]);
    git(["commit", "-m", "initial"]);
    git(["worktree", "add", "-b", "outer", outer, "main"]);
    git(["worktree", "add", "-b", "nested", nested, "main"]);
    writeFileSync(join(nested, "uncommitted.txt"), "precious work\n");
    writeFileSync(join(nested, ".env"), "LOCAL_SECRET=kept\n");
    expect(git(["status", "--porcelain"], nested)).toContain("?? uncommitted.txt");
    expect(git(["check-ignore", "ignored/nested/"], outer).trim()).toBe("ignored/nested/");
    insertProject(ctx.db, testProject({ id: "project", path: checkout }));
    insertTicket(ctx.db, testTicket("project", { id: "nested", worktreePath: nested }));
    ctx.db.prepare("UPDATE tickets SET retention_keep = 1 WHERE id = 'nested'").run();
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner" });
    registry.checkouts.register({ projectId: "project", projectRepoId: "repo", absPath: checkout });
    registry.workingCopies.register({ ticketId: "nested", projectRepoId: "repo", absPath: nested });
    // Even this same runner/repo cannot claim an ancestor that could delete the
    // nested checkout's ignored files or bypass that ticket's Keep pin.
    expect(() =>
      registry.workingCopies.register({ ticketId: "outer", projectRepoId: "repo", absPath: outer }),
    ).toThrow(RunnerPathCollision);
    expect(registry.workingCopies.get("outer", "repo")).toBeNull();
    expect(registry.workingCopies.get("nested", "repo")?.kind).toBe("worktree");
    expect(ctx.db.prepare("SELECT retention_keep FROM tickets WHERE id = 'nested'").get()).toEqual({
      retention_keep: 1,
    });
    expect(readFileSync(join(nested, "uncommitted.txt"), "utf8")).toBe("precious work\n");
    expect(existsSync(join(nested, ".env"))).toBe(true);
    expect(() =>
      registry.workingCopies.register({
        ticketId: "descendant",
        projectRepoId: "repo",
        absPath: join(nested, "ignored-child"),
      }),
    ).toThrow(RunnerPathCollision);
    // A different repo on the same runner has no overlapping-path exception.
    expect(() =>
      registry.workingCopies.register({
        ticketId: "outer",
        projectRepoId: "other-repo",
        absPath: outer,
      }),
    ).toThrow(RunnerPathCollision);
  });

  it("allows a checkout to contain its worktree but never the reverse or two nested worktrees", () => {
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner" });
    const checkout = join(root, "checkout");
    const worktree = join(checkout, "ignored", "worktree");
    registry.checkouts.register({ projectId: "project", projectRepoId: "repo", absPath: checkout });
    registry.workingCopies.register({
      ticketId: "main",
      projectRepoId: "repo",
      absPath: checkout,
      kind: "main_checkout",
    });
    expect(() =>
      registry.workingCopies.register({
        ticketId: "worktree",
        projectRepoId: "repo",
        absPath: worktree,
      }),
    ).not.toThrow();
    expect(registry.checkouts.pathOf("project", "repo")).toBe(checkout);
    expect(() =>
      registry.workingCopies.register({
        ticketId: "other",
        projectRepoId: "repo",
        absPath: join(worktree, "child"),
      }),
    ).toThrow(RunnerPathCollision);
    expect(() =>
      registry.workingCopies.register({
        ticketId: "ancestor",
        projectRepoId: "repo",
        absPath: root,
      }),
    ).toThrow(RunnerPathCollision);
    expect(() =>
      registry.checkouts.register({
        projectId: "other-project",
        projectRepoId: "other-repo",
        absPath: join(worktree, "checkout"),
      }),
    ).toThrow(RunnerPathCollision);
  });
});
