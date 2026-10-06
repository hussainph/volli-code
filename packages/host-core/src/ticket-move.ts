/**
 * The whole deliberate ticket-move command (VC-629), independent of its door.
 * Owns the atomic write, post-commit wakes, Done trim, armed arrivals and
 * backward interrupts. IPC maps UUID/indexed drops; the socket maps display
 * ids/column-only intent. Neither adapter owns post-commit behavior.
 *
 * No new command ledger: the reply is the committed board projection, just as
 * before. Interrupt command/receipts remain owned by the Session service.
 */
import {
  displayTicketId,
  TICKET_STATUS_LABELS,
  type DeliberateMoveChoice,
  type DataChangedEvent,
  type NotificationRequest,
  type Ticket,
  type TicketEventActorKind,
  type TicketMovedNotice,
  type TicketStatus,
} from "@volli/shared";
import type { DetachedWorkPort } from "./detached-work";
import { getProjectById } from "./db/projects-repo";
import { getTicket, getTicketRow, listTicketsByProject } from "./db/tickets-repo";
import {
  interruptOnBackwardMove,
  moveTicketCommand,
  moveTicketsCommand,
  type TicketCommandContext,
} from "./ticket-commands";
import { withTransaction } from "./db/transaction-gate";
import { withTicketWake } from "./ticket-wake";
import { trimFinishedWorktree, type TrimFinishPorts } from "./worktree";
import { getWorktreeSnapshots } from "./worktree/snapshot";
import { hostLogger } from "./log/root";

const log = hostLogger("ticket-move");

export type TicketMoveCommandInput = {
  projectId: string;
  toStatus: TicketStatus;
  choice?: DeliberateMoveChoice;
} & (
  | { ticketId: string; /** Absent means column-only; same-column is a no-op. */ toIndex?: number }
  | { ticketIds: string[]; toIndex: number }
);

export interface TicketMovePorts extends TrimFinishPorts {
  interruptTicketSessions?: (ticketId: string) => string[] | Promise<string[]>;
  onDeliberateMove?: (notice: TicketMovedNotice) => void;
  onMutation?: (change: Omit<DataChangedEvent, "entity">) => void;
  notify?: (request: NotificationRequest) => unknown;
  /**
   * Where the detached Done trim enrols itself, so the host's shutdown can
   * drain it before the database closes (VC-627). Absent means untracked —
   * the trim still runs, exactly as before, but nothing waits for it.
   */
  detachedWork?: DetachedWorkPort;
}

/**
 * What a caller that keeps its own record of a move adds to it (VC-565): the
 * Board module's receipt and feed rows. `inTransaction` runs inside the
 * move's own transaction, after its write, so whatever it records commits or
 * rolls back with the move; `committed` runs after COMMIT and before any
 * wake, notice or interrupt, so nothing the move sets off can observe the
 * move without what the caller recorded.
 */
export interface TicketMoveSeam {
  readonly inTransaction?: () => void;
  readonly committed?: () => void;
}

/** The archive path shares the same best-effort trim, without being a move. */
export function trimFinishedTicketInBackground(
  ports: Pick<TicketMovePorts, "worktree" | "now" | "busySites" | "onMutation" | "detachedWork">,
  ticketId: string,
  projectId: string | undefined,
): void {
  // A committed Done move still succeeds, but missing activity evidence can
  // never authorize the detached destructive act.
  if (typeof ports.busySites !== "function") return;
  // Start now, do not put a filesystem walk on the board reply's critical path.
  // The tracked promise is the whole chain, through its own failure log, so a
  // drain waits for the trim's event write and the publish after it.
  const work = trimFinishedWorktree(ports, ticketId)
    .then((outcome) => {
      if (outcome.kind !== "trimmed") return;
      getWorktreeSnapshots().invalidate(ticketId);
      ports.onMutation?.({ ticketId, projectId, kind: "worktree" });
    })
    .catch((error: unknown) => {
      log.error("could not trim the ticket's worktree", { ticketId, error });
    });
  ports.detachedWork?.track(work);
}

function moveNotificationBody(kind: TicketEventActorKind, via: string | null): string {
  switch (kind) {
    case "automation":
      return "Moved by automation";
    case "unauthenticated":
      return "Moved by an unauthenticated caller";
    case "session":
      return via ? `Moved via ${via}'s session` : "Moved via a session";
    case "user":
      return "Moved by you";
  }
}

function recordInterruptFailure(error: unknown): void {
  log.error("failed to interrupt ticket sessions after committed move", { error });
}

