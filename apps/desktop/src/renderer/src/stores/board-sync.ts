/**
 * The board, read and written through the host protocol (VC-565), with the
 * `cloud` flag on. One code path for this Mac's in-process host (over the
 * desktop's generic IPC bridge) and a remote one (over a host link): it speaks a
 * {@link BoardSyncTransport}, built from either board client.
 *
 * **What is on screen is the host's confirmed board plus this window's
 * pending writes (T5).** Per Workspace it holds:
 *
 * - **the base**: the rows the host has confirmed, from a snapshot, a roster
 *   read, or the Workspace's change feed (`board.changes`), whose changes
 *   inline the committed row and name the `commandId` behind them;
 * - **the pending layer**: every write this window has made and not yet seen
 *   in the base, keyed by the `commandId` it minted for it, each an
 *   optimistic edit replayed over the base, in the order it was made.
 *
 * The rules, each a guarantee:
 *
 * - **The base is monotonic.** It carries the feed cursor it reflects. A feed
 *   batch, a roster read or a snapshot read changes it only when its cursor is
 *   at least the base's ({@link compareBoardCursors}); anything older is
 *   dropped, and a cursor from another feed (a restarted host, a changed
 *   epoch) never compares, so only a fresh snapshot replaces the base then. A
 *   read that answers older than the base is the base's answer up to its
 *   cursor: the feed's changes after that cursor, kept while the read is in
 *   flight (compacted to the latest per entity, bounded), replay over it.
 * - **Writes to one aspect reach the host one at a time, in the order made.**
 *   A request already sent may land late (no network order is promised), so
 *   a newer write to an aspect an older unsettled write sets (the same
 *   field; any card's place on the board, since a drop index is a place among
 *   the others) is not sent until the older one has a reply or a proof.
 *   Writes queued behind it collapse to the latest: one still unsent that a
 *   newer write covers is never sent at all.
 * - **A body is never older than the newest write or read of it.** A reply's
 *   or a proof's body is adopted only if no later write set one, and only
 *   while its ticket is on the board; a read's only if nothing was adopted
 *   since it began.
 * - **An outcome is decided by any proof.** A reply, a feed change naming the
 *   `commandId`, or a retry the host answers from its receipt each prove the
 *   host took the write, and the first proof settles it: its caller's side
 *   effects run once. An unknown outcome is sent again under the same id, and
 *   keeps being sent (after `maxAttempts`, the person is told it is still
 *   trying); only a definitive refusal drops the edit and says why.
 * - **Retirement cannot stick.** An accepted write's edit retires once the
 *   base holds its effect: the base's cursor reaches the one the host stamped
 *   it through. If the feed does not bring it in time, a confirmation read
 *   does; a read that fails is retried with backoff until one lands.
 * - **Reads belong to a generation.** A resnapshot starts a new one: an
 *   older generation's read in flight is dropped when it lands, and never
 *   touches the new generation's queued work.
 * - **Followed means subscribed.** A Workspace this window follows is opened
 *   until its snapshot lands and its feed is followed: a failed open, a
 *   resnapshot or a feed that ended are retried with backoff, never left. The
 *   one exception is a host whose board is not this window's at all
 *   ({@link isBoardUnavailable}): that open stops, and the Workspace is no
 *   longer followed, until its owner opens it again.
 * - **A project change refreshes the project.** A project change without its
 *   row reads the board's snapshot, which carries the project.
 *
 * Nothing here persists: the host is the source of truth, and this is the
 * in-memory last-known view (D-C1).
 */
import {
  compareBoardCursors,
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
   * resume (host restart, retention, a changed epoch); `onError`: anything
   * else that ended it.
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
  /** A committed project row arrived (the feed, or a snapshot). */
  adoptProject(project: Project): void;
  /** Per-ticket surfaces (activity, body) re-read what the board does not hold. */
  notePlanningChange(change: { ticketId?: string; projectId?: string }): void;
  /** A change moved where a ticket's Sessions run: its venue reading is stale. */
  checkoutMoved(ticketId: string): void;
  /** A write was refused, or a read failed: say so (CLAUDE.md, never swallow a failed mutation). */
  failed(message: string): void;
  /** A write's outcome is still unknown after its attempts; it keeps being sent. Said once per write. */
  unconfirmed?(message: string): void;
}

