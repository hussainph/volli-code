import { afterEach, describe, expect, it } from "vite-plus/test";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { createDesktopSessionLocationResolver } from "./location";

let testDb: TestDb | undefined;

afterEach(() => {
  testDb?.cleanup();
  testDb = undefined;
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
});
