import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { cloudShadowPath } from "../db/cloud-shadow-paths";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { createMachinePaths } from "../machine-paths";
import { McpSettingsService } from "../mcp/settings";
import {
  buildFileIndex,
  readFile,
  resolveFileScope,
  resolveProjectPath,
  searchRoot,
} from "../volli-fs";
import { readWorkingCopy } from "../worktree/working-copy";
import {
  resolveWorktreeTarget,
  readWorktreeDiff,
  readWorktreeChangeSet,
  readWorktreeStatus,
} from "../worktree/read";
import { createRunnerPathRegistry } from "./paths";
import { cloudMachinePaths } from "./machine-paths";

let opened: TestDb;
afterEach(() => opened?.cleanup());
function fixture() {
  opened = openTestDb();
  const { db } = opened;
  const home = dirname(db.name);
  const checkout = join(home, "checkout");
  const worktree = join(home, "worktree");
  const placeholder = cloudShadowPath(db, "owner", "project");
  for (const folder of [checkout, worktree, placeholder]) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "identity.txt"), folder === placeholder ? "SHADOW" : folder);
  }
  insertProject(db, testProject({ id: "project", path: placeholder }));
  db.prepare("INSERT INTO cloud_shadow_rows VALUES ('project', 'project', 'owner')").run();
  // These stale shadow fields deliberately disagree with the registry stamp.
  insertTicket(
    db,
    testTicket("project", { id: "ticket", usesWorktree: false, worktreePath: placeholder }),
  );
  db.prepare("INSERT INTO cloud_shadow_rows VALUES ('ticket', 'ticket', 'owner')").run();
  const registry = createRunnerPathRegistry(db, { runnerId: "runner" });
  registry.checkouts.register({ projectId: "project", projectRepoId: "repo", absPath: checkout });
  const paths = createMachinePaths(db);
  paths.bindCloud(
    cloudMachinePaths({ registry: () => registry, ticketDisplayIdOf: () => "VC-42" }),
  );
  const stamp = (kind: "main_checkout" | "worktree" = "worktree") =>
    registry.workingCopies.register({
      ticketId: "ticket",
      projectRepoId: "repo",
      absPath: kind === "worktree" ? worktree : checkout,
      kind,
      branch: "volli/VC-42-stamped",
      baseBranch: "main",
    });
  const git = vi.fn(async (_args: readonly string[], cwd: string) => {
    expect([checkout, worktree]).toContain(cwd);
    return "";
  });
  return { db, checkout, worktree, placeholder, paths, registry, stamp, git };
}

const server = {
  id: "mcp",
  name: "Fixture",
  enabled: true,
  transport: { type: "stdio", command: "node", args: ["server.mjs"] },
};

