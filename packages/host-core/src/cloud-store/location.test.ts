import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_RUNNER, type Session } from "@volli/shared";

import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { claimFirstRunSetup, runGitCapturingAsync } from "../worktree";
import { createRunnerPathRegistry } from "./paths";
import {
  CloudFolderRequired,
  createCloudSessionLocationResolver,
  type CloudLocationFacts,
} from "./location";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const TICKET = "00000000-0000-4000-8000-000000000002";
const REPO = "00000000-0000-4000-8000-000000000003";
const SESSION = "00000000-0000-4000-8000-000000000004";
let ctx: TestDb;
let root: string;
let checkout: string;
const session = { id: SESSION, projectId: PROJECT, ticketId: TICKET } as Session;
function git(cwd: string, args: readonly string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Volli Test",
      GIT_AUTHOR_EMAIL: "test@volli.local",
      GIT_COMMITTER_NAME: "Volli Test",
      GIT_COMMITTER_EMAIL: "test@volli.local",
    },
  }).trim();
}
function facts(): CloudLocationFacts {
  return {
    project: { id: PROJECT, name: "Cloud project" },
    ticketPrefix: "VC",
    ticket: {
      id: TICKET,
      projectId: PROJECT,
      number: 12,
      title: "Cloud only",
      checkoutMode: "worktree",
      branch: null,
      baseBranch: "main",
      retentionKeep: false,
      status: "doing",
      archivedAt: null,
    },
    primaryRepo: { id: REPO, projectId: PROJECT, baseBranch: "main" },
  };
}
function fixture(value = facts()) {
  const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner-a" });
  registry.checkouts.register({ projectId: PROJECT, projectRepoId: REPO, absPath: checkout });
  const forSession = vi.fn(async () => value);
  const reports = {
    checkout: vi.fn(async () => ({ projectRepoId: REPO })),
    workingCopy: vi.fn(async () => ({ workingCopyId: "copy-id" })),
  };
  const location = createCloudSessionLocationResolver({
    registry,
    forSession,
    reports,
    gitAsync: runGitCapturingAsync,
    home: root,
  });
  return { registry, forSession, reports, location };
}
beforeEach(() => {
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "volli-cloud-location-"));
  checkout = join(root, "checkout");
  mkdirSync(checkout);
  git(checkout, ["init", "-b", "main"]);
  writeFileSync(join(checkout, "README.md"), "initial\n");
  writeFileSync(join(checkout, ".gitignore"), ".env\nnode_modules/\n");
  git(checkout, ["add", "."]);
  git(checkout, ["commit", "-m", "initial"]);
  writeFileSync(join(checkout, ".env"), "LOCAL=1\n");
});
afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe("cloud Session locations", () => {
  it("creates and reuses a cloud-only worktree with real git, copying includes and reporting branch/head/state", async () => {
    const { registry, reports, location } = fixture();
    const first = await location.prepare(session);
    expect(first.venue).toEqual(LOCAL_RUNNER);
    expect(first.directory).not.toBe(checkout);
    expect(readFileSync(join(first.directory, ".env"), "utf8")).toBe("LOCAL=1\n");
    expect(git(first.directory, ["branch", "--show-current"])).toBe("volli/VC-12-cloud-only");
    expect(reports.workingCopy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ticketId: TICKET,
        projectRepoId: REPO,
        state: "ready",
        branch: "volli/VC-12-cloud-only",
        headSha: git(checkout, ["rev-parse", "HEAD"]),
      }),
    );
    expect(registry.workingCopies.get(TICKET, REPO)?.workingCopyId).toBe("copy-id");
    const second = await location.prepare(session);
    expect(second.directory).toBe(first.directory);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM ticket_events").get()).toEqual({ n: 0 });
  });

  it("adopts the migrating Mac's existing checkout/worktree without restamping frozen rows", async () => {
    const path = join(root, "frozen-copy");
    const branch = "volli/VC-12-original";
    git(checkout, ["worktree", "add", "-b", branch, path, "main"]);
    insertProject(ctx.db, testProject({ id: PROJECT, path: checkout }));
    insertTicket(
      ctx.db,
      testTicket(PROJECT, { id: TICKET, ticketNumber: 12, worktreePath: path, branch }),
    );
    const before = ctx.db.prepare("SELECT * FROM tickets").all();
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner-a" });
    const reports = {
      checkout: async () => ({}),
      workingCopy: async () => ({ workingCopyId: "copy-id" }),
    };
    const location = createCloudSessionLocationResolver({
      registry,
      forSession: async () => facts(),
      reports,
      gitAsync: runGitCapturingAsync,
      home: root,
    });
    expect((await location.prepare(session)).directory).toBe(path);
    expect(git(path, ["branch", "--show-current"])).toBe(branch);
    expect(registry.workingCopies.get(TICKET, REPO)?.adoptedFromFrozen).toBe(true);
    expect(ctx.db.prepare("SELECT * FROM tickets").all()).toEqual(before);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM ticket_events").get()).toEqual({ n: 0 });
  });

  it.each([
    { adopted: true, retitled: false },
    { adopted: true, retitled: true },
    { adopted: false, retitled: true },
  ])(
    "retains the isolated stamp across shared-mode round trips ($adopted adopted, $retitled retitled)",
    async ({ adopted, retitled }) => {
      const value = facts();
      if (adopted) {
        const path = join(root, "chosen-isolated-folder");
        const branch = "volli/VC-12-original-name";
        git(checkout, ["worktree", "add", "-b", branch, path, "main"]);
        insertProject(ctx.db, testProject({ id: PROJECT, path: checkout }));
        insertTicket(
          ctx.db,
          testTicket(PROJECT, { id: TICKET, ticketNumber: 12, worktreePath: path, branch }),
        );
      }
      const { registry, location, reports } = fixture(value);
      const isolated = await location.prepare(session);
      const stamp = registry.workingCopies.get(TICKET, REPO);
      value.ticket!.checkoutMode = "main_checkout";
      if (retitled) value.ticket!.title = "A completely different title";
      expect((await location.prepare(session)).directory).toBe(checkout);
      expect(reports.workingCopy).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "main_checkout", branch: "main" }),
      );
      expect(registry.workingCopies.get(TICKET, REPO)).toEqual(stamp);
      expect(
        (
          await location.prepareRegistered({
            sessionId: SESSION,
            projectId: PROJECT,
            ticketId: TICKET,
          })
        )?.directory,
      ).toBe(checkout);

      // No launch-local cache can preserve identity: reopen the registry/resolver.
      const reopened = createRunnerPathRegistry(ctx.db, { runnerId: "runner-a" });
      const resumed = createCloudSessionLocationResolver({
        registry: reopened,
        forSession: async () => value,
        reports,
        gitAsync: runGitCapturingAsync,
        home: root,
      });
      value.ticket!.checkoutMode = "worktree";
      expect((await resumed.prepare(session)).directory).toBe(isolated.directory);
      expect(git(isolated.directory, ["branch", "--show-current"])).toBe(stamp!.branch);
      expect(reopened.workingCopies.get(TICKET, REPO)).toEqual(stamp);
      expect(git(checkout, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(
        2,
      );
    },
  );

  it("requires one folder selection on a registry miss and rejects mismatched query identities", async () => {
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner" });
    const gitAsync = vi.fn(runGitCapturingAsync);
    const location = createCloudSessionLocationResolver({
      registry,
      forSession: async () => facts(),
      reports: {
        checkout: async () => ({}),
        workingCopy: async () => ({ workingCopyId: "copy-id" }),
      },
      gitAsync,
    });
    await expect(location.prepare(session)).rejects.toThrow(CloudFolderRequired);
    expect(gitAsync).not.toHaveBeenCalled();
    await expect(location.prepare({ ...session, projectId: "another-project" })).rejects.toThrow(
      "another project or ticket",
    );
  });

  it("reaffirms a live directory without a cloud read and recreates a missing copy at its same registry path", async () => {
    const { location, forSession } = fixture();
    const prepared = await location.prepare(session);
    forSession.mockRejectedValueOnce(new Error("offline"));
    await expect(location.reaffirm(session, prepared.directory)).resolves.toBeUndefined();
    // The unused rejection proves reaffirm did not make a query for a live path.
    await expect(location.resolve(session)).rejects.toThrow("offline");
    rmSync(prepared.directory, { recursive: true, force: true });
    await location.reaffirm(session, prepared.directory);
    expect(existsSync(join(prepared.directory, "README.md"))).toBe(true);
  });

  it("keeps environment setup explicit and fails closed when the runner is absent", async () => {
    const { registry, reports, forSession } = fixture();
    const options = {
      registry,
      reports,
      forSession,
      gitAsync: runGitCapturingAsync,
      home: root,
      environmentRecipes: () => true,
    };
    const blocked = createCloudSessionLocationResolver(options);
    await expect(blocked.prepare(session)).rejects.toThrow("still needs setup");
    expect(reports.workingCopy).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "failed" }),
    );
    const prepareEnvironment = vi.fn(async ({ directory }: { directory: string }) => {
      claimFirstRunSetup({ home: root }, directory);
    });
    const available = createCloudSessionLocationResolver({ ...options, prepareEnvironment });
    await available.prepare(session);
    expect(prepareEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ setupPending: true }) }),
    );
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM ticket_events").get()).toEqual({ n: 0 });
  });

  it("allows a main-checkout Session in an ordinary folder without inventing git metadata", async () => {
    const value = facts();
    value.ticket = null;
    const { registry, reports } = fixture(value);
    const folder = join(root, "ordinary");
    mkdirSync(folder);
    registry.checkouts.register({ projectId: PROJECT, projectRepoId: REPO, absPath: folder });
    const location = createCloudSessionLocationResolver({
      registry,
      reports,
      forSession: async () => value,
      gitAsync: runGitCapturingAsync,
    });
    expect(await location.prepare({ ...session, ticketId: null })).toMatchObject({
      directory: folder,
      venue: LOCAL_RUNNER,
    });
    expect(reports.checkout).toHaveBeenCalledWith(
      expect.objectContaining({ headBranch: null, headSha: null }),
    );
  });
});

