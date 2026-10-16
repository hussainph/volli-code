/**
 * The Board module's commands (VC-565, T13): each catalog key's handler is the
 * whole command, whichever door called it.
 *
 * A board handler owns, in one place:
 *
 * - its **clock** (`now()`), and its **attribution** (the door's `call.actor`);
 * - its **transaction**, and with a `commandId` its **receipt** in the same
 *   transaction ({@link replayBoardCommand}, {@link recordBoardCommand}):
 *   a repeat changes nothing and answers the recorded outcome with the
 *   resource as it stands now (never a row older than the cursor it names);
 * - its **wakes** (`withTicketWake`, VC-85): a ticket waiter learns of a
 *   person's write as it does of an agent's;
 * - its **materialization**: switching a ticket into worktree scope makes the
 *   checkout (VC-98), refusing the opposite switch while that runs;
 * - its **feed publication**: the committed rows, naming the `commandId`, on
 *   the Workspace's change feed (F1, T5), in the turn of the commit;
 * - its **announcement**: `data-changed` for the flag-off windows, except to
 *   the desktop window that asked, whose reply already carries the row (the
 *   one difference VC-668 documented), unless the change moved a checkout.
 *
 * Doors hold no repository and no SQLite: the desktop's legacy channels, the
 * board router (IPC bridge and WebSocket) and the agent socket's `ticket.move`
 * each invoke this map under their own policy, and nothing else.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  OperationUnavailableError,
  parseSkillModes,
  USER_ACTOR,
  type ArchivedTicket,
  type BoardChange,
  type BoardCommandReceipt,
  type DataChangeScope,
  type HandlerCall,
  type HarnessId,
  type HostHandler,
  type Label,
  type Synchronous,
  type LatestSessionSignal,
  type ModelSelection,
  type Project,
  type ProjectFolderState,
  type Ticket,
  type TicketComment,
  type TicketEvent,
  type TicketPriority,
  type TicketStatus,
  type TicketStatusEntry,
  type TicketSummary,
} from "@volli/shared";

import type { DetachedWorkPort } from "../detached-work";
import { hostLogger } from "../log/root";
import { deleteComment, getComment, listComments, updateComment } from "../db/comments-repo";
import { listTicketEvents, listTicketStatusEntries } from "../db/events-repo";
import { getLabel, listLabelsByProject, listTicketLabels, setLabelColor } from "../db/labels-repo";
import {
  getProjectById,
  updateProjectBaseBranch,
  updateProjectSessionDefaults,
  updateProjectSetupCommand,
  updateProjectSkillModes,
} from "../db/projects-repo";
import {
  getTicket,
  getTicketBody,
  getTicketRow,
  listArchivedTicketsByProject,
  listTicketRosterByProject,
  listTicketsByProject,
} from "../db/tickets-repo";
import { withTransaction } from "../db/transaction-gate";
import type { HostEventBus } from "../ports/events";
import { removeTicketToolOutput } from "../pi-tool-output";
import { inspectProjectFolder, type ProbeFolder } from "../project-relink";
import {
  archiveTicketCommand,
  createTicketCommand,
  createTicketCommentCommand,
  deleteTicketCommand,
  setTicketLabelsCommand,
  setTicketPriorityCommand,
  unarchiveTicketCommand,
  updateTicketFieldsCommand,
} from "../ticket-commands";
import {
  trimFinishedTicketInBackground,
  type TicketMoveCommandInput,
  type TicketMoveSeam,
} from "../ticket-move";
import { withTicketWake } from "../ticket-wake";
import { ensure } from "../worktree";
import type { BusyWorktreeSites } from "../worktree/activity";
import { getWorktreeSnapshots } from "../worktree/snapshot";
import type { WorktreePorts } from "../worktree/types";
import type { BoardChangeFeed, BoardFeedBatch } from "./change-feed";
import { recordBoardCommand, replayBoardCommand, replayOrphanedBoardCommand } from "./receipts";

const boardLog = hostLogger("board");

/** A write's optional idempotency key: the board router always sends one, legacy IPC never. */
export interface BoardCommandId {
  readonly commandId?: string;
}

/**
 * What every board write answers besides its row: its receipt, when it
 * carried a `commandId`, and the Workspace feed's cursor through which its
 * effect is stamped (as `throughSequence` is a Session's, HP § Commands): a
 * Client that has applied the feed through it holds the write (T5).
 */
export interface BoardWriteResult {
  readonly receipt: BoardCommandReceipt | null;
  readonly throughCursor: string;
}

export interface BoardProjectInput {
  readonly projectId: string;
}

export interface BoardTicketInput {
  readonly ticketId: string;
}

export interface BoardCommentInput {
  readonly commentId: string;
}

export interface BoardSnapshot {
  readonly project: Project;
  readonly tickets: Ticket[];
  readonly labels: Label[];
  /** The feed cursor these rows reflect: subscribe after it. */
  readonly cursor: string;
}

