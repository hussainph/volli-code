/**
 * "Choose the folder for <project> on this Mac" (VC-895 N2-3): the cloud
 * product store's checkout members over real SQLite and S2's real link, with
 * an in-memory connection standing in for Convex.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_RUNNER } from "@volli/shared";

import type { LiveHostCore } from "../index";
import { createBackendLink, type BackendConnection } from "../cloud-runner/backend-link";
import { createMutationGate } from "../cloud-runner/flow";
import type { RunnerPresence } from "../cloud-runner/presence";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createSessionWakeBus } from "../session-control/session-wake";
import { createTestSessionEngine } from "../testing/session-engine";
import { createCloudProductStore } from "./index";

const PROJECT = "00000000-0000-4000-8000-0000000000a1";
const REPO = "00000000-0000-4000-8000-0000000000a2";
const RUNNER = "00000000-0000-4000-8000-0000000000a3";
const OTHER_RUNNER = "00000000-0000-4000-8000-0000000000a4";

let opened: TestDb | undefined;
let root: string | undefined;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  opened?.cleanup();
  opened = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function fixture(runnerId: string | null = RUNNER) {
  opened = openTestDb();
  const { db } = opened;
  root = mkdtempSync(join(tmpdir(), "volli-cloud-checkout-"));
  const wake = createSessionWakeBus(createTestSessionEngine(db), { db });
  const host = {
    database: { ok: true, db },
    sessionEngine: wake.engine,
    sessionWakeBus: wake,
  } as LiveHostCore;
  const store = createCloudProductStore({
    host,
    ownerUserId: "owner-a",
    backendUrl: "https://example.convex.cloud",
    runnerId: () => runnerId,
    home: root,
    busySites: async () => [],
  });
  cleanups.push(() => store.dispose());
  return { db, home: root, store };
}

function connect(
  store: ReturnType<typeof fixture>["store"],
  answer: (args: Record<string, unknown>) => unknown,
  runnerId = RUNNER,
) {
  const mutations: { name: string; args: Record<string, unknown> }[] = [];
  const query = vi.fn(async (_name: string, args: Record<string, unknown>) => answer(args));
  const connection: BackendConnection = {
    query,
    async mutation(name, args) {
      mutations.push({ name, args });
      return null;
    },
    onUpdate: () => () => {},
    isConnected: () => true,
    onConnectionChange: () => () => {},
    close: async () => {},
  };
  const link = createBackendLink({
    connect: () => connection,
    token: async () => "test-token",
    gate: createMutationGate(),
  });
  const presence: RunnerPresence = {
    start: async () => {},
    stop: async () => {},
    setState: async () => {},
    beatNow: async () => {},
    refreshCapabilities: async () => {},
    connected: true,
    revoked: false,
  };
  const sync = store.connect({ link, runnerId, bootId: "boot", presence });
  cleanups.push(async () => {
    await sync.stop();
    await link.close();
  });
  return { query, mutations };
}

/** `runnerContext.forProject`'s answer: the owner, the project, its primary repository. */
const facts = (_args: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({
  ownerUserId: "owner-a",
  project: { id: PROJECT, name: "Cloud project", ticketPrefix: "VC" },
  primaryRepo: { id: REPO, projectId: PROJECT, baseBranch: "main" },
  ...patch,
});

describe("a cloud project's checkout on this Mac", () => {
  it("is unlocatable without a runner identity, missing until a folder is known", () => {
    const unregistered = fixture(null).store;
    expect(unregistered.checkouts.located(PROJECT)).toBeNull();
    expect(unregistered.projectPath(PROJECT)).toBeNull();
    const { store } = fixture();
    expect(store.checkouts.located(PROJECT)).toBe(false);
  });

  it("adopts a frozen local project's folder, and not a shadow row or a vanished one", () => {
    const { db, home, store } = fixture();
    const folder = join(home, "frozen");
    mkdirSync(folder);
    insertProject(db, testProject({ id: PROJECT, path: folder }));
    expect(store.checkouts.located(PROJECT)).toBe(true);
    db.prepare("INSERT INTO cloud_shadow_rows(kind,id,owner_user_id) VALUES ('project',?,?)").run(
      PROJECT,
      "owner-a",
    );
    expect(store.checkouts.located(PROJECT)).toBe(false);
    db.prepare("DELETE FROM cloud_shadow_rows").run();
    rmSync(folder, { recursive: true });
    expect(store.checkouts.located(PROJECT)).toBe(false);
  });

  it("projects registered paths to machine readers without exposing shadow placeholders", async () => {
    const { db, home, store } = fixture();
    await store.sessionBirth.beforeCreate({ projectId: PROJECT, ticketId: null });
    await store.engine.createSession({
      commandId: "birth",
      projectId: PROJECT,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: LOCAL_RUNNER },
    });
    expect(store.projectPath(PROJECT)).toBeNull();
    expect(store.agentCommands.projects()).toEqual([]);
    const absPath = join(home, "checkout");
    store.registry().checkouts.register({ projectId: PROJECT, projectRepoId: REPO, absPath });
    expect(store.projectPath(PROJECT)).toBe(absPath);
    expect(store.agentCommands.projects()).toMatchObject([{ id: PROJECT, path: absPath }]);
    expect(db.prepare("SELECT path FROM projects WHERE id=?").get(PROJECT)).not.toEqual({
      path: absPath,
    });
  });

  it("reads the project through runnerContext.forProject, naming nothing but the project", async () => {
    const { store } = fixture();
    await expect(store.checkouts.site(PROJECT)).rejects.toThrow(/unreachable/);
    const { query } = connect(store, (args) => facts(args));
    expect(await store.checkouts.site(PROJECT)).toEqual({
      projectId: PROJECT,
      projectRepoId: REPO,
      projectName: "Cloud project",
    });
    expect(query.mock.calls).toEqual([["runnerContext:forProject", { projectId: PROJECT }]]);
  });

  it("refuses a project answer for another owner or another project", async () => {
    const { store } = fixture();
    let patch: Record<string, unknown> = {};
    connect(store, (args) => facts(args, patch));
    for (patch of [
      { ownerUserId: "owner-b" },
      { project: { id: REPO, name: "Elsewhere" } },
      { primaryRepo: { id: REPO, projectId: REPO, baseBranch: null } },
    ]) {
      await expect(store.checkouts.site(PROJECT)).rejects.toThrow(/another owner's project/);
    }
  });

  it("registers the folder for this runner only and reports path-free metadata", async () => {
    const { home, store } = fixture();
    const folder = join(home, "repo");
    mkdirSync(folder);
    execFileSync("git", ["init", "-b", "trunk"], { cwd: folder });
    const { mutations } = connect(store, (args) => facts(args));

    await store.checkouts.choose({ projectId: PROJECT, projectRepoId: REPO, absPath: folder });

    expect(store.checkouts.located(PROJECT)).toBe(true);
    expect(store.registry().checkouts.get(PROJECT, REPO)).toMatchObject({
      runnerId: RUNNER,
      absPath: folder,
      kind: "main",
      adoptedFromFrozen: false,
    });
    await vi.waitFor(() =>
      expect(mutations.map(({ name }) => name)).toContain("projectCheckouts:report"),
    );
    const report = mutations.find(({ name }) => name === "projectCheckouts:report")!.args;
    // An unborn repository has a branch and no HEAD yet; neither carries a path.
    expect(report).toMatchObject({
      projectId: PROJECT,
      projectRepoId: REPO,
      kind: "main",
      headBranch: "trunk",
      headSha: null,
    });
    expect(JSON.stringify(report)).not.toContain(home);
    // A registered folder that is gone from disk needs choosing again.
    rmSync(folder, { recursive: true });
    expect(store.checkouts.located(PROJECT)).toBe(false);
  });

  it("refuses a folder another runner already registered", async () => {
    const { db, home, store } = fixture();
    const folder = join(home, "shared");
    mkdirSync(folder);
    db.prepare(
      `INSERT INTO project_checkout_paths
      (project_repo_id, project_id, runner_id, abs_path, kind, adopted_from_frozen)
      VALUES (?, ?, ?, ?, 'main', 0)`,
    ).run(REPO, PROJECT, OTHER_RUNNER, folder);
    connect(store, (args) => facts(args));
    await expect(
      store.checkouts.choose({ projectId: PROJECT, projectRepoId: REPO, absPath: folder }),
    ).rejects.toThrow(/already registered/);
    expect(store.checkouts.located(PROJECT)).toBe(false);
  });
});