describe("Cloud machine readers never use shadow folders", () => {
  it("keeps standalone signed-out defaults closed to shadows and refuses a non-Cloud bind", async () => {
    const f = fixture();
    const local = createMachinePaths(f.db);
    expect(local.projectPath("project")).toBeNull();
    expect(local.ticket("ticket")).toBeNull();
    expect(() => local.bindCloud(local)).toThrow("Cloud machine-path reader");
    expect((await resolveFileScope(f.db, "project", "ticket")).ok).toBe(false);
  });

  it("never promotes a registered Main copy into isolation using stale shadow fields", async () => {
    const f = fixture();
    f.stamp("main_checkout");
    f.db.prepare("UPDATE tickets SET uses_worktree=1 WHERE id='ticket'").run();
    expect(await resolveFileScope(f.db, "project", "ticket", f.paths)).toMatchObject({
      ok: true,
      value: { projectPath: f.checkout, worktreeRoot: null, usesWorktree: false },
    });
    expect(resolveWorktreeTarget({ db: f.db, machinePaths: f.paths }, "ticket")).toMatchObject({
      kind: "no-worktree",
      usesWorktree: false,
    });
  });
  it("resolves project Files, quick-open/@ indexes and ticket Files through the registry", async () => {
    const f = fixture();
    f.stamp();
    expect(resolveProjectPath(f.db, "project", f.paths)).toEqual({
      ok: true,
      projectPath: f.checkout,
    });
    for (const ticketId of [undefined, "ticket"]) {
      const scope = await resolveFileScope(f.db, "project", ticketId, f.paths);
      expect(scope.ok).toBe(true);
      if (!scope.ok) throw new Error(scope.error);
      const root = ticketId === undefined ? f.checkout : f.worktree;
      expect(searchRoot(scope.value)).toBe(root);
      expect(
        (await buildFileIndex(scope.value.projectPath, { worktreeRoot: scope.value.worktreeRoot }))
          .files,
      ).toContainEqual(expect.objectContaining({ relPath: "identity.txt" }));
      expect(
        await readFile(scope.value.projectPath, scope.value.worktreeRoot, "identity.txt"),
      ).toMatchObject({ ok: true, content: { text: root } });
    }
  });

  it("does not read Main for an unlocated or vanished isolated ticket, and rejects mismatched scopes", async () => {
    const f = fixture();
    expect(await resolveFileScope(f.db, "project", "ticket", f.paths)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Start or resume a Session"),
    });
    f.stamp();
    insertProject(f.db, testProject({ id: "other", path: join(f.checkout, "other") }));
    f.registry.checkouts.register({
      projectId: "other",
      projectRepoId: "other-repo",
      absPath: join(dirname(f.checkout), "other"),
    });
    mkdirSync(join(dirname(f.checkout), "other"));
    expect(await resolveFileScope(f.db, "other", "ticket", f.paths)).toMatchObject({
      ok: false,
      error: "Ticket does not belong to project",
    });
    rmSync(f.worktree, { recursive: true });
    expect(await resolveFileScope(f.db, "project", "ticket", f.paths)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Start or resume a Session"),
    });
  });

  it("uses the registered main checkout for MCP test/save/refresh and refuses missing folders before connecting", async () => {
    const f = fixture();
    const open = vi.fn(async (_server: unknown, cwd: string) => {
      expect(cwd).toBe(f.checkout);
      return {
        listTools: async () => [],
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
    });
    const mcp = new McpSettingsService({ db: f.db, machinePaths: f.paths, open });
    expect((await mcp.test({ projectId: "project", server })).ok).toBe(true);
    expect((await mcp.save({ projectId: "project", server, enabledTools: [] })).ok).toBe(true);
    expect((await mcp.refresh({ projectId: "project", serverId: "mcp" })).ok).toBe(true);
    expect(open).toHaveBeenCalledTimes(3);
    rmSync(f.checkout, { recursive: true });
    expect(await mcp.test({ projectId: "project", server })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Choose"),
    });
    expect(open).toHaveBeenCalledTimes(3);
  });

  it.each([null, "main_checkout", "worktree"] as const)(
    "measures %s from machine stamps, not shadow ticket/path fields",
    async (kind) => {
      const f = fixture();
      if (kind !== null) f.stamp(kind);
      const result = await readWorkingCopy(
        { db: f.db, machinePaths: f.paths, gitAsync: f.git },
        { projectId: "project", ticketId: kind === null ? null : "ticket" },
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          state: "measured",
          workingCopy: {
            path: kind === "worktree" ? f.worktree : f.checkout,
            kind: kind === "worktree" ? "worktree" : "main-checkout",
          },
        },
      });
      expect(f.git).toHaveBeenCalled();
    },
  );

  it("routes worktree status/diff/changes/watch resolution through the same registry copy", async () => {
    const f = fixture();
    f.stamp();
    const deps = { db: f.db, machinePaths: f.paths, gitAsync: f.git };
    expect(resolveWorktreeTarget(deps, "ticket")).toMatchObject({
      kind: "ok",
      target: { displayId: "VC-42", worktreePath: f.worktree, branch: "volli/VC-42-stamped" },
    });
    await readWorktreeStatus(deps, "ticket");
    await readWorktreeDiff(deps, "ticket", "working-tree");
    await readWorktreeChangeSet(deps, "ticket");
    expect(f.git).toHaveBeenCalled();
    rmSync(f.worktree, { recursive: true });
    expect(resolveWorktreeTarget(deps, "ticket")).toMatchObject({
      kind: "missing-on-disk",
      worktreePath: f.worktree,
    });
  });

  it("fails closed without this runner's checkout; another runner and real placeholder directory are not fallbacks", async () => {
    const f = fixture();
    const other = createRunnerPathRegistry(f.db, { runnerId: "other" });
    const paths = createMachinePaths(f.db);
    paths.bindCloud(cloudMachinePaths({ registry: () => other, ticketDisplayIdOf: () => null }));
    expect(resolveProjectPath(f.db, "project", paths)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Choose"),
    });
    expect(
      (
        await readWorkingCopy(
          { db: f.db, machinePaths: paths, gitAsync: f.git },
          { projectId: "project", ticketId: null },
        )
      ).ok,
    ).toBe(false);
    expect(f.git).not.toHaveBeenCalled();
  });
});
