/** Machine paths are local pointers, never Cloud board/shadow fields. */
import type Database from "better-sqlite3";
import { displayTicketId } from "@volli/shared";
import { getProjectById } from "./db/projects-repo";
import { getTicketRow } from "./db/tickets-repo";
import { prepared } from "./db/prepared";
import { hasCloudShadowRows } from "./db/cloud-shadow-paths";

export interface MachineTicketPath {
  projectId: string;
  displayId: string;
  usesWorktree: boolean;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
}

export interface MachinePathReader {
  readonly kind: "local" | "cloud";
  projectPath(projectId: string): string | null;
  ticket(ticketId: string): MachineTicketPath | null;
}

/** Signed-out readers must not treat even an old canary's shadow as a folder. */
export function localMachinePaths(db: Database.Database): MachinePathReader {
  const hasShadows = hasCloudShadowRows(db);
  const shadow = (kind: "project" | "ticket", id: string) =>
    hasShadows &&
    prepared(db, "SELECT 1 FROM cloud_shadow_rows WHERE kind=? AND id=?").get(kind, id) !==
      undefined;
  const projectPath = (projectId: string) =>
    shadow("project", projectId) ? null : (getProjectById(db, projectId)?.path ?? null);
  return {
    kind: "local",
    projectPath,
    ticket(ticketId) {
      if (shadow("ticket", ticketId)) return null;
      const row = getTicketRow(db, ticketId);
      if (row === undefined || shadow("project", row.project_id)) return null;
      const project = getProjectById(db, row.project_id);
      if (project === undefined) return null;
      return {
        projectId: row.project_id,
        displayId: displayTicketId(project.ticketPrefix, row.ticket_number),
        usesWorktree: row.uses_worktree !== 0,
        worktreePath: row.worktree_path,
        branch: row.branch,
        baseBranch: row.base_branch,
      };
    },
  };
}

/** One host-owned seam, selected once at launch before any client can read. */
export function createMachinePaths(db: Database.Database) {
  let reader = localMachinePaths(db);
  return {
    get kind() {
      return reader.kind;
    },
    projectPath: (projectId: string) => reader.projectPath(projectId),
    ticket: (ticketId: string) => reader.ticket(ticketId),
    bindCloud(cloud: MachinePathReader): void {
      if (reader.kind === "cloud")
        throw new Error("Machine paths are already bound for this launch.");
      if (cloud.kind !== "cloud") throw new Error("A Cloud machine-path reader is required.");
      reader = cloud;
    },
  };
}
export type MachinePaths = ReturnType<typeof createMachinePaths>;

export const FOLDER_REQUIRED = "Choose the project's folder on this Mac.";
export const TICKET_FOLDER_REQUIRED =
  "This ticket's Working copy is unavailable on this Mac. Start or resume a Session to locate it.";