export interface BoardRoster {
  readonly tickets: TicketSummary[];
  readonly labels: Label[];
  readonly cursor: string;
}

export interface BoardCreateTicketInput extends BoardCommandId {
  readonly projectId: string;
  readonly status: TicketStatus;
  readonly title: string;
  readonly priority?: TicketPriority;
  readonly body?: string;
  readonly labels?: string[];
  readonly usesWorktree?: boolean;
  readonly preferredHarnessId?: HarnessId;
  readonly baseBranch?: string | null;
}

export interface BoardUpdateTicketInput extends BoardCommandId {
  readonly ticketId: string;
  readonly title?: string;
  readonly body?: string;
  /** A host path: the desktop's own window may set it; the board router never offers it. */
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
  readonly baseBranch?: string | null;
  readonly usesWorktree?: boolean;
}

/** A subscription's sink, as the handler map names it. */
export interface BoardFeedSink {
  emit(batch: BoardFeedBatch): void | Promise<void>;
  fail(error: unknown): void;
}

/**
 * A handler that answers in the caller's turn: a board command is a
 * synchronous repository write (VC-551), so its legacy channel's reply stays
 * synchronous. Narrower than `HostHandler`, which every door accepts.
 */
export type SyncHandler<Input, Output> = (input: Input, call: HandlerCall) => Output;

/** Every board handler's signature, by catalog key. */
export interface BoardHandlerSignatures {
  /** The column-only move both doors serve (VC-668), its rows on the feed. */
  readonly "ticket.move": HostHandler<TicketMoveCommandInput, Ticket[]>;
  readonly "board.snapshot": SyncHandler<BoardProjectInput, BoardSnapshot>;
  readonly "board.roster": SyncHandler<BoardProjectInput, BoardRoster>;
  readonly "board.changes": (
    input: BoardProjectInput & { readonly after: string | null },
    call: HandlerCall,
    sink: BoardFeedSink,
  ) => Promise<() => void>;
  readonly "board.projectFolder": HostHandler<
    BoardProjectInput,
    { path: string; state: ProjectFolderState }
  >;
  readonly "board.ticketBody": SyncHandler<BoardTicketInput, { body: string }>;
  readonly "board.archivedTickets": SyncHandler<BoardProjectInput, ArchivedTicket[]>;
  readonly "board.ticketEvents": SyncHandler<BoardTicketInput, TicketEvent[]>;
  readonly "board.latestSignals": HostHandler<BoardProjectInput, readonly LatestSessionSignal[]>;
  readonly "board.statusEntries": SyncHandler<BoardProjectInput, TicketStatusEntry[]>;
  readonly "board.comments": SyncHandler<BoardTicketInput, TicketComment[]>;
  readonly "board.updateProject": SyncHandler<
    BoardProjectInput &
      BoardCommandId & { baseBranch: string | null; setupCommand?: string | null },
    BoardWriteResult & { project: Project }
  >;
  readonly "board.setSkillModes": SyncHandler<
    BoardProjectInput & BoardCommandId & { modes: Record<string, string> },
    BoardWriteResult & { project: Project }
  >;
  readonly "board.setSessionDefaults": SyncHandler<
    BoardProjectInput & BoardCommandId & { model: ModelSelection | null },
    BoardWriteResult & { project: Project }
  >;
  readonly "board.createTicket": SyncHandler<
    BoardCreateTicketInput,
    BoardWriteResult & { ticket: Ticket }
  >;
  readonly "board.moveTickets": HostHandler<
    TicketMoveCommandInput & BoardCommandId,
    BoardWriteResult & { tickets: Ticket[] }
  >;
  readonly "board.setPriority": SyncHandler<
    BoardTicketInput & BoardCommandId & { priority: TicketPriority },
    BoardWriteResult & { ticket: Ticket }
  >;
  readonly "board.updateTicket": HostHandler<
    BoardUpdateTicketInput,
    BoardWriteResult & { ticket: Ticket }
  >;
  readonly "board.setLabels": SyncHandler<
    BoardTicketInput & BoardCommandId & { labels: string[] },
    BoardWriteResult & { ticket: Ticket }
  >;
  readonly "board.archiveTicket": SyncHandler<BoardTicketInput & BoardCommandId, BoardWriteResult>;
  readonly "board.unarchiveTicket": SyncHandler<
    BoardTicketInput & BoardCommandId,
    BoardWriteResult & { ticket: Ticket }
  >;
  readonly "board.deleteTicket": SyncHandler<BoardTicketInput & BoardCommandId, BoardWriteResult>;
  readonly "board.createComment": SyncHandler<
    BoardTicketInput & BoardCommandId & { body: string; sessionId?: string | null },
    BoardWriteResult & { comment: TicketComment }
  >;
  readonly "board.updateComment": SyncHandler<
    BoardCommentInput & BoardCommandId & { body: string },
    BoardWriteResult & { comment: TicketComment }
  >;
  readonly "board.removeComment": SyncHandler<BoardCommentInput & BoardCommandId, BoardWriteResult>;
  readonly "board.setLabelColor": SyncHandler<
    { labelId: string; color: string | null } & BoardCommandId,
    BoardWriteResult & { label: Label }
  >;
}