export interface BoardSyncOptions {
  /**
   * The host each Workspace's calls go to: one transport for every
   * Workspace, or one per Workspace (VC-711: a remote project's board goes
   * over its Workspace link, this Mac's over the IPC bridge). Every call
   * names its Workspace, so routing needs nothing else.
   */
  readonly transport: BoardSyncTransport | ((projectId: string) => BoardSyncTransport);
  readonly view: BoardSyncView;
  readonly mintCommandId?: () => string;
  readonly now?: () => number;
  /** How long rowless changes coalesce before their one read. */
  readonly readCoalesceMs?: number;
  /** Delays between retries of an ambiguous write, the last repeated for as long as it takes. */
  readonly retryDelaysMs?: readonly number[];
  /** Attempts after which the person is told a write is still unconfirmed (it keeps being sent). */
  readonly maxAttempts?: number;
  /** Delays between re-opens, re-subscribes and re-reads after a failure, the last repeated. */
  readonly feedRetryDelaysMs?: readonly number[];
  /** How long an accepted write waits for its cursor on the feed before a read confirms it. */
  readonly confirmTimeoutMs?: number;
  /** Whether a failure's outcome is unknown, so the write is retried under its id. */
  readonly isAmbiguous?: (error: unknown) => boolean;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/** How a write ended for its caller. */
type Outcome<Answer> =
  | { readonly kind: "accepted"; readonly answer: Answer }
  | { readonly kind: "refused" }
  | { readonly kind: "superseded" };

/** One write of this window's, from the moment it is made until the base holds it. */
interface Pending {
  readonly commandId: string;
  /** The Workspace it paints over; undefined for a per-surface command (it paints nothing). */
  readonly projectId: string | undefined;
  /**
   * The Workspace a per-surface command was made for, which owns it: closing
   * that Workspace ends it (VC-711), and it is never sent anywhere else.
   */
  readonly owner: string | undefined;
  /** What it sets, as `<kind>:<id>:<aspect>`: a newer write setting all of them supersedes it. */
  readonly aspects: ReadonlySet<string>;
  /** An archive, unarchive or delete: never superseded, only waited for. */
  readonly lifecycle: boolean;
  /** This window's order of writes: a body this write sets loses to one set by a later write or read. */
  readonly seq: number;
  /** A create or an unarchive: its ticket may not be on the board yet when its body is adopted. */
  readonly revives: boolean;
  /** Its optimistic edit; cleared once the base holds the effect (or it was superseded). */
  tickets?: (view: Ticket[]) => Ticket[];
  labels?: (view: Label[]) => Label[];
  /** The bodies it writes, adopted as confirmed bodies on its first proof. */
  readonly bodies: Map<string, string>;
  /** queued: waiting for an older overlapping write; sending/retrying: unknown; accepted: proved. */
  state: "queued" | "sending" | "retrying" | "accepted" | "superseded" | "refused" | "closed";
  /** The cursor the host stamped it through: its reply's, or the batch that named it. */
  through?: string;
  /** The id a created ticket was given, read off the feed row that named this write. */
  createdId?: string;
  /** The row the feed carried for it, when its answer is that row (a comment, a project). */
  fedRow?: unknown;
  confirmTimer?: unknown;
  retryTimer?: unknown;
  /** Wakes a write waiting out its retry delay: a proof arrived, or it was superseded. */
  wake?: () => void;
  /** Resolves once the write is settled: accepted, refused, superseded or closed. */
  readonly settled: Promise<void>;
  settle(): void;
}

interface LoggedChange {
  readonly cursor: string;
  readonly change: BoardChange;
}

/** One read in flight, owned by the generation that started it. */
interface Reader {
  readonly generation: number;
  /** The feed's changes since it started, latest per entity; null when overflowed. */
  log: Map<string, LoggedChange> | null;
  /** Another read was asked for while this one was in flight. */
  again: boolean;
}

interface Workspace {
  readonly projectId: string;
  readonly tickets: Map<string, TicketSummary>;
  readonly labels: Map<string, Label>;
  /** Every ticket body this window has read for this Workspace: a roster row carries none (VC-387). */
  readonly bodies: Map<string, string>;
  /** The write (`Pending.seq`) whose body each ticket shows: an older write's never replaces it. */
  readonly bodySeq: Map<string, number>;
  /** When each body was adopted (this engine's adoption clock): a read begun before never replaces it. */
  readonly bodyAt: Map<string, number>;
  /** The feed cursor the base reflects; null until the first snapshot lands. */
  cursor: string | null;
  /** The cursor of the project row this window last adopted. */
  projectCursor: string | null;
  /** The newest rowless ticket or label change no read has covered yet. */
  dirty: string | null;
  /** The newest rowless project change no snapshot read has covered yet. */
  dirtyProject: string | null;
  /** Bumped by every open: a read or snapshot of an older generation never applies. */
  generation: number;
  stop: (() => void) | null;
  feedFailures: number;
  openFailures: number;
  openTimer: unknown;
  /** The current generation's read in flight, if any: an older generation's never counts. */
  reader: Reader | null;
  readTimer: unknown;
  readFailures: number;
  /** The read asked for next must carry the project (a snapshot). */
  readProject: boolean;
  closed: boolean;
}

const STATUS_RANK = new Map<TicketStatus, number>(
  TICKET_STATUSES.map((status, index) => [status, index]),
);

/** Entities one in-flight read keeps changes for; past it, an older answer is dropped and read again. */
export const READ_LOG_ENTITIES = 4_096;

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

/**
 * Whether a host answered that its board is not this window's to read at all:
 * the Workspace's link was not granted the board (an older host,
 * `verb-refused`), the host has no board (`operation-unavailable`), or it does
 * not know the Workspace (`workspace-unknown`). Asking again changes nothing
 * until the host or the link does, so an open stops retrying on it (VC-711).
 */
export function isBoardUnavailable(error: unknown): boolean {
  const reason = (error as { data?: { hostError?: { reason?: unknown } } } | null)?.data?.hostError
    ?.reason;
  return (
    reason === "verb-refused" ||
    reason === "operation-unavailable" ||
    reason === "workspace-unknown"
  );
}

/** Whether a host answered that the resource does not exist (in this Workspace). */
export function isNotFound(error: unknown): boolean {
  const hostError = (error as { data?: { hostError?: { code?: unknown } } } | null)?.data
    ?.hostError;
  return hostError?.code === "NOT_FOUND";
}

/** The message a failure carries: the host's, an Error's, or the thing itself. */
export function failureMessage(error: unknown): string {
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

/** Whether cursor `a` is at or past `b` on one feed; false across feeds. */
function reaches(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const order = compareBoardCursors(a, b);
  return order !== null && order >= 0;
}

/** How one write is made: what it paints, what it sets, and how it is sent. */
interface WriteSpec<Answer> {
  readonly projectId: string | undefined;
  /** A per-surface command's Workspace: closing it ends the command (VC-711). */
  readonly owner?: string;
  readonly verb: string;
  readonly aspects: readonly string[];
  readonly lifecycle?: boolean;
  readonly edit?: (commandId: string) => {
    tickets?: (view: Ticket[]) => Ticket[];
    labels?: (view: Label[]) => Label[];
  };
  /** Bodies the write sets, by ticket id; a create's is keyed by its placeholder until its id is known. */
  readonly bodies?: ReadonlyMap<string, string>;
  readonly send: (commandId: string) => Promise<Answer>;
  /** The answer on a proof without a reply: the feed named the write, or a retry found its resource gone. */
  readonly proved?: (pending: Pending) => Answer;
  /** A retry that finds its resource gone was the removal itself (repeated delete, comment removal). */
  readonly goneMeansDone?: boolean;
  /** A create or an unarchive: its body may be adopted ahead of its row. */
  readonly revives?: boolean;
  /** Told the refusal's own message. */
  readonly onRefused?: (message: string) => void;
  /** The caller says a refusal itself (a per-surface command): not told to the person here. */
  readonly quiet?: boolean;
}

/** The board's sync engine for every Workspace this window follows. */
export class BoardSync {
  readonly #transportFor: (projectId: string) => BoardSyncTransport;
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
  /** Insertion order is the order the writes were made, and the order their edits replay. */
  readonly #pending = new Map<string, Pending>();
  /** Writes made so far: each write's `seq`. */
  #writes = 0;
  /** Bodies adopted so far: the clock a body's adoption and a read's start are read on. */
  #adoptions = 0;

  constructor(options: BoardSyncOptions) {
    const { transport } = options;
    this.#transportFor = typeof transport === "function" ? transport : () => transport;
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

  /** Whether this window follows the Workspace: it is open, or being opened until it is. */
  follows(projectId: string): boolean {
    return this.#workspaces.has(projectId);
  }

  /** The Workspace whose board holds this ticket, if any this window follows does. */
  workspaceOf(ticketId: string): string | undefined {
    for (const workspace of this.#workspaces.values()) {
      if (workspace.tickets.has(ticketId)) return workspace.projectId;
    }
    return undefined;
  }

  /**
   * Reads the Workspace's snapshot, paints it, and follows its feed from the
   * snapshot's cursor. Opening one already open re-reads it (a resnapshot).
   * A snapshot that fails rejects (the caller says so) and is tried again,
   * with backoff, until it lands or the Workspace is closed.
   */
  async open(projectId: string): Promise<void> {
    let workspace = this.#workspaces.get(projectId);
    if (workspace === undefined) {
      workspace = {
        projectId,
        tickets: new Map(),
        labels: new Map(),
        bodies: new Map(),
        bodySeq: new Map(),
        bodyAt: new Map(),
        cursor: null,
        projectCursor: null,
        dirty: null,
        dirtyProject: null,
        generation: 0,
        stop: null,
        feedFailures: 0,
        openFailures: 0,
        openTimer: undefined,
        reader: null,
        readTimer: undefined,
        readFailures: 0,
        readProject: false,
        closed: false,
      };
      this.#workspaces.set(projectId, workspace);
    }
    const generation = ++workspace.generation;
    workspace.stop?.();
    workspace.stop = null;
    if (workspace.openTimer !== undefined) {
      this.#clearTimer(workspace.openTimer);
      workspace.openTimer = undefined;
    }
    // A body adopted while the snapshot was in flight is newer than its.
    const readAt = this.#adoptions;
    let snapshot: Awaited<ReturnType<BoardSyncTransport["snapshot"]>>;
    try {
      snapshot = await this.#transportFor(projectId).snapshot(projectId);
    } catch (error) {
      if (!workspace.closed && workspace.generation === generation) {
        // A host whose board is not this window's at all is not followed: it
        // stops here, and its owner opens it again when the host or the link
        // changes (VC-711). Anything else is retried, with backoff.
        if (isBoardUnavailable(error)) this.close(projectId);
        else this.#reopenLater(workspace);
      }
      throw error;
    }
    // Closed, or opened again since: a newer snapshot owns the base.
    if (workspace.closed || workspace.generation !== generation) return;
    workspace.openFailures = 0;
    const removed = new Set(workspace.tickets.keys());
    workspace.tickets.clear();
    for (const { body, ...summary } of snapshot.tickets) {
      workspace.tickets.set(summary.id, summary);
      this.#readBody(workspace, summary.id, body, readAt);
      removed.delete(summary.id);
    }
    this.#forgetBodies(workspace, removed);
    workspace.labels.clear();
    for (const label of snapshot.labels) workspace.labels.set(label.id, label);
    workspace.cursor = snapshot.cursor;
    workspace.projectCursor = snapshot.cursor;
    // A snapshot is the whole board, read while no feed was followed: it
    // covers every rowless change this window had.
    workspace.dirty = null;
    workspace.dirtyProject = null;
    this.#view.adoptProject(snapshot.project);
    this.#retireHeld(workspace, true);
    this.#paint(projectId);
    this.#follow(workspace, snapshot.cursor);
  }

  /** Stops following a Workspace (removed, or this window forgot it). */
  close(projectId: string): void {
    const workspace = this.#workspaces.get(projectId);
    if (workspace === undefined) return;
    workspace.closed = true;
    workspace.stop?.();
    for (const timer of [workspace.readTimer, workspace.openTimer]) {
      if (timer !== undefined) this.#clearTimer(timer);
    }
    this.#workspaces.delete(projectId);
    // Its board writes and its per-surface commands alike: a command made for
    // a Workspace is that Workspace's host's, and goes nowhere once it closes.
    for (const pending of Array.from(this.#pending.values())) {
      if (pending.owner === projectId) this.#drop(pending, "closed");
    }
  }

  /** Stops following every Workspace. */
  closeAll(): void {
    for (const projectId of Array.from(this.#workspaces.keys())) this.close(projectId);
    for (const pending of Array.from(this.#pending.values())) this.#drop(pending, "closed");
  }

  /** Records a body read on its own (the open ticket), so repaints keep it. */
  adoptBody(ticketId: string, body: string): void {
    const projectId = this.workspaceOf(ticketId);
    if (projectId === undefined) return;
    this.#setBody(this.#workspaces.get(projectId)!, ticketId, body);
  }

  #setBody(workspace: Workspace, ticketId: string, body: string, seq?: number): void {
    workspace.bodies.set(ticketId, body);
    workspace.bodyAt.set(ticketId, ++this.#adoptions);
    if (seq !== undefined) workspace.bodySeq.set(ticketId, seq);
  }

  /**
   * Adopts a body a read answered, begun at `startedAt` on the adoption
   * clock: never over a body adopted after the read began, which is newer.
   */
  #readBody(workspace: Workspace, ticketId: string, body: string, startedAt: number): void {
    if ((workspace.bodyAt.get(ticketId) ?? 0) > startedAt) return;
    this.#setBody(workspace, ticketId, body);
  }

  /**
   * Adopts a body a write set (its reply's, or the one it sent, on its
   * proof): only while its ticket is on the board (a create or unarchive may
   * be ahead of its row), and never over a body a later write set. A ticket
   * that left the board keeps no body, so a late reply cannot put one back.
   */
  #writtenBody(workspace: Workspace, pending: Pending, ticketId: string, body: string): void {
    if (!workspace.tickets.has(ticketId) && !pending.revives) return;
    if ((workspace.bodySeq.get(ticketId) ?? 0) > pending.seq) return;
    this.#setBody(workspace, ticketId, body, pending.seq);
  }

  // ---- writes ---------------------------------------------------------------

  /** Creates a ticket, showing a placeholder at once; resolves with the created ticket. */
  async createTicket(
    projectId: string,
    fields: Omit<Parameters<BoardSyncTransport["createTicket"]>[0], "commandId" | "projectId">,
  ): Promise<Ticket | null> {
    const now = this.#now();
    const outcome = await this.#write<BoardWriteAnswer & { ticket: Ticket | null }>({
      projectId,
      verb: "create ticket",
      aspects: [],
      edit: (commandId) => ({
        tickets: (view) => {
          const column = view.filter((ticket) => ticket.status === fields.status);
          const order = column.reduce((max, ticket) => Math.max(max, ticket.order), -1) + 1;
          return [...view, placeholderTicket(commandId, projectId, fields, order, now)];
        },
      }),
      bodies: new Map([[CREATED, fields.body ?? ""]]),
      revives: true,
      send: (commandId) =>
        this.#transportFor(projectId).createTicket({ commandId, projectId, ...fields }),
      proved: (pending) => ({
        ...this.#provedAnswer(pending),
        // Proved by the feed, whose row named the new ticket's id.
        ticket: this.#row(projectId, pending.createdId!),
      }),
    });
    return outcome.kind === "accepted" ? outcome.answer.ticket : null;
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
    await this.#write({
      projectId,
      verb: ticketIds.length === 1 ? "move ticket" : "move tickets",
      // A drop index is a place among the column's cards, so every move of a
      // board shares one aspect (moves reach the host in the order made), and
      // each names its cards (a newer move of the same cards replaces one queued).
      aspects: [`board:${projectId}:positions`, ...ticketIds.map((id) => `ticket:${id}:position`)],
      edit: () => ({
        tickets: (view) =>
          ticketIds.length === 1
            ? moveTicketOp(view, ticketIds[0]!, toStatus, toIndex, now)
            : moveTicketsOp(view, ticketIds, toStatus, toIndex, now),
      }),
      send: (commandId) =>
        this.#transportFor(projectId).moveTickets({
          commandId,
          projectId,
          ticketIds,
          toStatus,
          toIndex,
          ...(choice === undefined ? {} : { choice }),
        }),
    });
  }

