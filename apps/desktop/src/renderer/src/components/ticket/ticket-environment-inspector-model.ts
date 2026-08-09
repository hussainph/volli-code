import {
  type ChangeSetSnapshot,
  errorMessage,
  type Ticket,
  type WorktreeChangeSetResult,
} from "@volli/shared";

import { bodyFileRefRows } from "@renderer/components/ticket/ticket-files-model";
import type { TicketRailMode } from "@renderer/components/ticket/ticket-rail-model";

/**
 * Every Inspector row routes into a rail navigator that already exists, so the
 * destinations are the rail's own modes minus the one the Inspector is pinned
 * above. Deriving it keeps the two in lockstep structurally rather than by
 * convention.
 */
export type TicketEnvironmentDestination = Exclude<TicketRailMode, "sessions">;

export interface TicketEnvironmentRow {
  id: "changes" | "worktree" | "branch" | "pull-request";
  label: string;
  detail: string;
  destination: Exclude<TicketEnvironmentDestination, "files">;
}

export interface TicketEnvironmentSource {
  relPath: string;
  label: string;
}

export interface TicketEnvironmentInspector {
  environment: TicketEnvironmentRow[];
  sources: TicketEnvironmentSource[];
}

/** Whether a Change Set failure still has counts behind it, which sets the banner's words. */
export function hasChangeSetRow(inspector: TicketEnvironmentInspector): boolean {
  return inspector.environment.some((row) => row.id === "changes");
}

const INSPECTOR_REVALIDATE_AFTER_MS = 5_000;

/** The rail re-reads only when a person returns to it, never as a second live watcher. */
export function shouldRevalidateTicketEnvironment({
  lastReadAt,
  now,
  loading,
}: {
  lastReadAt: number | null;
  now: number;
  loading: boolean;
}): boolean {
  return !loading && (lastReadAt === null || now - lastReadAt >= INSPECTOR_REVALIDATE_AFTER_MS);
}

/** Pure read outcome: the Retry button and initial load share these exact semantics. */
export type TicketEnvironmentChangeSetRead = { changeSet: ChangeSetSnapshot } | { error: string };

export async function readTicketEnvironmentChangeSet(
  read: () => Promise<WorktreeChangeSetResult>,
): Promise<TicketEnvironmentChangeSetRead> {
  try {
    const result = await read();
    return result.ok ? { changeSet: result.changeSet } : { error: result.error };
  } catch (cause) {
    return { error: errorMessage(cause) };
  }
}

/**
 * The consulted Change Set state, tagged with the ticket it was read for. One
 * Inspector serves every ticket the rail shows, so retained counts — the whole
 * point of the state — have to name their ticket before they are shown again.
 */
export interface TicketEnvironmentConsultation {
  ticketId: string;
  changeSet?: ChangeSetSnapshot;
  error?: string;
}

/** What `ticketId` may show: another ticket's consultation describes nothing here. */
export function ticketEnvironmentConsultationFor(
  consultation: TicketEnvironmentConsultation,
  ticketId: string,
): TicketEnvironmentConsultation {
  return consultation.ticketId === ticketId ? consultation : { ticketId };
}

/** A read starts: the banner it is retrying goes, the counts it may confirm stay. */
export function beginTicketEnvironmentRead(
  consultation: TicketEnvironmentConsultation,
  ticketId: string,
): TicketEnvironmentConsultation {
  const current = ticketEnvironmentConsultationFor(consultation, ticketId);
  return current.error === undefined ? current : { ticketId, changeSet: current.changeSet };
}

/**
 * A read settles. A failure keeps the counts a person already saw and labels
 * them stale; a success replaces both. A read for a ticket the rail has since
 * left is dropped rather than answered under whichever ticket replaced it.
 */
export function settleTicketEnvironmentRead(
  consultation: TicketEnvironmentConsultation,
  ticketId: string,
  read: TicketEnvironmentChangeSetRead,
): TicketEnvironmentConsultation {
  if (consultation.ticketId !== ticketId) return consultation;
  return "error" in read
    ? { ...consultation, error: read.error }
    : { ticketId, changeSet: read.changeSet };
}

function changeSetDetail(changeSet: ChangeSetSnapshot): string {
  if (changeSet.totalCount === 0) return "No changes vs base";
  return `${changeSet.totalCount} file${changeSet.totalCount === 1 ? "" : "s"} · +${changeSet.insertions} −${changeSet.deletions}`;
}

/**
 * The compact Ticket Environment/Sources projection. It intentionally only
 * reads data the renderer already has: the ticket identity, one Change Set
 * snapshot, and Ticket Body references. Attachment rows need a future renderer
 * feed, so this model never pretends an absent attachment list is complete.
 *
 * A failed re-read never destroys a good snapshot. Consulted state that a
 * person already saw stays on screen and is labelled stale, because the last
 * known counts are still the most honest thing we can show.
 */
export function buildTicketEnvironmentInspector(input: {
  ticket: Pick<Ticket, "worktreePath" | "branch" | "baseBranch" | "prUrl" | "body">;
  /** Undefined while the one-shot Change Set read is pending. */
  changeSet?: ChangeSetSnapshot;
  /** A visible one-shot Change Set failure, distinct from a pending read. */
  changeSetError?: string;
}): TicketEnvironmentInspector {
  const { ticket, changeSet, changeSetError } = input;
  const environment: TicketEnvironmentRow[] = [];
  if (ticket.worktreePath !== null) {
    // A first-read failure has no counts to show, so the row itself waits;
    // the banner alone carries the failure and its Retry.
    if (changeSet !== undefined || changeSetError === undefined) {
      environment.push({
        id: "changes",
        label: "Changes",
        detail: changeSet === undefined ? "Loading changes…" : changeSetDetail(changeSet),
        destination: "changes",
      });
    }
    environment.push({
      id: "worktree",
      label: "Worktree",
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

  const sources = bodyFileRefRows(ticket.body).map((reference) => ({
    relPath: reference.relPath,
    label: reference.label,
  }));

  return { environment, sources };
}
