/**
 * The board, read and written through the host protocol (VC-565), with the
 * `cloud` flag on. One code path for this Mac's in-process host (over the
 * desktop's board bridge) and a remote one (over a host link): it speaks a
 * {@link BoardSyncTransport}, built from either board client.
 *
 * **What is on screen is the host's confirmed board plus this window's
 * pending writes (T5).** Per Workspace it holds:
 *
 * - **the base**: the rows the host has confirmed, from a snapshot, a roster
 *   read, or the Workspace's change feed (`board.changes`), whose changes
 *   inline the committed row and name the `commandId` behind them;
 * - **the pending layer**: every write this window has sent and not yet seen
 *   confirmed, keyed by the `commandId` it minted for it, each an optimistic
 *   edit replayed over the base, in the order it was made.
 *
 * A write's reply names the feed cursor its effect was stamped through
 * (`throughCursor`). Its pending edit retires once the feed has delivered
 * that cursor, so the base already holds the effect: never earlier (the card
 * would jump back until the feed caught up) and never later (a read in
 * between cannot overwrite it, because the edit is still replayed over
 * whatever the base became). That replaces the move lane's
 * last-snapshot-wins overwrite, and with it the rubber band.
 *
 * - **An ambiguous outcome retries with the same id.** A write whose answer
 *   never came (`host-unreachable`, a closed request, a dead bridge) is sent
 *   again under its `commandId`; the host's receipt answers a repeat without a
 *   second effect. Only a definitive refusal drops the edit and says why.
 * - **A created ticket shows at once**, as a placeholder that the confirmed
 *   row replaces.
 * - **One read per burst.** A change with no row (another writer the host
 *   only knows by its `data-changed`) asks for a roster read; reads coalesce
 *   over a short window, and one read runs at a time with at most one queued
 *   behind it. Changes the feed delivers while a read is in flight are
 *   replayed over its answer, so a slow read never moves the board backwards.
 *
 * Nothing here persists: the host is the source of truth, and this is the
 * in-memory last-known view (D-C1).
 */
import {
  moveTicket as moveTicketOp,
  moveTickets as moveTicketsOp,
  TICKET_STATUSES,
  type ArchivedTicket,
  type BoardChange,
  type DeliberateMoveChoice,
  type HarnessId,
  type Label,
  type Project,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
  type TicketSummary,
} from "@volli/shared";

/** A board write's receipt: the host accepted this `commandId`. */
export interface BoardWriteReceipt {
  readonly commandId: string;
  readonly status: "completed";
  readonly replayed: boolean;
}

/** What every board write answers: its receipt, and the feed cursor its effect was stamped through. */
export interface BoardWriteAnswer {
  readonly receipt: BoardWriteReceipt;
  readonly throughCursor: string;
}

/** One feed delivery: the changes stamped through `cursor`. */
export interface BoardFeedBatch {
  readonly cursor: string;
  readonly changes: readonly BoardChange[];
}

/**
 * What the sync engine asks of a host: the board router's operations it
 * uses, as plain calls. {@link boardSyncTransport} builds one from a board
 * client over either link; tests build one over a fake host.
 */
