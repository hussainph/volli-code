import { baseNameOf, type ChangeSetSnapshot, type Ticket } from "@volli/shared";

import { buildTicketFilesNavigator } from "@renderer/components/ticket/ticket-files-model";

export type TicketEnvironmentDestination = "changes" | "properties" | "files";

export interface TicketEnvironmentRow {
  id: "changes" | "worktree" | "branch" | "pull-request";
  label: string;
  detail: string;
  destination: Exclude<TicketEnvironmentDestination, "files">;
}

export interface TicketEnvironmentSource {
  relPath: string;
  label: string;
  destination: "files";
}

export interface TicketEnvironmentInspector {
  environment: TicketEnvironmentRow[];
  sources: TicketEnvironmentSource[];
}

function changeSetDetail(
  changeSet: ChangeSetSnapshot | undefined,
  changeSetError: string | undefined,
): string {
  if (changeSetError !== undefined) return "Changes unavailable";
  if (changeSet === undefined) return "Loading changes…";
  if (changeSet.totalCount === 0) return "No changes vs base";
  return `${changeSet.totalCount} file${changeSet.totalCount === 1 ? "" : "s"} · +${changeSet.insertions} −${changeSet.deletions}`;
}

/**
 * The compact Ticket Environment/Sources projection. It intentionally only
 * reads data the renderer already has: the ticket identity, one Change Set
 * snapshot, and Ticket Body references. Attachment rows need a future renderer
 * feed, so this model never pretends an absent attachment list is complete.
 */
export function buildTicketEnvironmentInspector(input: {
  ticket: Pick<Ticket, "worktreePath" | "branch" | "baseBranch" | "prUrl" | "body">;
  /** Undefined while the one-shot Change Set read is pending. */
  changeSet?: ChangeSetSnapshot;
  /** A visible one-shot Change Set failure, distinct from a pending read. */
  changeSetError?: string;
}): TicketEnvironmentInspector {
  const { ticket } = input;
  const environment: TicketEnvironmentRow[] = [];
  if (ticket.worktreePath !== null) {
    environment.push({
      id: "changes",
      label: "Changes",
      detail: changeSetDetail(input.changeSet, input.changeSetError),
      destination: "changes",
    });
    environment.push({
      id: "worktree",
      label: "Local",
      detail: ticket.worktreePath,
      destination: "properties",
    });
  }
  if (ticket.branch !== null) {
    environment.push({
      id: "branch",
      label: "Branch",
      detail:
        ticket.baseBranch === null ? ticket.branch : `${ticket.branch} · ${ticket.baseBranch}`,
      destination: "properties",
    });
  }
  if (ticket.prUrl !== null) {
    environment.push({
      id: "pull-request",
      label: "Pull request",
      detail: ticket.prUrl,
      destination: "properties",
    });
  }

  const sources = buildTicketFilesNavigator({
    body: ticket.body,
    attachments: [],
    worktreeEntries: [],
  }).referenced.map((reference) => ({
    relPath: reference.relPath,
    label: baseNameOf(reference.relPath),
    destination: "files" as const,
  }));

  return { environment, sources };
}