/** The services the Board module's commands are built from. */
export interface BoardCommandOptions {
  /** The host's database, or null when it did not open: every board command answers unavailable. */
  readonly db: Database.Database | null;
  readonly now: () => number;
  readonly events: HostEventBus;
  readonly feed: BoardChangeFeed;
  /** The worktree bundle a materialization and an archive's trim run through. */
  readonly worktree: (db: Database.Database) => WorktreePorts;
  readonly busyWorktreeSites: BusyWorktreeSites;
  readonly detachedWork?: DetachedWorkPort;
  /** The Session ledger's latest outcome per ticket, or null on a host without one. */
  readonly ticketSignals: ((projectId: string) => Promise<readonly LatestSessionSignal[]>) | null;
  /** Where Pi keeps saved tool output (VC-469); absent: nothing to release. */
  readonly piSessionsDirectory?: string;
  /** Test seam for the folder check. */
  readonly probeFolder?: ProbeFolder;
  /**
   * The one deliberate move (VC-629) both move keys reach (`ticket.move`,
   * `board.moveTickets`): its write, wakes, Done trim, armed arrival and
   * interrupts. The Board module adds its receipt and its feed rows through
   * the seam, which the move must run: the receipt inside its transaction,
   * the feed rows after COMMIT and before any wake.
   */
  readonly move: (
    input: TicketMoveCommandInput,
    call: HandlerCall,
    seam: TicketMoveSeam,
  ) => Ticket[] | Promise<Ticket[]>;
}

const BOARD_UNAVAILABLE = "The board is unavailable: the database did not open";
const SIGNALS_UNAVAILABLE = "Ticket signals are unavailable on this host";

/**
 * Tickets whose worktree is being materialized right now (VC-98): a
 * concurrent switch back out of worktree scope is refused until it lands, or
 * the stamp would land on a ticket scoped to the main checkout. Host-wide,
 * because every door reaches the one command.
 */
const materializingWorktrees = new Set<string>();

function withWorkspace(
  prior: { readonly reply: unknown } | undefined,
  workspaceId: string,
): { readonly reply: unknown; readonly workspaceId: string } | undefined {
  return prior === undefined ? undefined : { reply: prior.reply, workspaceId };
}

function receiptOf(commandId: string | undefined, replayed: boolean): BoardCommandReceipt | null {
  return commandId === undefined ? null : { commandId, status: "completed", replayed };
}

/** The labels a ticket names, as rows: a write that named a new label created it. */
function labelChanges(db: Database.Database, ticket: Ticket, commandId?: string): BoardChange[] {
  return listTicketLabels(db, ticket.id).map((label): BoardChange => ({
    kind: "label",
    op: "upsert",
    id: label.id,
    projectId: label.projectId,
    label,
    commandId,
  }));
}

/** A replay's answer for a ticket: the row as it stands, or today's refusal. */
function currentTicket(db: Database.Database, ticketId: string): Ticket {
  const row = getTicket(db, ticketId);
  if (row === undefined) throw new Error("Unknown ticket");
  return row;
}

/** A replay's answer for a comment: the row as it stands, or today's refusal. */
function currentComment(db: Database.Database, commentId: string): TicketComment {
  const row = getComment(db, commentId);
  if (row === undefined) throw new Error("Unknown comment");
  return row;
}

/** A roster row: the ticket without its body (VC-387). */
export function ticketSummary(ticket: Ticket): TicketSummary {
  const { body: _body, ...summary } = ticket;
  return summary;
}