export interface BoardSyncTransport {
  snapshot(projectId: string): Promise<{
    project: Project;
    tickets: Ticket[];
    labels: Label[];
    cursor: string;
  }>;
  roster(projectId: string): Promise<{ tickets: TicketSummary[]; labels: Label[]; cursor: string }>;
  /**
   * Follows the feed after `lastEventId`. `onResnapshot`: the cursor cannot
   * resume (host restart, retention); `onError`: anything else that ended it.
   */
  changes(
    projectId: string,
    lastEventId: string,
    handlers: {
      onBatch(batch: BoardFeedBatch): void;
      onResnapshot(): void;
      onError(error: unknown): void;
    },
  ): () => void;
  createTicket(input: {
    commandId: string;
    projectId: string;
    status: TicketStatus;
    title: string;
    priority?: TicketPriority;
    body?: string;
    labels?: string[];
    usesWorktree?: boolean;
    preferredHarnessId?: HarnessId;
    baseBranch?: string | null;
  }): Promise<BoardWriteAnswer & { ticket: Ticket }>;
  moveTickets(input: {
    commandId: string;
    projectId: string;
    ticketIds: string[];
    toStatus: TicketStatus;
    toIndex: number;
    choice?: DeliberateMoveChoice;
  }): Promise<BoardWriteAnswer>;
  setPriority(input: {
    commandId: string;
    ticketId: string;
    priority: TicketPriority;
  }): Promise<BoardWriteAnswer & { ticket: Ticket }>;
  updateTicket(input: {
    commandId: string;
    ticketId: string;
    title?: string;
    body?: string;
    branch?: string | null;
    baseBranch?: string | null;
    usesWorktree?: boolean;
  }): Promise<BoardWriteAnswer & { ticket: Ticket }>;
  setLabels(input: {
    commandId: string;
    ticketId: string;
    labels: string[];
  }): Promise<BoardWriteAnswer & { ticket: Ticket }>;
  setLabelColor(input: {
    commandId: string;
    labelId: string;
    color: string | null;
  }): Promise<BoardWriteAnswer & { label: Label }>;
  archiveTicket(input: { commandId: string; ticketId: string }): Promise<BoardWriteAnswer>;
  unarchiveTicket(input: {
    commandId: string;
    ticketId: string;
  }): Promise<BoardWriteAnswer & { ticket: Ticket }>;
  deleteTicket(input: { commandId: string; ticketId: string }): Promise<BoardWriteAnswer>;
  archivedTickets(projectId: string): Promise<ArchivedTicket[]>;
}

/** Where the engine paints, and what it tells the rest of the renderer. */
export interface BoardSyncView {
  /** Paints one Workspace's board: the tickets and labels on screen, and which bodies are placeholders. */
  paint(
    projectId: string,
    tickets: Ticket[],
    labels: Label[],
    unloadedBodies: ReadonlySet<string>,
  ): void;
  /** A committed project row arrived on the feed. */
  adoptProject(project: Project): void;
  /** Per-ticket surfaces (activity, body) re-read what the board does not hold. */
  notePlanningChange(change: { ticketId?: string; projectId?: string }): void;
  /** A change moved where a ticket's Sessions run: its venue reading is stale. */
  checkoutMoved(ticketId: string): void;
  /** A write failed for good: say so (CLAUDE.md, never swallow a failed mutation). */
  failed(message: string): void;
}

