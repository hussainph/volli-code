import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { roleImpliedByTicket } from "@volli/shared";
import type { Session } from "@volli/shared";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";

// Only `ensure` is stood in for, so `prepare` can be asked the one question no
// return value answers: whether a ticketless Session touches git at all.
const { ensureWorktree } = vi.hoisted(() => ({ ensureWorktree: vi.fn() }));
vi.mock("../worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree")>();
  return { ...actual, ensure: ensureWorktree };
});
vi.mock("../worktree-runtime", () => ({ worktreeDeps: (db: unknown) => ({ db }) }));
// A recreated worktree really does fan out `volli:data-changed`; with no window
// open that is a loop over nothing, which is all this suite needs it to be.
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { createDesktopSessionLocationResolver } from "./location";
import {
  acquireDeletionLease,
  acquireWorktreeStartLease,
  resetDeletionLeasesForTest,
  UNDER_DELETION_REFUSAL,
} from "../worktree/deletion-lease";

let testDb: TestDb | undefined;
let scratchRoot: string | undefined;

afterEach(() => {
  resetDeletionLeasesForTest();
  testDb?.cleanup();
  testDb = undefined;
  if (scratchRoot !== undefined) rmSync(scratchRoot, { recursive: true, force: true });
  scratchRoot = undefined;
  ensureWorktree.mockReset();
});

/** A real directory to delete out from under a Session — `reaffirm`'s only input. */
function scratch(): string {
  scratchRoot = mkdtempSync(join(tmpdir(), "volli-location-"));
  return scratchRoot;
}

function ticketSession(projectId: string, ticketId: string): Session {
  return {
    id: "ticket-session",
    projectId,
    ticketId,
    role: "ticket",
    parentSessionId: null,
    title: null,
    createdAt: 0,
  };
}