  async setPriority(projectId: string, ticketId: string, priority: TicketPriority): Promise<void> {
    await this.#write({
      projectId,
      verb: "update priority",
      aspects: [`ticket:${ticketId}:priority`],
      edit: () => ({ tickets: patchTicket(ticketId, { priority }) }),
      send: (commandId) =>
        this.#transportFor(projectId).setPriority({ commandId, ticketId, priority }),
    });
  }

  /** Resolves the updated ticket; null when it was refused or a newer edit replaced it. */
  async updateTicket(
    projectId: string,
    input: Omit<Parameters<BoardSyncTransport["updateTicket"]>[0], "commandId">,
  ): Promise<Ticket | null> {
    const { ticketId, ...fields } = input;
    const defined = Object.keys(fields).filter(
      (field) => fields[field as keyof typeof fields] !== undefined,
    );
    const outcome = await this.#write<BoardWriteAnswer & { ticket: Ticket | null }>({
      projectId,
      verb: "update ticket",
      aspects: defined.map((field) => `ticket:${ticketId}:${field}`),
      edit: () => ({ tickets: patchTicket(ticketId, fields) }),
      bodies: fields.body === undefined ? undefined : new Map([[ticketId, fields.body]]),
      send: (commandId) => this.#transportFor(projectId).updateTicket({ commandId, ...input }),
      proved: (pending) => ({
        ...this.#provedAnswer(pending),
        ticket: this.#row(projectId, ticketId),
      }),
    });
    return outcome.kind === "accepted" ? outcome.answer.ticket : null;
  }

  async setLabels(projectId: string, ticketId: string, labels: string[]): Promise<void> {
    await this.#write({
      projectId,
      verb: "update labels",
      aspects: [`ticket:${ticketId}:labels`],
      edit: () => ({ tickets: patchTicket(ticketId, { labels }) }),
      send: (commandId) => this.#transportFor(projectId).setLabels({ commandId, ticketId, labels }),
    });
  }

  async setLabelColor(projectId: string, labelId: string, color: string | null): Promise<void> {
    await this.#write({
      projectId,
      verb: "update label color",
      aspects: [`label:${labelId}:color`],
      edit: () => ({
        labels: (view) => view.map((label) => (label.id === labelId ? { ...label, color } : label)),
      }),
      send: (commandId) =>
        this.#transportFor(projectId).setLabelColor({ commandId, labelId, color }),
    });
  }

  /** Resolves whether the archive was accepted: true on its first proof, whichever it was. */
  async archiveTicket(projectId: string, ticketId: string): Promise<boolean> {
    const outcome = await this.#write({
      projectId,
      verb: "archive ticket",
      aspects: [`ticket:${ticketId}:lifecycle`],
      lifecycle: true,
      edit: () => ({ tickets: (view) => view.filter((ticket) => ticket.id !== ticketId) }),
      send: (commandId) => this.#transportFor(projectId).archiveTicket({ commandId, ticketId }),
    });
    return outcome.kind === "accepted";
  }

  /** Returns an archived ticket to the board; it shows at once, appended to its column. */
  async unarchiveTicket(projectId: string, archived: ArchivedTicket): Promise<Ticket | null> {
    const { archivedAt: _archivedAt, ...revived } = archived;
    const outcome = await this.#write<BoardWriteAnswer & { ticket: Ticket | null }>({
      projectId,
      verb: "unarchive ticket",
      aspects: [`ticket:${archived.id}:lifecycle`],
      lifecycle: true,
      edit: () => ({
        tickets: (view) => {
          if (view.some((ticket) => ticket.id === revived.id)) return view;
          const column = view.filter((ticket) => ticket.status === revived.status);
          const order = column.reduce((max, ticket) => Math.max(max, ticket.order), -1) + 1;
          return [...view, { ...revived, order }];
        },
      }),
      // The archived row carries the host's body: it is the confirmed one.
      bodies: new Map([[archived.id, archived.body]]),
      revives: true,
      send: (commandId) =>
        this.#transportFor(projectId).unarchiveTicket({ commandId, ticketId: archived.id }),
      proved: (pending) => ({
        ...this.#provedAnswer(pending),
        ticket: this.#row(projectId, archived.id),
      }),
    });
    return outcome.kind === "accepted" ? outcome.answer.ticket : null;
  }

  async deleteTicket(projectId: string, ticketId: string): Promise<boolean> {
    const outcome = await this.#write({
      projectId,
      verb: "delete ticket",
      aspects: [`ticket:${ticketId}:lifecycle`],
      lifecycle: true,
      send: (commandId) => this.#transportFor(projectId).deleteTicket({ commandId, ticketId }),
      goneMeansDone: true,
    });
    return outcome.kind === "accepted";
  }

  /**
   * A per-surface command (a comment, a project setting) under one
   * `commandId`, by the same rules as the board's writes: an unknown outcome
   * is sent again under its id for as long as it takes, the first proof
   * settles it (a reply, or a feed change naming it, whose row `fromFeed`
   * turns into the answer), and only a refusal fails it, answered with the
   * host's message for the surface to say. It paints nothing.
   */
  async command<Answer>(spec: {
    verb: string;
    /**
     * The Workspace the command was made for, when it was made for one: it
     * ends with that Workspace (`close`), and its `send` must go to that
     * Workspace's host only (VC-711).
     */
    owner?: string;
    send: (commandId: string) => Promise<Answer>;
    fromFeed: (row: unknown, commandId: string) => Answer;
    goneMeansDone?: boolean;
  }): Promise<{ ok: true; answer: Answer } | { ok: false; error: string }> {
    let refusal = "";
    const outcome = await this.#write<Answer>({
      projectId: undefined,
      ...(spec.owner === undefined ? {} : { owner: spec.owner }),
      verb: spec.verb,
      aspects: [],
      send: spec.send,
      proved: (pending) => spec.fromFeed(pending.fedRow, pending.commandId),
      goneMeansDone: spec.goneMeansDone,
      quiet: true,
      onRefused: (message) => {
        refusal = message;
      },
    });
    return outcome.kind === "accepted"
      ? { ok: true, answer: outcome.answer }
      : { ok: false, error: refusal };
  }

  /** The Workspace's archived tickets, newest first, or null when the read failed (said). */
  async archivedTickets(projectId: string): Promise<ArchivedTicket[] | null> {
    try {
      return await this.#transportFor(projectId).archivedTickets(projectId);
    } catch (error) {
      this.#view.failed(`Couldn't load archive: ${failureMessage(error)}`);
      return null;
    }
  }

  /** A synthesized answer for a write proved without its reply. */
  #provedAnswer(pending: Pending): BoardWriteAnswer {
    return {
      receipt: { commandId: pending.commandId, status: "completed", replayed: true },
      throughCursor: pending.through ?? "",
    };
  }

  /** A ticket as the base holds it, with its body; null when the base does not hold it. */
  #row(projectId: string, ticketId: string): Ticket | null {
    const workspace = this.#workspaces.get(projectId);
    const summary = workspace?.tickets.get(ticketId);
    /* v8 ignore if -- a proof by the feed lands its row in the same turn; only a later delete could take it. */
    if (summary === undefined) return null;
    // A proved write's body was adopted on its proof.
    return { ...summary, body: workspace!.bodies.get(ticketId)! };
  }

  /**
   * Makes one write: its edit paints at once, older writes it covers are
   * superseded, and it is sent (after any older overlapping write settles)
   * under its `commandId` until its first proof or a refusal.
   */
  async #write<Answer>(spec: WriteSpec<Answer>): Promise<Outcome<Answer>> {
    const commandId = this.#mint();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const edit = spec.edit?.(commandId) ?? {};
    const pending: Pending = {
      commandId,
      projectId: spec.projectId,
      owner: spec.owner ?? spec.projectId,
      aspects: new Set(spec.aspects),
      lifecycle: spec.lifecycle === true,
      seq: ++this.#writes,
      revives: spec.revives === true,
      ...edit,
      bodies: new Map(spec.bodies ?? []),
      state: "queued",
      settled,
      settle,
    };
    // Writes to one aspect reach the host one at a time, in the order made:
    // a request already sent may still land late (no network order is
    // promised), so a newer write waits until every older overlapping one has
    // settled (a reply or a proof). An older one still queued, never sent,
    // that this one covers collapses into it: only the latest intent is sent.
    const blockers: Pending[] = [];
    for (const older of Array.from(this.#pending.values())) {
      if (older.projectId !== spec.projectId || !overlaps(older, pending)) continue;
      if (
        older.state === "queued" &&
        !older.lifecycle &&
        !pending.lifecycle &&
        covers(pending, older)
      ) {
        this.#supersede(older);
      } else if (!isSettled(older)) {
        blockers.push(older);
      }
    }
    this.#pending.set(commandId, pending);
    if (spec.projectId !== undefined) this.#paint(spec.projectId);
    if (blockers.length > 0) await Promise.all(blockers.map((older) => older.settled));

    let answer: Answer | undefined;
    for (let attempt = 1; ; attempt++) {
      if (pending.state !== "queued" && pending.state !== "retrying") break;
      pending.state = "sending";
      try {
        answer = await spec.send(commandId);
        this.#replied(pending, answer);
        break;
      } catch (error) {
        if ((pending.state as Pending["state"]) === "closed") {
          // Its Workspace closed while this attempt was out, outcome unknown.
          if (spec.quiet !== true) {
            this.#view.failed(`Couldn't ${spec.verb}: ${failureMessage(error)}`);
          }
          spec.onRefused?.(failureMessage(error));
          return { kind: "refused" };
        }
        // Proved (the feed named it) or superseded while this attempt was
        // out: its error answers nothing more.
        if ((pending.state as Pending["state"]) !== "sending") break;
        if (spec.goneMeansDone === true && attempt > 1 && isNotFound(error)) {
          this.#accept(pending, undefined);
          break;
        }
        if (!this.#isAmbiguous(error)) {
          this.#drop(pending, "refused");
          if (spec.quiet !== true) {
            this.#view.failed(`Couldn't ${spec.verb}: ${failureMessage(error)}`);
          }
          spec.onRefused?.(failureMessage(error));
          return { kind: "refused" };
        }
        if (attempt === this.#maxAttempts) {
          this.#view.unconfirmed?.(`Still trying to ${spec.verb}: ${failureMessage(error)}`);
        }
        pending.state = "retrying";
        await this.#retryDelay(pending, attempt);
      }
    }
    switch (pending.state) {
      case "accepted":
        return {
          kind: "accepted",
          answer: answer ?? spec.proved?.(pending) ?? (this.#provedAnswer(pending) as Answer),
        };
      case "superseded":
        return { kind: "superseded" };
      default:
        // Closed: its answer, if one came, is still its answer.
        if (answer !== undefined) return { kind: "accepted", answer };
        spec.onRefused?.("The board closed before the host answered");
        return { kind: "refused" };
    }
  }

  /** Waits out one retry delay, or less if a proof or a newer write settles the write first. */
  #retryDelay(pending: Pending, attempt: number): Promise<void> {
    const ms = this.#retryDelays[Math.min(attempt, this.#retryDelays.length) - 1]!;
    return new Promise((resolve) => {
      const done = (): void => {
        pending.wake = undefined;
        pending.retryTimer = undefined;
        resolve();
      };
      pending.wake = () => {
        this.#clearTimer(pending.retryTimer);
        done();
      };
      pending.retryTimer = this.#setTimer(done, ms);
    });
  }

  /** A reply: the host's word on the write, and on the row it answers with. */
  #replied(pending: Pending, answer: unknown): void {
    const { throughCursor, ticket } = answer as Partial<BoardWriteAnswer> & {
      ticket?: Ticket | null;
    };
    const workspace =
      pending.projectId === undefined ? undefined : this.#workspaces.get(pending.projectId);
    if (ticket != null && workspace !== undefined) {
      // A create's reply names its id; its body is the host's own, unless a
      // later write or read already set a newer one, or the ticket left.
      learnCreated(pending, ticket.id);
      this.#writtenBody(workspace, pending, ticket.id, ticket.body);
      pending.bodies.delete(ticket.id);
    }
    if (pending.state === "accepted") {
      // The feed proved it first: the reply only brings the row.
      if (workspace !== undefined) this.#paint(workspace.projectId);
      return;
    }
    this.#accept(pending, throughCursor);
  }

  /**
   * The first proof the host took a write: its body becomes the confirmed
   * one, its waiting retry stops, and its edit retires once the base holds
   * the cursor it was stamped through.
   */
  #accept(pending: Pending, through: string | undefined): void {
    // Already proved, or settled otherwise: a later word changes nothing.
    if (pending.state !== "sending" && pending.state !== "retrying") return;
    pending.state = "accepted";
    pending.through = through ?? pending.through;
    pending.settle();
    pending.wake?.();
    const workspace =
      pending.projectId === undefined ? undefined : this.#workspaces.get(pending.projectId);
    if (workspace === undefined) {
      this.#pending.delete(pending.commandId);
      return;
    }
    // The bodies the host took: a summary row never carries one (VC-387).
    for (const [ticketId, body] of pending.bodies) {
      this.#writtenBody(workspace, pending, ticketId, body);
    }
    if (pending.through === undefined || reaches(workspace.cursor, pending.through)) {
      this.#retire(pending);
    } else {
      this.#armConfirm(workspace, pending);
    }
    this.#paint(workspace.projectId);
  }

  /** The feed normally brings an accepted write's cursor; if it does not soon, a read does. */
  #armConfirm(workspace: Workspace, pending: Pending): void {
    pending.confirmTimer = this.#setTimer(() => {
      pending.confirmTimer = undefined;
      if (this.#pending.get(pending.commandId) === pending) this.#scheduleRead(workspace);
    }, this.#confirmTimeoutMs);
  }

  /** The base holds an accepted write's effect: its edit stops replaying. */
  #retire(pending: Pending): void {
    if (pending.confirmTimer !== undefined) this.#clearTimer(pending.confirmTimer);
    this.#pending.delete(pending.commandId);
  }

  /** A newer write covers this queued one: it is never sent, its edit is gone, its caller is told. */
  #supersede(pending: Pending): void {
    // Only a write never sent: nothing of it can reach the host.
    pending.tickets = undefined;
    pending.labels = undefined;
    pending.state = "superseded";
    pending.settle();
    this.#pending.delete(pending.commandId);
  }

  /** Drops a write that will not be proved: refused, or its Workspace closed. */
  #drop(pending: Pending, state: "refused" | "closed"): void {
    if (pending.confirmTimer !== undefined) this.#clearTimer(pending.confirmTimer);
    const wasAccepted = pending.state === "accepted";
    if (!wasAccepted) pending.state = state;
    pending.settle();
    pending.wake?.();
    this.#pending.delete(pending.commandId);
    if (pending.projectId !== undefined && state === "refused") this.#paint(pending.projectId);
  }

  /**
   * Retires every accepted write the base now holds: its cursor is at or
   * past theirs. After a snapshot, a write stamped on another feed is held
   * too: that feed's host took it, and a feed only ever gives way to a later
   * one (a restart, a new epoch), whose snapshot holds what it took.
   */
  #retireHeld(workspace: Workspace, snapshot = false): void {
    for (const pending of Array.from(this.#pending.values())) {
      if (pending.projectId !== workspace.projectId || pending.state !== "accepted") continue;
      // An accepted write without a cursor retired on its proof.
      const order = compareBoardCursors(workspace.cursor!, pending.through!);
      if ((order !== null && order >= 0) || (order === null && snapshot)) this.#retire(pending);
    }
  }

  // ---- the feed ---------------------------------------------------------------

  #follow(workspace: Workspace, cursor: string): void {
    workspace.stop = this.#transportFor(workspace.projectId).changes(workspace.projectId, cursor, {
      onBatch: (batch) => {
        if (workspace.closed) return;
        workspace.feedFailures = 0;
        this.#apply(workspace, batch);
      },
      onResnapshot: () => {
        if (workspace.closed) return;
        workspace.stop = null;
        void this.open(workspace.projectId).catch(() => {
          // Retried by `open` itself, with backoff.
        });
      },
      onError: () => {
        if (workspace.closed) return;
        this.#feedFailed(workspace);
      },
    });
  }

  /** A feed that ended in error resumes from the base's cursor, after a pause. */
  #feedFailed(workspace: Workspace): void {
    workspace.stop = null;
    const delay =
      this.#feedRetryDelays[Math.min(workspace.feedFailures, this.#feedRetryDelays.length - 1)]!;
    workspace.feedFailures += 1;
    this.#setTimer(() => {
      if (workspace.closed || workspace.stop !== null || workspace.openTimer !== undefined) return;
      this.#follow(workspace, workspace.cursor!);
    }, delay);
  }

  /** A snapshot that failed is read again after a pause, until it lands. */
  #reopenLater(workspace: Workspace): void {
    const delay =
      this.#feedRetryDelays[Math.min(workspace.openFailures, this.#feedRetryDelays.length - 1)]!;
    workspace.openFailures += 1;
    workspace.openTimer = this.#setTimer(() => {
      workspace.openTimer = undefined;
      /* v8 ignore if -- closing clears this timer; only a clear that lost its race lands here. */
      if (workspace.closed) return;
      void this.open(workspace.projectId).catch(() => {
        // Retried again by `open` itself.
      });
    }, delay);
  }

  /**
   * One feed batch. Its rows change the base only when it is newer than the
   * base (a read may already hold it); its notices and its proofs count
   * either way, since each is a fact whatever the base became.
   */
  #apply(workspace: Workspace, batch: BoardFeedBatch): void {
    // A feed is followed only from a snapshot's cursor.
    const order = compareBoardCursors(batch.cursor, workspace.cursor!);
    // Another feed's batch on this subscription: nothing it says can be placed.
    if (order === null) return;
    const newer = order > 0;
    let read = false;
    for (const change of batch.changes) {
      this.#notice(workspace, change, batch.cursor);
      if (!newer) continue;
      if (workspace.reader?.log != null) this.#log(workspace.reader, batch.cursor, change);
      read = this.#applyChange(workspace, change, batch.cursor) || read;
    }
    if (newer) workspace.cursor = batch.cursor;
    // Proofs: the changes naming a write of this window's.
    const named = new Map<Pending, BoardChange[]>();
    for (const change of batch.changes) {
      const pending =
        change.commandId === undefined ? undefined : this.#pending.get(change.commandId);
      if (pending !== undefined) named.set(pending, [...(named.get(pending) ?? []), change]);
    }
    for (const [pending, changes] of named) this.#proveFromFeed(pending, batch.cursor, changes);
    this.#retireHeld(workspace);
    this.#paint(workspace.projectId);
    if (read) this.#scheduleRead(workspace);
  }

  /** A batch named this write in `named`: the host took it, through this batch's cursor. */
  #proveFromFeed(pending: Pending, cursor: string, named: readonly BoardChange[]): void {
    for (const change of named) {
      // A create's own ticket row names its new id.
      if (change.kind === "ticket" && change.op === "upsert") learnCreated(pending, change.id);
      if (change.kind === "comment" && change.comment !== undefined)
        pending.fedRow = change.comment;
      if (change.kind === "project" && change.project !== undefined)
        pending.fedRow = change.project;
    }
    this.#accept(pending, cursor);
  }

  /** What a change tells the rest of the renderer: told once, whether or not the base takes its row. */
  #notice(workspace: Workspace, change: BoardChange, cursor: string): void {
    const { projectId } = workspace;
    switch (change.kind) {
      case "project":
        if (change.project !== undefined && !reaches(workspace.projectCursor, cursor)) {
          workspace.projectCursor = cursor;
          this.#view.adoptProject(change.project);
        }
        return;
      case "ticket":
        if (change.checkoutMoved === true) this.#view.checkoutMoved(change.id);
        // Another writer's change, or one without its row: per-ticket surfaces re-read.
        if (
          change.commandId === undefined ||
          (change.op === "upsert" && change.ticket === undefined)
        ) {
          this.#view.notePlanningChange({ ticketId: change.id, projectId });
        }
        return;
      case "comment":
      case "ticketEvent":
        this.#view.notePlanningChange({ ticketId: change.ticketId, projectId });
        return;
      default:
        return;
    }
  }

  /** Applies one newer change to the base; answers whether it asks for a read. */
  #applyChange(workspace: Workspace, change: BoardChange, cursor: string): boolean {
    switch (change.kind) {
      case "project":
        if (change.project !== undefined) return false;
        workspace.dirtyProject = cursor;
        return true;
      case "ticket":
        if (change.op === "delete") {
          workspace.tickets.delete(change.id);
          this.#forgetBodies(workspace, [change.id]);
        } else if (change.ticket === undefined) {
          workspace.dirty = cursor;
          return true;
        } else {
          workspace.tickets.set(change.id, change.ticket);
        }
        return false;
      case "label":
        if (change.op === "delete") workspace.labels.delete(change.id);
        else if (change.label === undefined) {
          workspace.dirty = cursor;
          return true;
        } else workspace.labels.set(change.id, change.label);
        return false;
      default:
        // Comments and ticket events are rows the board does not hold, and a
        // kind this build does not know names state another reader owns (HP:
        // the change kind is an open union).
        return false;
    }
  }

  /** Keeps a change for the in-flight read, latest per entity, within its bound. */
  #log(reader: Reader, cursor: string, change: BoardChange): void {
    const log = reader.log!;
    const key = `${change.kind}:${change.id}`;
    log.delete(key);
    log.set(key, { cursor, change });
    if (log.size > READ_LOG_ENTITIES) reader.log = null;
  }

  /** Whether `cursor` is newer than `than`: false when either is absent or they are of different feeds. */
  #after(cursor: string | null, than: string): boolean {
    if (cursor === null) return false;
    const order = compareBoardCursors(cursor, than);
    return order !== null && order > 0;
  }

  /** Drops the bodies of tickets that left the board. */
  #forgetBodies(workspace: Workspace, ticketIds: Iterable<string>): void {
    for (const ticketId of ticketIds) {
      workspace.bodies.delete(ticketId);
      workspace.bodySeq.delete(ticketId);
      workspace.bodyAt.delete(ticketId);
    }
  }

  // ---- reads ------------------------------------------------------------------

  /** One read per burst: coalesced, one in flight, at most one queued behind it. */
  #scheduleRead(workspace: Workspace): void {
    /* v8 ignore if -- closing clears every timer that asks; only a lost race lands here. */
    if (workspace.closed) return;
    // A read this generation started is asked to go again; one an older
    // generation started counts for nothing here (its answer is dropped).
    const reader = workspace.reader;
    if (reader !== null && reader.generation === workspace.generation) {
      reader.again = true;
      return;
    }
    if (workspace.readTimer !== undefined) return;
    workspace.readTimer = this.#setTimer(() => {
      workspace.readTimer = undefined;
      void this.#read(workspace);
    }, this.#readCoalesceMs);
  }

  /** Whether a rowless change is still uncovered by any read. */
  #dirty(workspace: Workspace): boolean {
    return workspace.dirty !== null || workspace.dirtyProject !== null;
  }

  /**
   * After a read that landed: an accepted write it still did not show (its
   * cursor is on another feed, say) waits for its cursor again, not in a loop.
   */
  #rearmConfirms(workspace: Workspace): void {
    for (const pending of this.#pending.values()) {
      if (
        pending.projectId === workspace.projectId &&
        pending.state === "accepted" &&
        pending.confirmTimer === undefined
      ) {
        this.#armConfirm(workspace, pending);
      }
    }
  }

  /** Whether the Workspace still needs a read: a rowless change uncovered, or a write unconfirmed. */
  #needsRead(workspace: Workspace): boolean {
    if (this.#dirty(workspace)) return true;
    for (const pending of this.#pending.values()) {
      if (
        pending.projectId === workspace.projectId &&
        pending.state === "accepted" &&
        pending.confirmTimer === undefined
      ) {
        return true;
      }
    }
    return false;
  }

  async #read(workspace: Workspace): Promise<void> {
    const { projectId } = workspace;
    const generation = workspace.generation;
    const withProject = workspace.dirtyProject !== null;
    const startedAt = this.#adoptions;
    const reader: Reader = { generation, log: new Map(), again: false };
    workspace.reader = reader;
    let failed = false;
    try {
      const answer = withProject
        ? await this.#transportFor(projectId).snapshot(projectId)
        : await this.#transportFor(projectId).roster(projectId);
      if (workspace.closed || workspace.generation !== generation || workspace.cursor === null) {
        return;
      }
      workspace.readFailures = 0;
      const order = compareBoardCursors(answer.cursor, workspace.cursor);
      // Another feed's answer (the host restarted under it): the feed's own
      // resnapshot replaces the base, never this.
      if (order === null) return;
      if (order < 0 && reader.log === null) {
        // Older than the base, and too much changed meanwhile to replay: read again.
        reader.again = true;
        return;
      }
      const log = order < 0 ? [...reader.log!.values()] : [];
      const removed = new Set(workspace.tickets.keys());
      workspace.tickets.clear();
      for (const row of answer.tickets) {
        const { body, ...summary } = row as Ticket;
        workspace.tickets.set(summary.id, summary);
        // A snapshot's bodies are confirmed ones, never over one this window
        // adopted after the read began, nor (read older than the base) over any it holds.
        if (withProject && (order >= 0 || !workspace.bodies.has(summary.id))) {
          this.#readBody(workspace, summary.id, body, startedAt);
        }
      }
      workspace.labels.clear();
      for (const label of answer.labels) workspace.labels.set(label.id, label);
      // What the feed delivered after the read's cursor replays over it, so a
      // slow read never moves the board backwards.
      const answered = answer.cursor;
      for (const { cursor, change } of log) {
        if (this.#after(cursor, answered)) this.#applyChange(workspace, change, cursor);
      }
      for (const id of workspace.tickets.keys()) removed.delete(id);
      this.#forgetBodies(workspace, removed);
      if (order > 0) workspace.cursor = answered;
      if (!this.#after(workspace.dirty, answered)) workspace.dirty = null;
      if (withProject) {
        if (!this.#after(workspace.dirtyProject, answered)) workspace.dirtyProject = null;
        // Unless the feed already brought a newer project row.
        if (!this.#after(workspace.projectCursor, answered)) {
          workspace.projectCursor = answered;
          this.#view.adoptProject((answer as unknown as { project: Project }).project);
        }
      }
      this.#retireHeld(workspace);
      this.#paint(projectId);
    } catch (error) {
      failed = true;
      if (workspace.readFailures === 0) {
        this.#view.failed(`Couldn't refresh the board: ${failureMessage(error)}`);
      }
      workspace.readFailures += 1;
    } finally {
      // Only this read's own state: a newer generation's reader and its
      // queued work are that generation's.
      if (workspace.reader === reader) workspace.reader = null;
      if (!workspace.closed && workspace.generation === generation) {
        if (!failed) this.#rearmConfirms(workspace);
        if (failed && this.#needsRead(workspace)) {
          // Retried with backoff until a read lands: a pending edit never sticks.
          const delay =
            this.#feedRetryDelays[
              Math.min(workspace.readFailures - 1, this.#feedRetryDelays.length - 1)
            ]!;
          workspace.readTimer = this.#setTimer(() => {
            workspace.readTimer = undefined;
            void this.#read(workspace);
          }, delay);
        } else if (reader.again || (!failed && this.#dirty(workspace))) {
          this.#scheduleRead(workspace);
        }
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
      const body = workspace.bodies.get(summary.id);
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

/** The key a create's body sits under until its ticket's id is known. */
const CREATED = "\u0000created";

/** A create learns its ticket's id (its reply, or the feed row naming it): its body moves to that id. */
function learnCreated(pending: Pending, ticketId: string): void {
  const body = pending.bodies.get(CREATED);
  if (body === undefined) return;
  pending.createdId = ticketId;
  pending.bodies.delete(CREATED);
  pending.bodies.set(ticketId, body);
}

function isSettled(pending: Pending): boolean {
  return pending.state !== "queued" && pending.state !== "sending" && pending.state !== "retrying";
}

function overlaps(left: Pending, right: Pending): boolean {
  for (const aspect of left.aspects) if (right.aspects.has(aspect)) return true;
  return false;
}

/** Whether `newer` sets every aspect `older` sets. */
function covers(newer: Pending, older: Pending): boolean {
  for (const aspect of older.aspects) if (!newer.aspects.has(aspect)) return false;
  return true;
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