export interface BoardSyncOptions {
  readonly transport: BoardSyncTransport;
  readonly view: BoardSyncView;
  readonly mintCommandId?: () => string;
  readonly now?: () => number;
  /** How long rowless changes coalesce before their one roster read. */
  readonly readCoalesceMs?: number;
  /** Delays between retries of an ambiguous write, last repeated; then it gives up. */
  readonly retryDelaysMs?: readonly number[];
  readonly maxAttempts?: number;
  /** Delays between re-subscribes after a feed that ended in error. */
  readonly feedRetryDelaysMs?: readonly number[];
  /** How long a committed write waits for its cursor on the feed before a read confirms it. */
  readonly confirmTimeoutMs?: number;
  /** Whether a failure's outcome is unknown, so the write is retried under its id. */
  readonly isAmbiguous?: (error: unknown) => boolean;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

interface Pending {
  readonly projectId: string;
  /** Cleared once the feed has delivered this write's own rows: the base holds its effect. */
  tickets?: (view: Ticket[]) => Ticket[];
  labels?: (view: Label[]) => Label[];
  /** Set by the reply: the feed cursor that confirms this write. */
  throughCursor?: string;
  /** This window's order of replies, so a read started after it is known to include it. */
  committedAt?: number;
  confirmTimer?: unknown;
}

interface Workspace {
  readonly tickets: Map<string, TicketSummary>;
  readonly labels: Map<string, Label>;
  /** Feed cursors this window has applied (a bounded recent window). */
  readonly seen: string[];
  cursor: string | null;
  stop: (() => void) | null;
  feedFailures: number;
  /** Batches applied while a roster read is in flight, replayed over its answer. */
  readLog: BoardFeedBatch[] | null;
  readTimer: unknown;
  reading: boolean;
  readAgain: boolean;
  closed: boolean;
}

/** How many applied cursors a Workspace remembers to confirm writes against. */
const SEEN_CURSORS = 512;
const STATUS_RANK = new Map<TicketStatus, number>(
  TICKET_STATUSES.map((status, index) => [status, index]),
);

/**
 * Whether a write's outcome is unknown: the host may or may not have taken
 * it. The board client's links answer an unknown outcome
 * `SERVICE_UNAVAILABLE` (`host-unreachable`), an abandoned call
 * `CLIENT_CLOSED_REQUEST`, and a timeout `TIMEOUT`; an error with no host
 * envelope at all never reached a host that could refuse it.
 */
export function isAmbiguousBoardFailure(error: unknown): boolean {
  const hostError = (error as { data?: { hostError?: { code?: unknown } } } | null)?.data
    ?.hostError;
  if (hostError === undefined || hostError === null) return true;
  return (
    hostError.code === "SERVICE_UNAVAILABLE" ||
    hostError.code === "CLIENT_CLOSED_REQUEST" ||
    hostError.code === "TIMEOUT"
  );
}

function failureMessage(error: unknown): string {
  const hostError = (error as { data?: { hostError?: { message?: unknown } } } | null)?.data
    ?.hostError;
  if (typeof hostError?.message === "string") return hostError.message;
  return error instanceof Error ? error.message : String(error);
}

/** A ticket as the board paints it: column order, then position. */
function byColumn(left: TicketSummary, right: TicketSummary): number {
  const rank = STATUS_RANK.get(left.status)! - STATUS_RANK.get(right.status)!;
  return rank !== 0 ? rank : left.order - right.order;
}

/** The id a placeholder ticket carries until its confirmed row replaces it. */
export function placeholderTicketId(commandId: string): string {
  return `pending:${commandId}`;
}

/** The board's sync engine for every Workspace this window follows. */
export class BoardSync {
  readonly #transport: BoardSyncTransport;
  readonly #view: BoardSyncView;
  readonly #mint: () => string;
  readonly #now: () => number;
  readonly #readCoalesceMs: number;
  readonly #retryDelays: readonly number[];
  readonly #maxAttempts: number;
  readonly #feedRetryDelays: readonly number[];
  readonly #confirmTimeoutMs: number;
  readonly #isAmbiguous: (error: unknown) => boolean;
  readonly #setTimer: (run: () => void, ms: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  readonly #workspaces = new Map<string, Workspace>();
  /** Every ticket body this window has read: a roster row carries none (VC-387). */
  readonly #bodies = new Map<string, string>();
  /** Insertion order is the order the edits were made, and the order they replay. */
  readonly #pending = new Map<string, Pending>();
  #replies = 0;

  constructor(options: BoardSyncOptions) {
    this.#transport = options.transport;
    this.#view = options.view;
    this.#mint = options.mintCommandId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? Date.now;
    this.#readCoalesceMs = options.readCoalesceMs ?? 16;
    this.#retryDelays = options.retryDelaysMs ?? [250, 500, 1_000, 2_000, 4_000, 8_000];
    this.#maxAttempts = options.maxAttempts ?? 8;
    this.#feedRetryDelays = options.feedRetryDelaysMs ?? [250, 1_000, 5_000];
    this.#confirmTimeoutMs = options.confirmTimeoutMs ?? 5_000;
    this.#isAmbiguous = options.isAmbiguous ?? isAmbiguousBoardFailure;
    this.#setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as number));
  }