describe("desktop Session location resolver", () => {
  it("routes Board Sessions to the Main checkout and ticket Sessions to their worktree", async () => {
    testDb = openTestDb();
    const project = testProject({ id: "project-1", path: "/repo/main" });
    const ticket = testTicket(project.id, {
      id: "ticket-1",
      worktreePath: "/repo/worktree",
    });
    insertProject(testDb.db, project);
    insertTicket(testDb.db, ticket);
    const resolver = createDesktopSessionLocationResolver(testDb.db);

    await expect(
      resolver.resolve({
        id: "project-session",
        projectId: project.id,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).resolves.toEqual({ directory: project.path, venue: { id: "local", kind: "local" } });
    await expect(
      resolver.resolve({
        id: "ticket-session",
        projectId: project.id,
        ticketId: ticket.id,
        role: roleImpliedByTicket(ticket.id),
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).resolves.toEqual({
      directory: ticket.worktreePath,
      venue: { id: "local", kind: "local" },
    });
  });

  it("falls back to Main without a worktree and rejects stale identity", async () => {
    testDb = openTestDb();
    const project = testProject({ id: "project-1", path: "/repo/main" });
    const ticket = testTicket(project.id, { id: "ticket-1", worktreePath: null });
    const otherProject = testProject({ id: "project-2", path: "/repo/other" });
    const foreignTicket = testTicket(otherProject.id, {
      id: "ticket-2",
      worktreePath: "/repo/other-worktree",
    });
    insertProject(testDb.db, project);
    insertTicket(testDb.db, ticket);
    insertProject(testDb.db, otherProject);
    insertTicket(testDb.db, foreignTicket);
    const resolver = createDesktopSessionLocationResolver(testDb.db);

    await expect(
      resolver.resolve({
        id: "ticket-session",
        projectId: project.id,
        ticketId: ticket.id,
        role: roleImpliedByTicket(ticket.id),
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).resolves.toMatchObject({ directory: project.path });
    await expect(
      resolver.resolve({
        id: "missing-project-session",
        projectId: "missing",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).rejects.toThrow("Project missing was not found");
    await expect(
      resolver.resolve({
        id: "missing-ticket-session",
        projectId: project.id,
        ticketId: "missing",
        role: "ticket",
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).rejects.toThrow("Ticket missing was not found");
    await expect(
      resolver.resolve({
        id: "cross-project-ticket-session",
        projectId: project.id,
        ticketId: foreignTicket.id,
        role: roleImpliedByTicket(foreignTicket.id),
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).rejects.toThrow(`Ticket ${foreignTicket.id} was not found in project ${project.id}`);
  });

  // A Board Session has no ticket and therefore no isolated checkout to
  // materialize — it runs in the project root. Pinned because `prepare` is the
  // attach path's only git seam, and a ticketless Session reaching `ensure`
  // would be asking for a worktree for a ticket that does not exist.
  it("prepares a ticketless Session in the project root without touching the worktree pipeline", async () => {
    testDb = openTestDb();
    const project = testProject({ id: "project-1", path: "/repo/main" });
    insertProject(testDb.db, project);
    const resolver = createDesktopSessionLocationResolver(testDb.db);

    await expect(
      resolver.prepare({
        id: "project-session",
        projectId: project.id,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).resolves.toEqual({ directory: project.path, venue: { id: "local", kind: "local" } });
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  it("prepares a ticket that opts out of worktrees in the project root too", async () => {
    testDb = openTestDb();
    const project = testProject({ id: "project-1", path: "/repo/main" });
    const ticket = testTicket(project.id, { id: "ticket-1", usesWorktree: false });
    insertProject(testDb.db, project);
    insertTicket(testDb.db, ticket);
    const resolver = createDesktopSessionLocationResolver(testDb.db);

    await expect(
      resolver.prepare({
        id: "ticket-session",
        projectId: project.id,
        ticketId: ticket.id,
        role: roleImpliedByTicket(ticket.id),
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).resolves.toMatchObject({ directory: project.path });
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  // The bug this seam exists for: a worktree deleted out from under a Session
  // that is still bound to it. Every prompt afterwards died a second later,
  // inside the harness, on the harness's own name for a missing path.
  it("recreates a bound worktree that was deleted under the Session", async () => {
    testDb = openTestDb();
    const root = scratch();
    const worktreePath = join(root, "VC-3-doing");
    const project = testProject({ id: "project-1", path: join(root, "main") });
    const ticket = testTicket(project.id, { id: "ticket-1", worktreePath });
    insertProject(testDb.db, project);
    insertTicket(testDb.db, ticket);
    const resolver = createDesktopSessionLocationResolver(testDb.db);
    const session = ticketSession(project.id, ticket.id);

    // Present: the check before a turn is one `existsSync` and no git at all.
    mkdirSync(worktreePath);
    await expect(resolver.reaffirm(session, worktreePath)).resolves.toBeUndefined();
    expect(ensureWorktree).not.toHaveBeenCalled();

    // Gone: `ensure` runs, and reconcile's prune-and-recreate puts the SAME
    // path back from the SAME branch — which is what the stand-in does here.
    rmSync(worktreePath, { recursive: true });
    ensureWorktree.mockImplementation(async () => {
      mkdirSync(worktreePath);
      return {
        ok: true,
        value: {
          identity: { worktreePath, branch: "volli/VC-3-doing", baseBranch: "main" },
          created: true,
        },
      };
    });
    await expect(resolver.reaffirm(session, worktreePath)).resolves.toBeUndefined();
    expect(ensureWorktree).toHaveBeenCalledWith({ db: testDb.db }, ticket.id);
  });

  it("names the path when the worktree cannot be put back", async () => {
    testDb = openTestDb();
    const root = scratch();
    const worktreePath = join(root, "VC-3-doing");
    const project = testProject({ id: "project-1", path: join(root, "main") });
    const ticket = testTicket(project.id, { id: "ticket-1", worktreePath });
    insertProject(testDb.db, project);
    insertTicket(testDb.db, ticket);
    const resolver = createDesktopSessionLocationResolver(testDb.db);
    const session = ticketSession(project.id, ticket.id);

    // `ensure` refused: `prepare`'s own error already names the worktree and
    // carries git's reason, so it is what the user reads.
    ensureWorktree.mockResolvedValue({ ok: false, error: "fatal: invalid reference" });
    await expect(resolver.reaffirm(session, worktreePath)).rejects.toThrow(
      `Couldn't prepare the worktree at ${worktreePath} — fatal: invalid reference`,
    );

    // `ensure` claimed success and the bound directory is still not there —
    // Volli says so rather than handing the adapter a path that isn't real.
    ensureWorktree.mockResolvedValue({
      ok: true,
      value: {
        identity: { worktreePath, branch: "volli/VC-3-doing", baseBranch: "main" },
        created: false,
      },
    });
    await expect(resolver.reaffirm(session, worktreePath)).rejects.toThrow(
      `The Session's directory ${worktreePath} is gone and couldn't be recreated.`,
    );
  });

  // A Board Session runs in the project root, which no pipeline materializes.
  it("refuses a project root that is gone instead of pretending it is there", async () => {
    testDb = openTestDb();
    const root = scratch();
    const project = testProject({ id: "project-1", path: join(root, "main") });
    insertProject(testDb.db, project);
    const resolver = createDesktopSessionLocationResolver(testDb.db);
    const session: Session = {
      id: "project-session",
      projectId: project.id,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      createdAt: 0,
    };

    await expect(resolver.reaffirm(session, project.path)).rejects.toThrow(
      `The Session's directory ${project.path} is gone and couldn't be recreated.`,
    );
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  // VC-284 re-review C4. An agent start is the other side of the deletion
  // lease: a Session can still be bound to a directory this app now calls an
  // orphan (deleting a ticket only clears `sessions.ticket_id`), so "an agent is
  // about to work here" and "a cleanup is about to remove here" are two acts
  // over one directory. Both take the lease, so they cannot both proceed.
  describe("against a cleanup that is removing the directory", () => {
    it("refuses to materialize or reaffirm a directory under an active deletion", async () => {
      testDb = openTestDb();
      const root = scratch();
      const worktreePath = join(root, "VC-9-going");
      mkdirSync(worktreePath, { recursive: true });
      const project = testProject({ id: "project-1", path: join(root, "main") });
      const ticket = testTicket(project.id, { id: "ticket-1", worktreePath });
      insertProject(testDb.db, project);
      insertTicket(testDb.db, ticket);
      const resolver = createDesktopSessionLocationResolver(testDb.db);
      const session = ticketSession(project.id, ticket.id);

      const removing = acquireDeletionLease(worktreePath);
      expect(removing).not.toBeNull();

      // The turn gate — the directory exists, so without the lease this would
      // have returned happily and the agent would have started writing into a
      // checkout being removed.
      await expect(resolver.reaffirm(session, worktreePath)).rejects.toThrow(
        UNDER_DELETION_REFUSAL,
      );
      await expect(resolver.prepare(session)).rejects.toThrow(UNDER_DELETION_REFUSAL);
      expect(ensureWorktree).not.toHaveBeenCalled();

      // Given back, both go through again.
      removing?.release();
      await expect(resolver.reaffirm(session, worktreePath)).resolves.toBeUndefined();
    });

    it("refuses a Board Session's project root under an active deletion", async () => {
      testDb = openTestDb();
      const root = scratch();
      const project = testProject({ id: "project-1", path: root });
      insertProject(testDb.db, project);
      const resolver = createDesktopSessionLocationResolver(testDb.db);
      const session: Session = {
        id: "project-session",
        projectId: project.id,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        createdAt: 0,
      };

      const removing = acquireDeletionLease(root);
      await expect(resolver.prepare(session)).rejects.toThrow(UNDER_DELETION_REFUSAL);
      removing?.release();
      await expect(resolver.prepare(session)).resolves.toEqual({
        directory: root,
        venue: { id: "local", kind: "local" },
      });
    });

    it("holds the directory while it materializes, so a cleanup cannot take it mid-prepare", async () => {
      testDb = openTestDb();
      const root = scratch();
      const worktreePath = join(root, "VC-10-starting");
      const project = testProject({ id: "project-1", path: join(root, "main") });
      const ticket = testTicket(project.id, { id: "ticket-1", worktreePath });
      insertProject(testDb.db, project);
      insertTicket(testDb.db, ticket);
      const resolver = createDesktopSessionLocationResolver(testDb.db);
      const session = ticketSession(project.id, ticket.id);

      let leaseDuringEnsure: unknown = "unasked";
      ensureWorktree.mockImplementation(async () => {
        // `ensure` is git work plus a durable event: this is the window a
        // cleanup used to be able to acquire in.
        leaseDuringEnsure = acquireDeletionLease(worktreePath);
        return {
          ok: true,
          value: {
            identity: { worktreePath, branch: "volli/VC-10", baseBranch: "main" },
            created: false,
          },
        };
      });
      mkdirSync(worktreePath, { recursive: true });

      await expect(resolver.prepare(session)).resolves.toEqual({
        directory: worktreePath,
        venue: { id: "local", kind: "local" },
      });

      expect(leaseDuringEnsure).toBeNull();
      // And the start gives it back, so the cleanup can have it afterwards.
      const after = acquireDeletionLease(worktreePath);
      expect(after).not.toBeNull();
      after?.release();
    });

    it("lets two starts share a directory — they exclude deletion, not each other", () => {
      const root = scratch();
      const first = acquireWorktreeStartLease(root);
      const second = acquireWorktreeStartLease(join(root, "src"));
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // But neither of them may be deleted out from under.
      expect(acquireDeletionLease(root)).toBeNull();
      first?.release();
      second?.release();
      expect(acquireDeletionLease(root)).not.toBeNull();
    });
  });
});
