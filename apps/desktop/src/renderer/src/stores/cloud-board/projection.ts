/**
 * Volli Cloud's rows as the renderer's board reads them (VC-889): the pure
 * map from what `board.roster`, `board.archivedTickets` and `projects.list`
 * answer to the `Ticket`, `Label` and `Project` rows every board surface
 * already draws. The board store holds this projection and nothing else: no
 * pending state, no cursors. The facts live in the window's Convex client.
 *
 * - A card's order is its index in its column, sorted as the backend sorts
 *   (`compareBoardOrder`: position, then number).
 * - Labels are worn by name, each id followed to the live label it was merged
 *   into (`labelNamesOf`); only live labels are the project's labels.
 * - The roster carries no body: a ticket whose body this window has not read
 *   gets the `""` placeholder and an unloaded mark (VC-387), until the open
 *   ticket's own read fills it.
 * - Paths are a runner's, never the backend's: `worktreePath` is always
 *   `null`, a project's `path` always `""`.
 */
import { compareBoardOrder, labelNamesOf, type BoardTicketRow } from "@volli/shared/cloud";
import { AGENT_ACTOR_PREFIX, USER_ACTOR } from "@volli/shared";
import type {
  ArchivedTicket,
  HarnessId,
  Label,
  Project,
  Ticket,
  TicketComment,
  TicketEvent,
  TicketEventActorKind,
  TicketEventPayload,
  TicketPriority,
  TicketStatus,
} from "@volli/shared";