  /** Whether this window follows the Workspace. */
  follows(projectId: string): boolean {
    return this.#workspaces.has(projectId);
  }

  /**
   * Reads the Workspace's snapshot, paints it, and follows its feed from the
   * snapshot's cursor. Opening one already open re-reads it (a resnapshot).
   */
  async open(projectId: string): Promise<void> {
    let workspace = this.#workspaces.get(projectId);
    if (workspace === undefined) {
      workspace = {
        tickets: new Map(),
        labels: new Map(),
        seen: [],
        cursor: null,
        stop: null,
        feedFailures: 0,
        readLog: null,
        readTimer: undefined,
        reading: false,
        readAgain: false,
        closed: false,
      };
      this.#workspaces.set(projectId, workspace);
    }
    workspace.stop?.();
    workspace.stop = null;
    const startedAt = this.#replies;
    const snapshot = await this.#transport.snapshot(projectId);
    if (workspace.closed) return;
    workspace.tickets.clear();
    for (const ticket of snapshot.tickets) {
      const { body, ...summary } = ticket;
      workspace.tickets.set(ticket.id, summary);
      this.#bodies.set(ticket.id, body);
    }
    workspace.labels.clear();
    for (const label of snapshot.labels) workspace.labels.set(label.id, label);
    this.#view.adoptProject(snapshot.project);
    this.#saw(workspace, snapshot.cursor);
    this.#confirmThrough(projectId, startedAt);
    this.#paint(projectId);
    this.#follow(projectId, workspace, snapshot.cursor);
  }

  /** Stops following a Workspace (removed, or this window forgot it). */
  close(projectId: string): void {
    const workspace = this.#workspaces.get(projectId);
    if (workspace === undefined) return;
    workspace.closed = true;
    workspace.stop?.();
    if (workspace.readTimer !== undefined) this.#clearTimer(workspace.readTimer);
    this.#workspaces.delete(projectId);
    for (const [commandId, pending] of this.#pending) {
      if (pending.projectId !== projectId) continue;
      if (pending.confirmTimer !== undefined) this.#clearTimer(pending.confirmTimer);
      this.#pending.delete(commandId);
    }
  }