export function executeTicketMove(
  ports: TicketMovePorts,
  input: TicketMoveCommandInput,
  context: TicketCommandContext,
  seam: TicketMoveSeam = {},
): Ticket[] | Promise<Ticket[]> {
  const db = ports.worktree.db;
  const ticketIds = "ticketIds" in input ? [...new Set(input.ticketIds)] : [input.ticketId];
  const before = new Map(ticketIds.map((id) => [id, getTicketRow(db, id)]));
  for (const prior of before.values()) {
    if (prior === undefined) throw new Error("Unknown ticket");
    if (prior.archived_at !== null) throw new Error("Cannot move an archived ticket");
  }
  const columnOnly = "ticketId" in input && input.toIndex === undefined;
  if (
    columnOnly &&
    before.get(input.ticketId)?.project_id === input.projectId &&
    before.get(input.ticketId)?.status === input.toStatus
  ) {
    // Nothing moves, but a caller's record of the no-op is still kept.
    if (seam.inTransaction !== undefined) withTransaction(db, seam.inTransaction);
    seam.committed?.();
    return listTicketsByProject(db, input.projectId);
  }
  const toIndex =
    input.toIndex ??
    listTicketsByProject(db, input.projectId).filter((ticket) => ticket.status === input.toStatus)
      .length;
  const writeMove = () =>
    "ticketIds" in input
      ? moveTicketsCommand(db, { ...input, toIndex }, context)
      : moveTicketCommand(db, { ...input, toIndex }, context);
  // The caller's record joins the move's transaction; its post-commit step
  // runs inside every ticket's wake, so before any wake fans out.
  const runMove = (): Ticket[] => {
    const inTransaction = seam.inTransaction;
    const moved =
      inTransaction === undefined
        ? writeMove()
        : withTransaction(db, () => {
            const written = writeMove();
            inTransaction();
            return written;
          });
    seam.committed?.();
    return moved;
  };
  const tickets = ticketIds.reduceRight<() => Ticket[]>(
    (write, ticketId) => () => withTicketWake(db, ticketId, write),
    runMove,
  )();
  const after = new Map(ticketIds.map((id) => [id, getTicketRow(db, id)]));

  for (const ticketId of ticketIds) {
    const moved = after.get(ticketId);
    if (moved?.status === "done" && before.get(ticketId)?.status !== "done") {
      trimFinishedTicketInBackground(ports, ticketId, moved.project_id);
    }
  }
  for (const ticketId of ticketIds) {
    const prior = before.get(ticketId);
    const moved = after.get(ticketId);
    if (
      prior === undefined ||
      moved === undefined ||
      prior.status === moved.status ||
      moved.status !== input.toStatus
    )
      continue;
    try {
      ports.onDeliberateMove?.({
        projectId: moved.project_id,
        ticketId,
        from: prior.status as TicketStatus,
        to: input.toStatus,
        ...(input.choice === undefined ? {} : { choice: input.choice }),
      });
    } catch (error) {
      log.error("failed to record armed-column arrival after committed move", { error });
    }
    // Operational guardrail: only non-user arrivals into Doing notify. Actor
    // policy, not transport policy, so a renderer move remains silent.
    if (input.toStatus === "doing" && context.actor.kind !== "user") {
      const project = getProjectById(db, moved.project_id)!;
      const actorTicket =
        context.actor.kind === "session" && context.actor.ticketId !== null
          ? getTicket(db, context.actor.ticketId)
          : undefined;
      const actorProject =
        actorTicket === undefined ? undefined : getProjectById(db, actorTicket.projectId);
      const via =
        actorTicket !== undefined && actorProject !== undefined
          ? displayTicketId(actorProject.ticketPrefix, actorTicket.ticketNumber)
          : null;
      ports.notify?.({
        producer: "ticket-moved-to-doing",
        title: `${displayTicketId(project.ticketPrefix, moved.ticket_number)} → ${TICKET_STATUS_LABELS[input.toStatus]}`,
        body: moveNotificationBody(context.actor.kind, via),
        target: { kind: "ticket", projectId: moved.project_id, ticketId },
      });
    }
  }
  // A column-only no-op returned above. Indexed reorders remain real writes.
  for (const ticketId of ticketIds) {
    if (after.get(ticketId)?.project_id === input.projectId) {
      ports.onMutation?.({ projectId: input.projectId, ticketId, kind: "ticket" });
    }
  }
  const pending: Promise<string[]>[] = [];
  for (const ticketId of ticketIds) {
    const prior = before.get(ticketId);
    const moved = after.get(ticketId);
    if (
      prior === undefined ||
      moved === undefined ||
      moved.project_id !== input.projectId ||
      prior.status === moved.status ||
      moved.status !== input.toStatus
    )
      continue;
    try {
      const interrupt = interruptOnBackwardMove(
        {
          ticketId,
          fromStatus: prior.status as TicketStatus,
          toStatus: input.toStatus,
        },
        ports.interruptTicketSessions,
      );
      if (interrupt instanceof Promise) pending.push(interrupt);
    } catch (error) {
      recordInterruptFailure(error);
    }
  }
  if (pending.length === 0) return tickets;
  return Promise.allSettled(pending).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") recordInterruptFailure(result.reason);
    }
    return tickets;
  });
}