/** A roster ticket row: the rules' fields, and what else of `board.roster`'s rows the board reads. */
export interface CloudTicketRow extends BoardTicketRow {
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly pullRequests: readonly { readonly url: string }[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A label row, aliases included. */
export interface CloudLabelRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly color: string | null;
  readonly mergedIntoId: string | null;
}

/** A `projects.list` row: the fields the rail reads. */
export interface CloudProjectRow {
  readonly id: string;
  readonly name: string;
  readonly ticketPrefix: string;
  readonly colorIndex: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt: number | null;
}

export interface CloudRoster {
  readonly tickets: readonly CloudTicketRow[];
  readonly labels: readonly CloudLabelRow[];
}

/** One ticket row as a board card, its body from `bodies` or the placeholder. */
function ticketOf(
  row: CloudTicketRow,
  labels: readonly CloudLabelRow[],
  order: number,
  body: string,
): Ticket {
  return {
    id: row.id,
    projectId: row.projectId,
    ticketNumber: row.number,
    title: row.title,
    body,
    status: row.status,
    priority: row.priority,
    labels: labelNamesOf(row.labelIds, labels),
    usesWorktree: row.checkoutMode === "worktree",
    preferredHarnessId: row.preferredHarnessId as HarnessId,
    order,
    worktreePath: null,
    branch: row.branch,
    baseBranch: row.baseBranch,
    prUrl: row.pullRequests[0]?.url ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A project's live labels, as the board's label slice holds them. */
export function projectLabels(labels: readonly CloudLabelRow[]): Label[] {
  return labels
    .filter((label) => label.mergedIntoId === null)
    .map((label) => ({
      id: label.id,
      projectId: label.projectId,
      name: label.name,
      color: label.color,
    }));
}

/**
 * The board as the store paints it: every live card in board order with its
 * column index as `order`, the live labels, and which cards hold a
 * placeholder body (`bodies` holds the ones this window has read).
 */
export function projectBoard(
  roster: CloudRoster,
  bodies: ReadonlyMap<string, string>,
): { tickets: Ticket[]; labels: Label[]; unloaded: Set<string> } {
  const sorted = roster.tickets.toSorted(compareBoardOrder);
  const columns = new Map<TicketStatus, number>();
  const unloaded = new Set<string>();
  const tickets = sorted.map((row) => {
    const order = columns.get(row.status) ?? 0;
    columns.set(row.status, order + 1);
    const body = bodies.get(row.id);
    if (body === undefined) unloaded.add(row.id);
    return ticketOf(row, roster.labels, order, body ?? "");
  });
  return { tickets, labels: projectLabels(roster.labels), unloaded };
}

/**
 * One page of the Archive, newest-archived first as the backend answers it.
 * An archived row carries no body (it is read when opened) and no order.
 */
export function projectArchived(
  rows: readonly (CloudTicketRow & { readonly archivedAt: number | null })[],
  labels: readonly CloudLabelRow[],
): ArchivedTicket[] {
  return rows.map((row) => ({ ...ticketOf(row, labels, 0, ""), archivedAt: row.archivedAt ?? 0 }));
}

/** A Workspace's live projects as rail rows, in the order the backend lists them. */
export function projectRows(rows: readonly CloudProjectRow[]): Project[] {
  return rows
    .filter((row) => row.archivedAt === null)
    .map((row, index) => ({
      id: row.id,
      name: row.name,
      path: "",
      ticketPrefix: row.ticketPrefix,
      baseBranch: null,
      colorIndex: row.colorIndex,
      sortOrder: index,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
}

/** A stored actor, as far as the board reads one: its kind, and an agent's Session. */
export interface CloudActorRow {
  readonly kind: string;
  readonly sessionId?: string | null;
  readonly ticketId?: string | null;
}

/** A `board.ticketEvents` row: the fields the Activity feed reads. */
export interface CloudEventRow {
  readonly id: string;
  readonly ticketId: string | null;
  readonly actor: CloudActorRow;
  readonly occurredAt: number;
  readonly payload: unknown;
}

/** A `board.comments` row. */
export interface CloudCommentRow {
  readonly id: string;
  readonly ticketId: string;
  readonly sessionId: string | null;
  readonly author: CloudActorRow;
  readonly body: string;
  readonly createdAt: number;
  readonly editedAt: number | null;
}

/**
 * The board event kinds this window's Activity feed draws. Every other kind
 * (Session outcomes, worktree reports, project facts) is left out rather than
 * failing the read: history outlives the build reading it.
 */
const SHOWN_EVENT_KINDS: ReadonlySet<string> = new Set<TicketEventPayload["kind"]>([
  "created",
  "status_changed",
  "priority_changed",
  "harness_changed",
  "retitled",
  "body_edited",
  "labels_changed",
  "archived",
  "unarchived",
  "commented",
  "pr_opened",
  "pr_merged",
]);

function actorKind(actor: CloudActorRow): TicketEventActorKind {
  if (actor.kind === "agent") return "session";
  if (actor.kind === "automation") return "automation";
  return "user";
}

/** A ticket's history as the Activity feed reads it, in the order the backend keeps it. */
export function projectEvents(rows: readonly CloudEventRow[]): TicketEvent[] {
  const events: TicketEvent[] = [];
  for (const row of rows) {
    const payload = row.payload as { kind?: unknown } | null;
    if (row.ticketId === null || typeof payload?.kind !== "string") continue;
    if (!SHOWN_EVENT_KINDS.has(payload.kind)) continue;
    const actor = actorKind(row.actor);
    const sessionId = row.actor.sessionId;
    events.push({
      id: row.id,
      ticketId: row.ticketId,
      actor,
      actorContext:
        actor !== "user" && typeof sessionId === "string"
          ? { sessionId, ticketId: row.actor.ticketId ?? row.ticketId }
          : null,
      createdAt: row.occurredAt,
      payload: payload as TicketEventPayload,
    });
  }
  return events;
}

/** A ticket's comments, oldest first: a person's as the user's, any other as an agent's. */
export function projectComments(rows: readonly CloudCommentRow[]): TicketComment[] {
  return rows.map((row) => ({
    id: row.id,
    ticketId: row.ticketId,
    sessionId: row.sessionId,
    actor: row.author.kind === "person" ? USER_ACTOR : `${AGENT_ACTOR_PREFIX}pi`,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.editedAt ?? row.createdAt,
  }));
}