  /** Stops following every Workspace. */
  closeAll(): void {
    for (const projectId of Array.from(this.#workspaces.keys())) this.close(projectId);
  }

  /** Records a body read on its own (the open ticket), so repaints keep it. */
  adoptBody(ticketId: string, body: string): void {
    this.#bodies.set(ticketId, body);
  }

  // ---- writes ---------------------------------------------------------------

  /** Creates a ticket, showing a placeholder at once; resolves with the created ticket. */
  async createTicket(
    projectId: string,
    fields: Omit<Parameters<BoardSyncTransport["createTicket"]>[0], "commandId" | "projectId">,
  ): Promise<Ticket | null> {
    const now = this.#now();
    const answer = await this.#write(
      projectId,
      "create ticket",
      (commandId) => ({
        tickets: (view) => {
          const column = view.filter((ticket) => ticket.status === fields.status);
          const order = column.reduce((max, ticket) => Math.max(max, ticket.order), -1) + 1;
          return [...view, placeholderTicket(commandId, projectId, fields, order, now)];
        },
      }),
      (commandId) => this.#transport.createTicket({ commandId, projectId, ...fields }),
      (created, workspace) => workspace.tickets.has(created.ticket.id),
    );
    if (answer === null) return null;
    this.#bodies.set(answer.ticket.id, answer.ticket.body);
    return answer.ticket;
  }

  /** One card or one selected group, to a position: one edit, one command. */
  async moveTickets(
    projectId: string,
    ticketIds: string[],
    toStatus: TicketStatus,
    toIndex: number,
    choice?: DeliberateMoveChoice,
  ): Promise<void> {
    const now = this.#now();
    await this.#write(
      projectId,
      ticketIds.length === 1 ? "move ticket" : "move tickets",
      () => ({
        tickets: (view) =>
          ticketIds.length === 1
            ? moveTicketOp(view, ticketIds[0]!, toStatus, toIndex, now)
            : moveTicketsOp(view, ticketIds, toStatus, toIndex, now),
      }),
      (commandId) =>
        this.#transport.moveTickets({
          commandId,
          projectId,
          ticketIds,
          toStatus,
          toIndex,
          ...(choice === undefined ? {} : { choice }),
        }),
    );
  }

  async setPriority(projectId: string, ticketId: string, priority: TicketPriority): Promise<void> {
    await this.#write(
      projectId,
      "update priority",
      () => ({ tickets: patchTicket(ticketId, { priority }) }),
      (commandId) => this.#transport.setPriority({ commandId, ticketId, priority }),
    );
  }

  async updateTicket(
    projectId: string,
    input: Omit<Parameters<BoardSyncTransport["updateTicket"]>[0], "commandId">,
  ): Promise<Ticket | null> {
    const { ticketId, ...fields } = input;
    const answer = await this.#write(
      projectId,
      "update ticket",
      () => ({ tickets: patchTicket(ticketId, fields) }),
      (commandId) => this.#transport.updateTicket({ commandId, ...input }),
    );
    if (answer === null) return null;
    this.#bodies.set(answer.ticket.id, answer.ticket.body);
    return answer.ticket;
  }

  async setLabels(projectId: string, ticketId: string, labels: string[]): Promise<void> {
    await this.#write(
      projectId,
      "update labels",
      () => ({ tickets: patchTicket(ticketId, { labels }) }),
      (commandId) => this.#transport.setLabels({ commandId, ticketId, labels }),
    );
  }

  async setLabelColor(projectId: string, labelId: string, color: string | null): Promise<void> {
    await this.#write(
      projectId,
      "update label color",
      () => ({
        labels: (view) => view.map((label) => (label.id === labelId ? { ...label, color } : label)),
      }),
      (commandId) => this.#transport.setLabelColor({ commandId, labelId, color }),
    );
  }

  /** Resolves whether the archive was accepted. */
  async archiveTicket(projectId: string, ticketId: string): Promise<boolean> {
    const answer = await this.#write(
      projectId,
      "archive ticket",
      () => ({ tickets: (view) => view.filter((ticket) => ticket.id !== ticketId) }),
      (commandId) => this.#transport.archiveTicket({ commandId, ticketId }),
    );
    return answer !== null;
  }

  /** Returns an archived ticket to the board; it shows at once, appended to its column. */
  async unarchiveTicket(projectId: string, archived: ArchivedTicket): Promise<Ticket | null> {
    const { archivedAt: _archivedAt, ...revived } = archived;
    const answer = await this.#write(
      projectId,
      "unarchive ticket",
      () => ({
        tickets: (view) => {
          if (view.some((ticket) => ticket.id === revived.id)) return view;
          const column = view.filter((ticket) => ticket.status === revived.status);
          const order = column.reduce((max, ticket) => Math.max(max, ticket.order), -1) + 1;
          return [...view, { ...revived, order }];
        },
      }),
      (commandId) => this.#transport.unarchiveTicket({ commandId, ticketId: archived.id }),
    );
    if (answer === null) return null;
    this.#bodies.set(answer.ticket.id, answer.ticket.body);
    return answer.ticket;
  }

  async deleteTicket(projectId: string, ticketId: string): Promise<boolean> {
    const answer = await this.#write(
      projectId,
      "delete ticket",
      () => ({}),
      (commandId) => this.#transport.deleteTicket({ commandId, ticketId }),
    );
    return answer !== null;
  }

  /** The Workspace's archived tickets, newest first, or null when the read failed (said). */
  async archivedTickets(projectId: string): Promise<ArchivedTicket[] | null> {
    try {
      return await this.#transport.archivedTickets(projectId);
    } catch (error) {
      this.#view.failed(`Couldn't load archive: ${failureMessage(error)}`);
      return null;
    }
  }

  /**
   * Sends one write under a fresh `commandId`, its edit pending over the base
   * until the feed confirms it. An unknown outcome is sent again under the
   * same id; a refusal drops the edit and is said. Resolves with the answer,
   * or null when it failed.
   */
  async #write<Answer extends BoardWriteAnswer>(
    projectId: string,
    verb: string,
    edit: (commandId: string) => Pick<Pending, "tickets" | "labels">,
    send: (commandId: string) => Promise<Answer>,
    held: (answer: Answer, workspace: Workspace) => boolean = () => false,
  ): Promise<Answer | null> {
    const commandId = this.#mint();
    const pending: Pending = { projectId, ...edit(commandId) };
    this.#pending.set(commandId, pending);
    this.#paint(projectId);
    for (let attempt = 1; ; attempt++) {
      try {
        const answer = await send(commandId);
        // Forgotten while in flight (the Workspace was closed): nothing to paint.
        if (!this.#pending.has(commandId)) return answer;
        pending.throughCursor = answer.throughCursor;
        pending.committedAt = ++this.#replies;
        const workspace = this.#workspaces.get(projectId);
        if (
          workspace === undefined ||
          workspace.seen.includes(answer.throughCursor) ||
          // A snapshot read while the write was in flight can already hold
          // its row, though the feed (resumed after it) never names it.
          held(answer, workspace)
        ) {
          this.#retire(commandId);
        } else {
          // The feed normally delivers the cursor first. If it does not soon,
          // a read (started after this reply, so it includes the write) does.
          pending.confirmTimer = this.#setTimer(() => {
            pending.confirmTimer = undefined;
            if (this.#pending.has(commandId)) this.#scheduleRead(projectId);
          }, this.#confirmTimeoutMs);
        }
        return answer;
      } catch (error) {
        if (
          this.#isAmbiguous(error) &&
          attempt < this.#maxAttempts &&
          this.#pending.has(commandId)
        ) {
          await this.#delay(this.#retryDelays[Math.min(attempt, this.#retryDelays.length) - 1]!);
          continue;
        }
        if (this.#pending.delete(commandId)) this.#paint(projectId);
        this.#view.failed(`Couldn't ${verb}: ${failureMessage(error)}`);
        return null;
      }
    }
  }

  #retire(commandId: string): void {
    const pending = this.#pending.get(commandId);
    /* v8 ignore if -- its one caller retires a write it just found pending, in the same turn. */
    if (pending === undefined) return;
    /* v8 ignore if -- it retires a write on the turn its reply lands, before any confirm timer is armed. */
    if (pending.confirmTimer !== undefined) this.#clearTimer(pending.confirmTimer);
    this.#pending.delete(commandId);
    this.#paint(pending.projectId);
  }

  /** Retires every committed write of the Workspace a read started after the reply includes. */
  #confirmThrough(projectId: string, readStartedAt: number): void {
    for (const [commandId, pending] of Array.from(this.#pending)) {
      if (
        pending.projectId === projectId &&
        pending.committedAt !== undefined &&
        pending.committedAt <= readStartedAt
      ) {
        if (pending.confirmTimer !== undefined) this.#clearTimer(pending.confirmTimer);
        this.#pending.delete(commandId);
      }
    }
  }

  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.#setTimer(resolve, ms));
  }

  // ---- the feed ---------------------------------------------------------------

  #follow(projectId: string, workspace: Workspace, cursor: string): void {
    workspace.cursor = cursor;
    workspace.stop = this.#transport.changes(projectId, cursor, {
      onBatch: (batch) => {
        if (workspace.closed) return;
        workspace.feedFailures = 0;
        this.#apply(projectId, workspace, batch);
      },
      onResnapshot: () => {
        if (workspace.closed) return;
        void this.open(projectId).catch((error: unknown) =>
          this.#feedFailed(projectId, workspace, error),
        );
      },
      onError: (error) => {
        if (workspace.closed) return;
        this.#feedFailed(projectId, workspace, error);
      },
    });
  }

  /** A feed that ended in error resumes from its last cursor, after a pause. */
  #feedFailed(projectId: string, workspace: Workspace, _error: unknown): void {
    workspace.stop = null;
    const delay =
      this.#feedRetryDelays[Math.min(workspace.feedFailures, this.#feedRetryDelays.length - 1)]!;
    workspace.feedFailures += 1;
    this.#setTimer(() => {
      if (workspace.closed || workspace.stop !== null) return;
      /* v8 ignore if -- a feed is only ever followed after a snapshot set its cursor, and nothing clears it. */
      if (workspace.cursor === null) void this.open(projectId).catch(() => {});
      else this.#follow(projectId, workspace, workspace.cursor);
    }, delay);
  }

  #saw(workspace: Workspace, cursor: string): void {
    workspace.cursor = cursor;
    workspace.seen.push(cursor);
    if (workspace.seen.length > SEEN_CURSORS)
      workspace.seen.splice(0, workspace.seen.length - SEEN_CURSORS);
  }

  #apply(projectId: string, workspace: Workspace, batch: BoardFeedBatch): void {
    workspace.readLog?.push(batch);
    let read = false;
    for (const change of batch.changes)
      read = this.#applyChange(projectId, workspace, change) || read;
    this.#saw(workspace, batch.cursor);
    const named = new Set(batch.changes.map((change) => change.commandId));
    for (const [commandId, pending] of Array.from(this.#pending)) {
      if (pending.projectId !== projectId) continue;
      if (pending.throughCursor === batch.cursor) {
        if (pending.confirmTimer !== undefined) this.#clearTimer(pending.confirmTimer);
        this.#pending.delete(commandId);
      } else if (named.has(commandId)) {
        // The write's own rows landed before its reply (the feed normally
        // leads): the base holds its effect, so its edit stops replaying. A
        // move replayed over its own result is not a no-op once later edits
        // moved cards around it. Its reply (or a retry's receipt) retires it.
        pending.tickets = undefined;
        pending.labels = undefined;
      }
    }
    this.#paint(projectId);
    if (read) this.#scheduleRead(projectId);
  }

  /** Applies one change to the base; answers whether it asks for a roster read. */
  #applyChange(
    projectId: string,
    workspace: Workspace,
    change: BoardChange,
    replay = false,
  ): boolean {
    switch (change.kind) {
      case "project":
        if (change.project === undefined) return true;
        if (!replay) this.#view.adoptProject(change.project);
        return false;
      case "ticket":
        if (!replay && change.checkoutMoved === true) this.#view.checkoutMoved(change.id);
        if (change.op === "delete") {
          workspace.tickets.delete(change.id);
        } else if (change.ticket === undefined) {
          if (!replay) this.#view.notePlanningChange({ ticketId: change.id, projectId });
          return true;
        } else {
          workspace.tickets.set(change.id, change.ticket);
        }
        if (!replay && change.commandId === undefined) {
          this.#view.notePlanningChange({ ticketId: change.id, projectId });
        }
        return false;
      case "label":
        if (change.op === "delete") workspace.labels.delete(change.id);
        else if (change.label === undefined) return true;
        else workspace.labels.set(change.id, change.label);
        return false;
      case "comment":
      case "ticketEvent":
        if (!replay) this.#view.notePlanningChange({ ticketId: change.ticketId, projectId });
        return false;
      default:
        // A kind this build does not know names state another reader owns
        // (HP: the change kind is an open union).
        return false;
    }
  }

  // ---- reads ------------------------------------------------------------------

  /** One roster read per burst: coalesced, one in flight, at most one queued behind it. */
  #scheduleRead(projectId: string): void {
    const workspace = this.#workspaces.get(projectId);
    /* v8 ignore if -- every caller holds a write or a read of a Workspace still open: closing drops both. */
    if (workspace === undefined) return;
    if (workspace.reading) {
      workspace.readAgain = true;
      return;
    }
    if (workspace.readTimer !== undefined) return;
    workspace.readTimer = this.#setTimer(() => {
      workspace.readTimer = undefined;
      void this.#read(projectId, workspace);
    }, this.#readCoalesceMs);
  }

  async #read(projectId: string, workspace: Workspace): Promise<void> {
    workspace.reading = true;
    workspace.readLog = [];
    const startedAt = this.#replies;
    try {
      const roster = await this.#transport.roster(projectId);
      if (workspace.closed) return;
      workspace.tickets.clear();
      for (const ticket of roster.tickets) workspace.tickets.set(ticket.id, ticket);
      workspace.labels.clear();
      for (const label of roster.labels) workspace.labels.set(label.id, label);
      // What the feed delivered while the read was in flight replays over it,
      // oldest first: the latest word on each entity wins, whichever it was.
      for (const batch of workspace.readLog) {
        for (const change of batch.changes) this.#applyChange(projectId, workspace, change, true);
      }
      workspace.seen.push(roster.cursor);
      this.#confirmThrough(projectId, startedAt);
      this.#paint(projectId);
    } catch (error) {
      this.#view.failed(`Couldn't refresh the board: ${failureMessage(error)}`);
    } finally {
      workspace.reading = false;
      workspace.readLog = null;
      if (workspace.readAgain && !workspace.closed) {
        workspace.readAgain = false;
        this.#scheduleRead(projectId);
      }
    }
  }

  // ---- the view -----------------------------------------------------------------

  /** Paints the base with every pending edit replayed over it, in the order they were made. */
  #paint(projectId: string): void {
    const workspace = this.#workspaces.get(projectId);
    // Nothing confirmed yet (its snapshot is in flight): the board keeps what
    // it shows, and a write made meanwhile paints once the snapshot lands.
    if (workspace === undefined || workspace.cursor === null) return;
    const unloaded = new Set<string>();
    let tickets: Ticket[] = [];
    for (const summary of Array.from(workspace.tickets.values()).toSorted(byColumn)) {
      const body = this.#bodies.get(summary.id);
      if (body === undefined) unloaded.add(summary.id);
      tickets.push(Object.assign({}, summary, { body: body ?? "" }));
    }
    let labels = [...workspace.labels.values()];
    for (const pending of this.#pending.values()) {
      if (pending.projectId !== projectId) continue;
      if (pending.tickets !== undefined) tickets = pending.tickets(tickets);
      if (pending.labels !== undefined) labels = pending.labels(labels);
    }
    this.#view.paint(projectId, tickets, labels, unloaded);
  }
}

function patchTicket(ticketId: string, fields: Partial<Ticket>): (view: Ticket[]) => Ticket[] {
  const defined = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<Ticket>;
  return (view) =>
    view.map((ticket) => (ticket.id === ticketId ? { ...ticket, ...defined } : ticket));
}

function placeholderTicket(
  commandId: string,
  projectId: string,
  fields: Omit<Parameters<BoardSyncTransport["createTicket"]>[0], "commandId" | "projectId">,
  order: number,
  now: number,
): Ticket {
  return {
    id: placeholderTicketId(commandId),
    projectId,
    ticketNumber: 0,
    title: fields.title,
    body: fields.body ?? "",
    status: fields.status,
    priority: fields.priority ?? "medium",
    labels: fields.labels ?? [],
    usesWorktree: fields.usesWorktree ?? true,
    preferredHarnessId: fields.preferredHarnessId ?? "claude-code",
    order,
    worktreePath: null,
    branch: null,
    baseBranch: fields.baseBranch ?? null,
    prUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}