it("records shared main-checkout tickets and can later materialize one as an isolated worktree", async () => {
  const value = facts();
  value.ticket!.checkoutMode = "main_checkout";
  const { registry } = fixture(value);
  const location = createCloudSessionLocationResolver({
    registry,
    gitAsync: runGitCapturingAsync,
    home: root,
    forSession: async (input) => ({ ...value, ticket: { ...value.ticket!, id: input.ticketId! } }),
    reports: {
      checkout: async () => ({}),
      workingCopy: async (input) => ({ workingCopyId: `copy-${input.ticketId}` }),
    },
  });
  expect((await location.prepare(session)).directory).toBe(checkout);
  expect((await location.prepare({ ...session, ticketId: "other-ticket" })).directory).toBe(
    checkout,
  );
  expect(registry.workingCopies.list().map((copy) => copy.kind)).toEqual([
    "main_checkout",
    "main_checkout",
  ]);
  value.ticket!.checkoutMode = "worktree";
  const isolated = await location.prepare(session);
  expect(isolated.directory).not.toBe(checkout);
  expect(git(isolated.directory, ["branch", "--show-current"])).toBe("volli/VC-12-cloud-only");
  expect(registry.workingCopies.get(TICKET, REPO)?.kind).toBe("worktree");
  expect(registry.workingCopies.get("other-ticket", REPO)?.absPath).toBe(checkout);
});
