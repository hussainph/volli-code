import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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

import { createDesktopSessionLocationResolver } from "./location";

let testDb: TestDb | undefined;

afterEach(() => {
  testDb?.cleanup();
  testDb = undefined;
  ensureWorktree.mockReset();
});

describe("desktop Session location resolver", () => {
  it("routes scratch Sessions to the Main checkout and ticket Sessions to their worktree", async () => {
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
        id: "scratch",
        projectId: project.id,
        ticketId: null,
        title: null,
        createdAt: 0,
      }),
    ).resolves.toEqual({ directory: project.path, venue: { id: "local", kind: "local" } });
    await expect(
      resolver.resolve({
        id: "ticket-session",
        projectId: project.id,
        ticketId: ticket.id,
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
        title: null,
        createdAt: 0,
      }),
    ).resolves.toMatchObject({ directory: project.path });
    await expect(
      resolver.resolve({
        id: "missing-project-session",
        projectId: "missing",
        ticketId: null,
        title: null,
        createdAt: 0,
      }),
    ).rejects.toThrow("Project missing was not found");
    await expect(
      resolver.resolve({
        id: "missing-ticket-session",
        projectId: project.id,
        ticketId: "missing",
        title: null,
        createdAt: 0,
      }),
    ).rejects.toThrow("Ticket missing was not found");
    await expect(
      resolver.resolve({
        id: "cross-project-ticket-session",
        projectId: project.id,
        ticketId: foreignTicket.id,
        title: null,
        createdAt: 0,
      }),
    ).rejects.toThrow(`Ticket ${foreignTicket.id} was not found in project ${project.id}`);
  });

  // A scratch Session has no ticket and therefore no isolated checkout to
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
        id: "scratch",
        projectId: project.id,
        ticketId: null,
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
        title: null,
        createdAt: 0,
      }),
    ).resolves.toMatchObject({ directory: project.path });
    expect(ensureWorktree).not.toHaveBeenCalled();
  });
});