/** Builds the Board module's handlers from the host's services. */
export function createBoardHandlers(options: BoardCommandOptions): BoardHandlerSignatures {
  const { feed, now } = options;
  const board = (): Database.Database => {
    if (options.db === null) throw new OperationUnavailableError(BOARD_UNAVAILABLE);
    return options.db;
  };

  /**
   * Tells the flag-off windows, never twice on the feed. The desktop window
   * that asked holds the answer already, unless the change moved a checkout
   * (whose venue every reader re-measures).
   */
  const announce = (call: HandlerCall, change: DataChangeScope, always = false): void => {
    if (call.origin === "desktop-window" && !always) return;
    feed.untapped(() => options.events.publish("data-changed", change));
  };

  /**
   * One recorded write. A repeated `commandId` with the same intent runs
   * nothing and answers `current` (the resource as it stands now, read in the
   * turn of the cursor it answers with; it refuses as today when the resource
   * is gone), or the recorded value for a write whose answer names no row.
   * Otherwise `write` runs in one transaction with the receipt, inside the
   * ticket's wake when it names one, and `committed` publishes after COMMIT.
   * `workspaceId` null means the resource is gone: only a repeat of the
   * command that removed it can still answer, from its receipt; anything else
   * runs `write`, which refuses.
   */
  function recorded<Value>(
    spec: {
      readonly operation: string;
      readonly workspaceId: string | null;
      readonly input: BoardCommandId;
      readonly wakeTicketId?: string;
      readonly current?: (db: Database.Database, answered: NoInfer<Value>) => NoInfer<Value>;
    },
    write: (db: Database.Database) => Value,
    committed: (value: Value, workspaceId: string) => void,
  ): { receipt: BoardCommandReceipt | null; value: Value; throughCursor: string } {
    const db = board();
    const { commandId, ...intent } = spec.input;
    if (commandId !== undefined) {
      const prior: { readonly reply: unknown; readonly workspaceId: string } | undefined =
        spec.workspaceId === null
          ? replayOrphanedBoardCommand(db, { commandId, operation: spec.operation, intent }, now())
          : withWorkspace(
              replayBoardCommand(
                db,
                { workspaceId: spec.workspaceId, commandId, operation: spec.operation, intent },
                now(),
              ),
              spec.workspaceId,
            );
      if (prior !== undefined) {
        const reply = prior.reply as Value;
        return {
          receipt: receiptOf(commandId, true),
          value: spec.current === undefined ? reply : spec.current(db, reply),
          throughCursor: feed.cursor(prior.workspaceId),
        };
      }
    }
    // A resource that is gone refuses inside `write`, with today's message.
    const workspaceId = spec.workspaceId ?? "";
    const transact = (): Value =>
      withTransaction(db, () => {
        const value = write(db);
        if (commandId !== undefined) {
          recordBoardCommand(
            db,
            { workspaceId, commandId, operation: spec.operation, intent },
            value,
            now(),
          );
        }
        // Every board write is a synchronous repository write (VC-551).
        return value as Synchronous<Value>;
      });
    const value =
      spec.wakeTicketId === undefined
        ? transact()
        : withTicketWake(db, spec.wakeTicketId, transact);
    committed(value, workspaceId);
    return {
      receipt: receiptOf(commandId, false),
      value,
      throughCursor: feed.cursor(workspaceId),
    };
  }

  /** The Workspace a ticket belongs to, for its receipt key; null when it is gone. */
  const workspaceOfTicket = (ticketId: string): string | null =>
    getTicketRow(board(), ticketId)?.project_id ?? null;

  const ticketChanges = (
    ticket: Ticket,
    commandId: string | undefined,
    extra: { checkoutMoved?: boolean } = {},
  ): BoardChange[] => [
    {
      kind: "ticket",
      op: "upsert",
      id: ticket.id,
      projectId: ticket.projectId,
      ticket: ticketSummary(ticket),
      ...(commandId === undefined ? {} : { commandId }),
      ...extra,
    },
    {
      kind: "ticketEvent",
      op: "upsert",
      id: ticket.id,
      projectId: ticket.projectId,
      ticketId: ticket.id,
      ...(commandId === undefined ? {} : { commandId }),
    },
  ];

  const projectWrite = (
    operation: string,
    input: BoardProjectInput & BoardCommandId,
    call: HandlerCall,
    write: (db: Database.Database) => Project | undefined,
  ) => {
    const {
      receipt,
      throughCursor,
      value: project,
    } = recorded(
      {
        operation,
        workspaceId: input.projectId,
        input,
        current: (db) => {
          const row = getProjectById(db, input.projectId);
          if (row === undefined) throw new Error("Unknown project");
          return row;
        },
      },
      (db) => {
        const updated = write(db);
        if (updated === undefined) throw new Error("Unknown project");
        return updated;
      },
      (updated) => {
        feed.stamp(updated.id, [
          {
            kind: "project",
            op: "upsert",
            id: updated.id,
            projectId: updated.id,
            project: updated,
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
          },
        ]);
        announce(call, { projectId: updated.id });
      },
    );
    return { receipt, throughCursor, project };
  };

  const ticketWrite = (
    operation: string,
    input: BoardTicketInput & BoardCommandId,
    call: HandlerCall,
    write: (db: Database.Database) => Ticket,
    withLabels = false,
  ) => {
    const {
      receipt,
      throughCursor,
      value: ticket,
    } = recorded(
      {
        operation,
        workspaceId: workspaceOfTicket(input.ticketId),
        input,
        wakeTicketId: input.ticketId,
        current: (db) => currentTicket(db, input.ticketId),
      },
      write,
      (written) => {
        feed.stamp(written.projectId, [
          ...(withLabels ? labelChanges(board(), written, input.commandId) : []),
          ...ticketChanges(written, input.commandId),
        ]);
        announce(call, { ticketId: written.id, projectId: written.projectId, kind: "ticket" });
      },
    );
    return { receipt, throughCursor, ticket };
  };

  /** Drops a finished ticket's saved tool output (VC-469); nobody asked, so a failure is logged. */
  const releaseToolOutput = (db: Database.Database, ticketId: string): void => {
    if (options.piSessionsDirectory === undefined) return;
    try {
      removeTicketToolOutput(db, options.piSessionsDirectory, ticketId);
    } catch (error) {
      boardLog.warn("could not remove a ticket's saved tool output", { ticketId, error });
    }
  };

  const commentWorkspace = (commentId: string): string | null => {
    const comment = getComment(board(), commentId);
    return comment === undefined ? null : workspaceOfTicket(comment.ticketId);
  };

  return {
    "ticket.move": (input, call) => movedWithFeed(board(), input, call, undefined),

    "board.snapshot": ({ projectId }) => {
      const db = board();
      const project = getProjectById(db, projectId);
      if (project === undefined) throw new Error("Unknown project");
      return {
        project,
        tickets: listTicketsByProject(db, projectId),
        labels: listLabelsByProject(db, projectId),
        cursor: feed.cursor(projectId),
      };
    },

    // An unknown project is refused rather than answered empty: an empty
    // roster would clear a live slice off a board (VC-387).
    "board.roster": ({ projectId }) => {
      const db = board();
      if (getProjectById(db, projectId) === undefined) throw new Error("Unknown project");
      return {
        tickets: listTicketRosterByProject(db, projectId),
        labels: listLabelsByProject(db, projectId),
        cursor: feed.cursor(projectId),
      };
    },

    "board.changes": async ({ projectId, after }, _call, sink) => {
      board();
      return feed.subscribe(
        projectId,
        after,
        (batch) => {
          void sink.emit(batch);
        },
        // The feed ended under the subscription (an epoch change, or the
        // Workspace removed): the Client resnapshots.
        (error) => sink.fail(error),
      );
    },

    "board.projectFolder": async ({ projectId }) => {
      const report = await inspectProjectFolder(board(), projectId, options.probeFolder);
      if (!report.ok) throw new Error(report.error);
      return { path: report.path, state: report.state };
    },

    "board.ticketBody": ({ ticketId }) => {
      const body = getTicketBody(board(), ticketId);
      if (body === undefined) throw new Error("Unknown ticket");
      return { body };
    },

    "board.archivedTickets": ({ projectId }) => listArchivedTicketsByProject(board(), projectId),
    "board.ticketEvents": ({ ticketId }) => listTicketEvents(board(), ticketId),
    "board.latestSignals": async ({ projectId }) => {
      board();
      if (options.ticketSignals === null) throw new OperationUnavailableError(SIGNALS_UNAVAILABLE);
      return [...(await options.ticketSignals(projectId))];
    },
    "board.statusEntries": ({ projectId }) => listTicketStatusEntries(board(), projectId),
    "board.comments": ({ ticketId }) => listComments(board(), ticketId),

    "board.updateProject": (input, call) =>
      projectWrite("board.updateProject", input, call, (db) => {
        const at = now();
        let project = updateProjectBaseBranch(db, input.projectId, input.baseBranch, at);
        if (project === undefined || input.setupCommand === undefined) return project;
        // Trim-to-null on empty, like the ticket's worktree identity fields:
        // an empty command means "skip the setup step".
        const trimmed = input.setupCommand === null ? null : input.setupCommand.trim();
        project = updateProjectSetupCommand(
          db,
          input.projectId,
          trimmed === "" ? null : trimmed,
          at,
        );
        return project;
      }),

    // `updateProjectSkillModes` normalises again, so an unknown mode or an
    // unspellable slug that cleared the door still cannot reach the column.
    "board.setSkillModes": (input, call) =>
      projectWrite("board.setSkillModes", input, call, (db) =>
        updateProjectSkillModes(db, input.projectId, parseSkillModes(input.modes), now()),
      ),

    "board.setSessionDefaults": (input, call) =>
      projectWrite("board.setSessionDefaults", input, call, (db) =>
        updateProjectSessionDefaults(db, input.projectId, { model: input.model }, now()),
      ),

    "board.createTicket": (input, call) => {
      const ticketId = randomUUID();
      const {
        receipt,
        throughCursor,
        value: ticket,
      } = recorded(
        {
          operation: "board.createTicket",
          workspaceId: input.projectId,
          input,
          wakeTicketId: ticketId,
          current: (db, answered: Ticket) => currentTicket(db, answered.id),
        },
        (db) =>
          createTicketCommand(
            db,
            {
              id: ticketId,
              projectId: input.projectId,
              title: input.title,
              status: input.status,
              priority: input.priority,
              body: input.body,
              labels: input.labels,
              usesWorktree: input.usesWorktree,
              preferredHarnessId: input.preferredHarnessId,
              baseBranch: input.baseBranch,
            },
            { now: now(), actor: call.actor },
          ),
        (created) => {
          feed.stamp(created.projectId, [
            ...labelChanges(board(), created, input.commandId),
            ...ticketChanges(created, input.commandId),
          ]);
          announce(call, { ticketId: created.id, projectId: created.projectId, kind: "ticket" });
        },
      );
      return { receipt, throughCursor, ticket };
    },

    "board.moveTickets": (input, call) => {
      const db = board();
      const { commandId, ...move } = input;
      const key = (id: string) => ({
        workspaceId: input.projectId,
        commandId: id,
        operation: "board.moveTickets",
        intent: move,
      });
      // A repeated move changes nothing: it answers the board as it stands.
      if (commandId !== undefined && replayBoardCommand(db, key(commandId), now()) !== undefined) {
        return {
          receipt: receiptOf(commandId, true),
          throughCursor: feed.cursor(input.projectId),
          tickets: listTicketsByProject(db, input.projectId),
        };
      }
      // The receipt commits in the move's own transaction, so the two are
      // durable together, and before any wake, notice or interrupt the move
      // sets off: a retry those reach (or that arrives while an interrupt is
      // awaited) replays rather than moving again.
      const moved = movedWithFeed(
        db,
        move,
        call,
        commandId,
        commandId === undefined
          ? undefined
          : () => recordBoardCommand(db, key(commandId), null, now()),
      );
      const throughCursor = feed.cursor(input.projectId);
      const answer = (tickets: Ticket[]) => ({
        receipt: receiptOf(commandId, false),
        throughCursor,
        tickets,
      });
      return moved instanceof Promise ? moved.then(answer) : answer(moved);
    },

    "board.setPriority": (input, call) =>
      ticketWrite("board.setPriority", input, call, (db) =>
        setTicketPriorityCommand(db, input, { now: now(), actor: call.actor }),
      ),

    "board.updateTicket": (input, call) => {
      const db = board();
      // The one write that can race a previous call's `ensure`: switching
      // scope back off before the identity stamp lands. Refused rather than
      // queued, while it finishes. Re-asserting `true` passes through.
      if (input.usesWorktree === false && materializingWorktrees.has(input.ticketId)) {
        throw new Error(
          "The ticket's worktree is still being created, so its worktree scoping can't change yet. Try again once it's ready.",
        );
      }
      // Read before the write: only the transition materializes.
      const before = getTicketRow(db, input.ticketId);
      const { commandId: _commandId, ...fields } = input;
      const result = ticketWrite("board.updateTicket", input, call, (database) =>
        updateTicketFieldsCommand(database, fields, { now: now(), actor: call.actor }),
      );
      const { ticket } = result;
      const switchedOn =
        before !== undefined && before.uses_worktree === 0 && ticket.usesWorktree === true;
      if (switchedOn && result.receipt?.replayed !== true) {
        return materialize(db, ticket, call, input.commandId).then((materialized) => ({
          receipt: result.receipt,
          // Through the materialization's own stamp, not just the field write's.
          throughCursor: feed.cursor(materialized.projectId),
          ticket: materialized,
        }));
      }
      // Switching off moves the Session destination to the main checkout, with
      // nothing async behind it: venue readers stop waiting on a checkout that
      // will never arrive (VC-286). Only the transition says so.
      const switchedOff =
        before !== undefined && before.uses_worktree !== 0 && ticket.usesWorktree === false;
      if (switchedOff && result.receipt?.replayed !== true) {
        feed.stamp(ticket.projectId, [
          { ...ticketChanges(ticket, input.commandId, { checkoutMoved: true })[0]! },
        ]);
        announce(
          call,
          { ticketId: ticket.id, projectId: ticket.projectId, kind: "worktree" },
          true,
        );
        return { ...result, throughCursor: feed.cursor(ticket.projectId) };
      }
      return result;
    },

    "board.setLabels": (input, call) =>
      ticketWrite(
        "board.setLabels",
        input,
        call,
        (db) => setTicketLabelsCommand(db, input, { now: now(), actor: call.actor }),
        true,
      ),

    "board.archiveTicket": (input, call) => {
      const db = board();
      const row = getTicketRow(db, input.ticketId);
      // Today's refusal, before anything is read for the receipt.
      if (row === undefined) throw new Error("Unknown ticket");
      const projectId = row.project_id;
      const { receipt, throughCursor } = recorded(
        {
          operation: "board.archiveTicket",
          workspaceId: projectId,
          input,
          wakeTicketId: input.ticketId,
        },
        (database) => {
          archiveTicketCommand(database, input.ticketId, { now: now(), actor: call.actor });
          return null;
        },
        () => {
          releaseToolOutput(db, input.ticketId);
          // An archive keeps the checkout, which makes an archived ticket the
          // longest-lived carrier of a dead dependency tree (VC-340).
          trimFinishedTicketInBackground(
            {
              worktree: options.worktree(db),
              now,
              detachedWork: options.detachedWork,
              busySites: options.busyWorktreeSites,
              onMutation: (change) => {
                feed.stamp(projectId, [
                  {
                    kind: "ticket",
                    op: "upsert",
                    id: input.ticketId,
                    projectId,
                    checkoutMoved: true,
                  },
                ]);
                announce(call, change, true);
              },
            },
            input.ticketId,
            projectId,
          );
          feed.stamp(projectId, [
            {
              kind: "ticket",
              op: "delete",
              id: input.ticketId,
              projectId,
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            },
          ]);
          announce(call, { ticketId: input.ticketId, projectId, kind: "ticket" });
        },
      );
      return { receipt, throughCursor };
    },

    "board.unarchiveTicket": (input, call) =>
      ticketWrite("board.unarchiveTicket", input, call, (db) =>
        unarchiveTicketCommand(db, input.ticketId, { now: now(), actor: call.actor }),
      ),

    // A repeat of a delete finds its ticket gone: it answers from its receipt
    // (`recorded`, with no Workspace), and anything else refuses as today.
    "board.deleteTicket": (input, call) => {
      const db = board();
      const row = getTicketRow(db, input.ticketId);
      const { receipt, throughCursor } = recorded(
        { operation: "board.deleteTicket", workspaceId: row?.project_id ?? null, input },
        (database) => {
          if (row === undefined) throw new Error("Unknown ticket");
          // Before the delete, which detaches the Sessions from the ticket, and
          // only for an archived ticket: the one kind the delete accepts.
          if (row.archived_at !== null) releaseToolOutput(database, input.ticketId);
          deleteTicketCommand(database, input.ticketId);
          return null;
        },
        (_value, projectId) => {
          feed.stamp(projectId, [
            {
              kind: "ticket",
              op: "delete",
              id: input.ticketId,
              projectId,
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            },
          ]);
          announce(call, { ticketId: input.ticketId, projectId, kind: "ticket" });
        },
      );
      return { receipt, throughCursor };
    },

    // The person's comment: the caller is the author, never an input field.
    "board.createComment": (input, call) => {
      const {
        receipt,
        throughCursor,
        value: comment,
      } = recorded(
        {
          operation: "board.createComment",
          workspaceId: workspaceOfTicket(input.ticketId),
          input,
          wakeTicketId: input.ticketId,
          current: (db, answered: TicketComment) => currentComment(db, answered.id),
        },
        (db) =>
          createTicketCommentCommand(
            db,
            {
              ticketId: input.ticketId,
              body: input.body,
              commentActor: USER_ACTOR,
              sessionId: input.sessionId,
            },
            { now: now(), actor: call.actor },
          ),
        (created, projectId) => stampComment(projectId, created, "upsert", call, input.commandId),
      );
      return { receipt, throughCursor, comment };
    },

    // An edit touches `updatedAt` only and records no event.
    "board.updateComment": (input, call) => {
      const {
        receipt,
        throughCursor,
        value: comment,
      } = recorded(
        {
          operation: "board.updateComment",
          workspaceId: commentWorkspace(input.commentId),
          input,
          current: (db) => currentComment(db, input.commentId),
        },
        (db) => {
          const updated = updateComment(
            db,
            { commentId: input.commentId, body: input.body },
            now(),
          );
          if (updated === undefined) throw new Error("Unknown comment");
          return updated;
        },
        (updated, projectId) => stampComment(projectId, updated, "upsert", call, input.commandId),
      );
      return { receipt, throughCursor, comment };
    },

    // A hard delete; no event.
    "board.removeComment": (input, call) => {
      const existing = getComment(board(), input.commentId);
      const { receipt, throughCursor } = recorded(
        { operation: "board.removeComment", workspaceId: commentWorkspace(input.commentId), input },
        (db) => {
          if (existing === undefined) throw new Error("Unknown comment");
          deleteComment(db, input.commentId);
          return null;
        },
        (_value, projectId) => stampComment(projectId, existing!, "delete", call, input.commandId),
      );
      return { receipt, throughCursor };
    },

    "board.setLabelColor": (input, call) => {
      const existing = getLabel(board(), input.labelId);
      const {
        receipt,
        throughCursor,
        value: label,
      } = recorded(
        {
          operation: "board.setLabelColor",
          workspaceId: existing?.projectId ?? null,
          input,
          current: (db) => {
            const row = getLabel(db, input.labelId);
            if (row === undefined) throw new Error("Unknown label");
            return row;
          },
        },
        (db) => {
          const updated = setLabelColor(db, input.labelId, input.color, now());
          if (updated === undefined) throw new Error("Unknown label");
          return updated;
        },
        (updated) => {
          feed.stamp(updated.projectId, [
            {
              kind: "label",
              op: "upsert",
              id: updated.id,
              projectId: updated.projectId,
              label: updated,
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            },
          ]);
          announce(call, { projectId: updated.projectId });
        },
      );
      return { receipt, throughCursor, label };
    },
  };

  function stampComment(
    projectId: string,
    comment: TicketComment,
    op: "upsert" | "delete",
    call: HandlerCall,
    commandId: string | undefined,
  ): void {
    const by = commandId === undefined ? {} : { commandId };
    feed.stamp(projectId, [
      {
        kind: "comment",
        op,
        id: comment.id,
        projectId,
        ticketId: comment.ticketId,
        ...(op === "upsert" ? { comment } : {}),
        ...by,
      },
      {
        kind: "ticketEvent",
        op: "upsert",
        id: comment.ticketId,
        projectId,
        ticketId: comment.ticketId,
        ...by,
      },
    ]);
    announce(call, { ticketId: comment.ticketId, projectId, kind: "comment" });
  }

  /**
   * The move, with the rows it moved on the feed. A move renumbers its
   * neighbours too, so the stamped rows are every roster row whose column,
   * position or stamp changed, read before and after in the move's own turn.
   */
  function movedWithFeed(
    db: Database.Database,
    input: TicketMoveCommandInput,
    call: HandlerCall,
    commandId: string | undefined,
    record?: () => void,
  ): Ticket[] | Promise<Ticket[]> {
    const before = new Map(
      listTicketRosterByProject(db, input.projectId).map((ticket) => [ticket.id, ticket]),
    );
    let recordedInMove = false;
    const moved = feed.untapped(() =>
      options.move(input, call, {
        ...(record === undefined
          ? {}
          : {
              inTransaction: () => {
                record();
                recordedInMove = true;
              },
            }),
        committed: () => stampMoved(db, input, before, commandId),
      }),
    );
    // A move port that skipped its seam would leave a committed move without
    // its receipt: a programming error, never a state to answer from.
    if (record !== undefined && !recordedInMove) {
      throw new Error("The move did not record its receipt in its transaction");
    }
    return moved;
  }

  /** Stamps every roster row the move changed, read after its COMMIT. */
  function stampMoved(
    db: Database.Database,
    input: TicketMoveCommandInput,
    before: ReadonlyMap<string, TicketSummary>,
    commandId: string | undefined,
  ): void {
    const changes: BoardChange[] = [];
    for (const ticket of listTicketRosterByProject(db, input.projectId)) {
      const prior = before.get(ticket.id);
      if (
        prior !== undefined &&
        prior.status === ticket.status &&
        prior.order === ticket.order &&
        prior.updatedAt === ticket.updatedAt
      ) {
        continue;
      }
      changes.push({
        kind: "ticket",
        op: "upsert",
        id: ticket.id,
        projectId: ticket.projectId,
        ticket,
        ...(commandId === undefined ? {} : { commandId }),
      });
      if (prior !== undefined && prior.status !== ticket.status) {
        changes.push({
          kind: "ticketEvent",
          op: "upsert",
          id: ticket.id,
          projectId: ticket.projectId,
          ticketId: ticket.id,
          ...(commandId === undefined ? {} : { commandId }),
        });
      }
    }
    feed.stamp(input.projectId, changes);
  }

  /**
   * Makes the checkout of a ticket just switched into worktree scope (VC-98).
   * Outside the field write's transaction: `ensure` is git work, and no
   * database write may straddle it. Scope is the person's recorded intent and
   * stands whatever git does; a ticket scoped to a worktree it lacks refuses
   * to bind a Session anywhere else (#38). Live bindings stay where they are.
   */
  async function materialize(
    db: Database.Database,
    committed: Ticket,
    call: HandlerCall,
    commandId: string | undefined,
  ): Promise<Ticket> {
    materializingWorktrees.add(committed.id);
    const outcome = await ensure(options.worktree(db), committed.id).finally(() => {
      materializingWorktrees.delete(committed.id);
    });
    // A checkout appeared (or the attempt left one half-made): a last-known
    // snapshot taken without one cannot describe it (VC-372).
    getWorktreeSnapshots().invalidate(committed.id);
    const ticket = getTicket(db, committed.id) ?? committed;
    // Said on both outcomes, before the answer: success has a new identity
    // stamp to show, and failure a scope flag that really did change under a
    // renderer about to revert it optimistically off the back of the error.
    feed.stamp(ticket.projectId, [
      { ...ticketChanges(ticket, commandId, { checkoutMoved: true })[0]! },
    ]);
    announce(
      call,
      { ticketId: committed.id, projectId: committed.projectId, kind: "worktree" },
      true,
    );
    if (!outcome.ok) throw new Error(`worktree scope is on, but ${outcome.error}`);
    return ticket;
  }
}
