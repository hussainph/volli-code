import type Database from "better-sqlite3";
import type { SessionLocationResolver } from "@volli/session-engine";
import { getProjectById } from "../db/projects-repo";
import { getTicket } from "../db/tickets-repo";

/** Resolves immutable Session identity to its trusted project/worktree directory. */
export function createDesktopSessionLocationResolver(
  db: Database.Database,
): SessionLocationResolver {
  return {
    async resolve(session) {
      const project = getProjectById(db, session.projectId);
      if (!project) throw new Error(`Project ${session.projectId} was not found`);
      if (session.ticketId === null) {
        return { directory: project.path, venue: { id: "local", kind: "local" } };
      }
      const ticket = getTicket(db, session.ticketId);
      if (!ticket || ticket.projectId !== project.id) {
        throw new Error(`Ticket ${session.ticketId} was not found in project ${project.id}`);
      }
      return {
        directory: ticket.worktreePath ?? project.path,
        venue: { id: "local", kind: "local" },
      };
    },
  };
}
