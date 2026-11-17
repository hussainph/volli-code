/**
 * This Mac's board behind {@link BoardSource} (VC-1260): the local IPC
 * adapter, over `window.api`'s own board channels, for every project of a
 * local launch that no other source delivers (`board-source.ts`).
 *
 * Unlike Volli Cloud's source and the protocol engine, it holds no rows of its
 * own: the board store's slices are this Mac's rows, seeded by the boot
 * hydrate and every planning refresh. So each write paints the store through
 * {@link LocalBoardView} at once, writes through (`mutate.ts`, which surfaces
 * every failure), and reconciles the authoritative answer into the slice read
 * FRESH, or reverts its own change on failure.
 */
import {
  moveTicket as moveTicketOp,
  moveTickets as moveTicketsOp,
  setTicketPriority as setTicketPriorityOp,
  type ArchivedTicket,
  type DeliberateMoveChoice,
  type HarnessId,
  type Label,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";
import type {
  ArchivedTicketsResult,
  LabelResult,
  Result,
  TicketResult,
  TicketsResult,
} from "../../../ipc/contract";

import type { BoardApi } from "@renderer/lib/board-api";

import type { BoardSource, CreateFields, UpdateFields } from "./board-source";
import { writeThrough } from "./mutate";

/** The subset of the preload API this Mac's board writes need. */
interface BoardGateway {
  createTicket(input: {
    projectId: string;
    status: TicketStatus;
    title: string;
    priority?: TicketPriority;
    /** Markdown; becomes the agent prompt on kickoff. Defaults to `""` in main. */
    body?: string;
    /** Label names; created per project (name-deduped, `color: null`). Defaults to `[]`. */
    labels?: string[];
    /** Whether the ticket boots its agent in an isolated worktree. Defaults to `true`. */
    usesWorktree?: boolean;
    /** The ticket's persisted default harness (kickoff choice). Defaults to the DB default. */
    preferredHarnessId?: HarnessId;
    /**
     * The ref the ticket's worktree branches from (the composer's base-branch
     * chip). Omitted leaves it unset and `resolveBaseBranch` detects the
     * project default at worktree time, as it always has.
     */
    baseBranch?: string | null;
  }): Promise<TicketResult>;
  moveTicket(input: {
    projectId: string;
    ticketId: string;
    toStatus: TicketStatus;
    toIndex: number;
    choice?: DeliberateMoveChoice;
  }): Promise<TicketsResult>;
  moveTickets(input: {
    projectId: string;
    ticketIds: string[];
    toStatus: TicketStatus;
    toIndex: number;
    choice?: DeliberateMoveChoice;
  }): Promise<TicketsResult>;
  setTicketPriority(input: { ticketId: string; priority: TicketPriority }): Promise<TicketResult>;
  updateTicket(input: {
    ticketId: string;
    title?: string;
    body?: string;
    branch?: string | null;
    baseBranch?: string | null;
    usesWorktree?: boolean;
  }): Promise<TicketResult>;
  setLabels(input: { ticketId: string; labels: string[] }): Promise<TicketResult>;
  setLabelColor(input: { labelId: string; color: string | null }): Promise<LabelResult>;
  archiveTicket(input: { ticketId: string }): Promise<Result>;
  unarchiveTicket(input: { ticketId: string }): Promise<TicketResult>;
  deleteTicket(input: { ticketId: string }): Promise<Result>;
  listArchived(projectId: string): Promise<ArchivedTicketsResult>;
}

const windowBoardGateway: BoardGateway = {
  createTicket: (input) => window.api.tickets.create(input),
  moveTicket: (input) => window.api.tickets.move(input),
  moveTickets: (input) => window.api.tickets.moveMany(input),
  setTicketPriority: (input) => window.api.tickets.setPriority(input),
  updateTicket: (input) => window.api.tickets.update(input),
  setLabels: (input) => window.api.tickets.setLabels(input),
  setLabelColor: (input) => window.api.labels.setColor(input),
  archiveTicket: (input) => window.api.tickets.archive(input),
  unarchiveTicket: (input) => window.api.tickets.unarchive(input),
  deleteTicket: (input) => window.api.tickets.delete(input),
  listArchived: (projectId) => window.api.tickets.listArchived(projectId),
};

/**
 * The per-surface door over `window.api`'s own functions, untouched, each
 * read when called.
 */
export function windowBoardApi(): BoardApi {
  return {
    tickets: {
      events: (input) => window.api.tickets.events(input),
      body: (input) => window.api.tickets.body(input),
      latestSignals: (input) => window.api.tickets.latestSignals(input),
      statusEntries: (input) => window.api.tickets.statusEntries(input),
    },
    comments: {
      list: (input) => window.api.comments.list(input),
      create: (input) => window.api.comments.create(input),
      update: (input) => window.api.comments.update(input),
      remove: (input) => window.api.comments.remove(input),
    },
    projects: {
      update: (input) => window.api.projects.update(input),
      setSkillModes: (input) => window.api.projects.setSkillModes(input),
      setSessionDefaults: (input) => window.api.projects.setSessionDefaults(input),
      checkFolder: (projectId) => window.api.projects.checkFolder(projectId),
    },
  };
}

/** The board store's slices, as this Mac's board writes paint and reconcile them. */
export interface LocalBoardView {
  /** The project's live tickets, or `undefined` for a project the store does not hold. */
  tickets(projectId: string): Ticket[] | undefined;
  /** Sets the project's slice outright: a move's optimistic paint. */
  setTickets(projectId: string, tickets: Ticket[]): void;
  /**
   * Applies `update` to the project's slice read FRESH, unless the project
   * was forgotten meanwhile (never resurrect a slice SQLite no longer has).
   */
  reconcileTickets(projectId: string, update: (slice: Ticket[]) => Ticket[]): void;
  labels(projectId: string): Label[] | undefined;
  /** The label-slice sibling of {@link LocalBoardView.reconcileTickets}. */
  reconcileLabels(projectId: string, update: (slice: Label[]) => Label[]): void;
  /** The ticket and its project, wherever the store holds it. */
  findTicket(ticketId: string): { projectId: string; ticket: Ticket } | undefined;
  /** The ticket's body is canonical now (VC-387). */
  markBodyLoaded(ticketId: string): void;
}

/**
 * The `authoritative` list, plus any ticket in `current` it doesn't mention —
 * a ticket created (in another action) while the mutation that produced
 * `authoritative` was in flight, not yet reflected in its snapshot. Preserving
 * those "extras" is what keeps a concurrent create (or a revert) from silently
 * dropping a ticket SQLite already holds. Returns `authoritative` unchanged
 * (same reference) when there are no extras — the common case.
 */
function mergeAuthoritative(authoritative: Ticket[], current: Ticket[]): Ticket[] {
  const ids = new Set(authoritative.map((ticket) => ticket.id));
  const extras = current.filter((ticket) => !ids.has(ticket.id));
  return extras.length === 0 ? authoritative : [...authoritative, ...extras];
}

/**
 * `slice` with `ticket` restored at `index` (clamped into range) — the shared
 * failure-revert shape, a no-op when a concurrent mutation already put the
 * ticket back. Restoring at the ORIGINAL index (not appending) matters for the
 * Archive slice, whose array order (newest-archived first) the Archive view
 * renders verbatim — an appended revert would sink the ticket to the bottom.
 */
export function restoreAt<T extends { id: string }>(slice: T[], ticket: T, index: number): T[] {
  if (slice.some((existing) => existing.id === ticket.id)) return slice;
  const at = Math.max(0, Math.min(index, slice.length));
  return [...slice.slice(0, at), ticket, ...slice.slice(at)];
}

interface MoveLane {
  /** Requests execute in commit order even when several optimistic drops overlap. */
  tail: Promise<void>;
  /** The newest optimistic move currently represented on screen. */
  revision: number;
  /** Last authoritative slice, used if the newest queued move fails. */
  confirmed: Ticket[];
}

export class LocalBoardSource implements BoardSource {
  /** This Mac's rows reach the store by the boot hydrate and every refresh, not from here. */
  readonly deliversOwnRows = false;
  readonly api: BoardApi = windowBoardApi();
  readonly #view: LocalBoardView;
  readonly #gateway: BoardGateway = windowBoardGateway;
  readonly #moveLanes = new Map<string, MoveLane>();

  constructor(view: LocalBoardView) {
    this.#view = view;
  }

  /** This Mac's database always holds its boards: there is nothing to start following. */
  follows(_projectId: string): boolean {
    return true;
  }

  projectOf(ticketId: string): string | undefined {
    return this.#view.findTicket(ticketId)?.projectId;
  }

  async open(_projectId: string): Promise<void> {}

  close(_projectId: string): void {}

  closeAll(): void {}

  /** The store's slice already holds the body (`adoptTicketBody`). */
  adoptBody(_ticketId: string, _body: string): void {}

  async createTicket(projectId: string, fields: CreateFields): Promise<Ticket | null> {
    const result = await writeThrough("create ticket", (): Promise<TicketResult> =>
      this.#gateway.createTicket({
        projectId,
        status: fields.status,
        title: fields.title,
        priority: fields.priority,
        body: fields.body,
        labels: fields.labels,
        usesWorktree: fields.usesWorktree,
        preferredHarnessId: fields.preferredHarnessId,
        baseBranch: fields.baseBranch,
      }),
    );
    if (!result) return null;

    // Append to the FRESH slice; the view drops the write if the project was
    // removed while the create was in flight (the row is cascade-deleted in
    // SQLite), so we never resurrect a dead slice.
    this.#view.reconcileTickets(projectId, (slice) => [...slice, result.ticket]);
    return result.ticket;
  }

  async moveTicket(
    projectId: string,
    ticketId: string,
    toStatus: TicketStatus,
    toIndex: number,
    choice?: DeliberateMoveChoice,
  ): Promise<void> {
    await this.#persistMove(
      projectId,
      (previous) => moveTicketOp(previous, ticketId, toStatus, toIndex, Date.now()),
      "move ticket",
      () =>
        this.#gateway.moveTicket({
          projectId,
          ticketId,
          toStatus,
          toIndex,
          ...(choice === undefined ? {} : { choice }),
        }),
    );
  }

  async moveTickets(
    projectId: string,
    ticketIds: string[],
    toStatus: TicketStatus,
    toIndex: number,
    choice?: DeliberateMoveChoice,
  ): Promise<void> {
    await this.#persistMove(
      projectId,
      (previous) => moveTicketsOp(previous, ticketIds, toStatus, toIndex, Date.now()),
      "move tickets",
      () =>
        this.#gateway.moveTickets({
          projectId,
          ticketIds,
          toStatus,
          toIndex,
          ...(choice === undefined ? {} : { choice }),
        }),
    );
  }

  async setPriority(projectId: string, ticketId: string, priority: TicketPriority): Promise<void> {
    const previous = this.#view.tickets(projectId) ?? [];
    const original = previous.find((ticket) => ticket.id === ticketId);
    const optimistic = setTicketPriorityOp(previous, ticketId, priority, Date.now());
    if (!original || optimistic === previous) return; // unknown id or unchanged priority
    this.#view.setTickets(projectId, optimistic);

    // Priority never reorders a column (the shared op only edits the
    // ticket's fields), so reconcile by patching just this one ticket by id
    // into the FRESH slice — leaving any sibling a concurrent mutation
    // touched untouched.
    const patch = (ticket: Ticket) =>
      this.#view.reconcileTickets(projectId, (slice) =>
        slice.map((existing) => (existing.id === ticket.id ? ticket : existing)),
      );

    const result = await writeThrough("update priority", (): Promise<TicketResult> =>
      this.#gateway.setTicketPriority({ ticketId, priority }),
    );
    if (!result) {
      patch(original);
      return;
    }
    patch(result.ticket);
  }

  async updateTicket(_projectId: string, input: UpdateFields): Promise<Ticket | null> {
    const { ticketId, ...changes } = input;
    // Only the fields the caller actually supplied — `undefined` means
    // "leave as-is", matching `api.tickets.update`'s own semantics.
    const optimisticFields: Partial<Ticket> = {};
    if (changes.title !== undefined) optimisticFields.title = changes.title;
    if (changes.body !== undefined) optimisticFields.body = changes.body;
    if (changes.branch !== undefined) optimisticFields.branch = changes.branch;
    if (changes.baseBranch !== undefined) optimisticFields.baseBranch = changes.baseBranch;
    if (changes.usesWorktree !== undefined) optimisticFields.usesWorktree = changes.usesWorktree;
    return this.#optimisticTicketPatch(ticketId, optimisticFields, "update ticket", () =>
      this.#gateway.updateTicket(input),
    );
  }

  async setLabels(_projectId: string, ticketId: string, labels: string[]): Promise<void> {
    await this.#optimisticTicketPatch(ticketId, { labels }, "update labels", () =>
      this.#gateway.setLabels({ ticketId, labels }),
    );
  }

  async setLabelColor(projectId: string, labelId: string, color: string | null): Promise<void> {
    const original = this.#view.labels(projectId)?.find((label) => label.id === labelId);
    if (!original || original.color === color) return; // unknown id or unchanged color

    const patch = (label: Label) =>
      this.#view.reconcileLabels(projectId, (slice) =>
        slice.map((existing) => (existing.id === label.id ? label : existing)),
      );
    patch({ ...original, color });

    const result = await writeThrough("update label color", (): Promise<LabelResult> =>
      this.#gateway.setLabelColor({ labelId, color }),
    );
    if (!result) {
      patch(original);
      return;
    }
    patch(result.label);
  }

  async archiveTicket(projectId: string, ticketId: string): Promise<boolean> {
    const previous = this.#view.tickets(projectId) ?? [];
    const target = previous.find((ticket) => ticket.id === ticketId);
    if (!target) return false; // unknown id — nothing to archive
    const index = previous.indexOf(target);

    // Optimistically drop the card from the board.
    this.#view.reconcileTickets(projectId, (slice) =>
      slice.filter((ticket) => ticket.id !== ticketId),
    );

    const result = await writeThrough("archive ticket", (): Promise<Result> =>
      this.#gateway.archiveTicket({ ticketId }),
    );
    if (!result) {
      // Revert: restore the card into the FRESH slice, unless a concurrent
      // mutation already put it back.
      this.#view.reconcileTickets(projectId, (slice) => restoreAt(slice, target, index));
      return false;
    }
    // Success — drop it from the board slice AGAIN: a move IPC in flight
    // when the archive committed returns an authoritative list snapshotted
    // while this ticket was still live, and mergeAuthoritative would have
    // resurrected it as an "extra". Responses arrive in send order, so
    // this later word wins.
    this.#view.reconcileTickets(projectId, (slice) =>
      slice.filter((ticket) => ticket.id !== ticketId),
    );
    return true;
  }

  async unarchiveTicket(projectId: string, archived: ArchivedTicket): Promise<Ticket | null> {
    const result = await writeThrough("unarchive ticket", (): Promise<TicketResult> =>
      this.#gateway.unarchiveTicket({ ticketId: archived.id }),
    );
    if (!result) return null;
    // Append the revived LIVE ticket to the board (the view drops it if the
    // project was forgotten mid-flight — never resurrect a dead slice).
    const revived = result.ticket;
    this.#view.reconcileTickets(projectId, (slice) =>
      slice.some((ticket) => ticket.id === revived.id) ? slice : [...slice, revived],
    );
    return revived;
  }

  async deleteTicket(_projectId: string, ticketId: string): Promise<boolean> {
    const result = await writeThrough("delete ticket", (): Promise<Result> =>
      this.#gateway.deleteTicket({ ticketId }),
    );
    return result !== null;
  }

  async archivedTickets(projectId: string): Promise<ArchivedTicket[] | null> {
    const result = await writeThrough("load archive", (): Promise<ArchivedTicketsResult> =>
      this.#gateway.listArchived(projectId),
    );
    return result === null ? null : result.tickets;
  }

  /**
   * The shared optimistic-patch pipeline behind {@link LocalBoardSource.updateTicket}
   * and {@link LocalBoardSource.setLabels} — both are ticket-scoped field edits with
   * the identical skeleton. Optimistically merges `optimisticFields` into the
   * ticket, runs the write, and on success patches the authoritative ticket in
   * by id. On FAILURE it reverts only the keys THIS call touched back to their
   * pre-mutation values (merged onto the ticket read FRESH from state) — not a
   * whole-ticket snapshot, which would clobber a field a concurrent successful
   * edit committed while this write was in flight (e.g. a title save failing
   * after a body save succeeded must not resurrect the old body). A no-op (no
   * IPC) for an unknown ticket id.
   */
  async #optimisticTicketPatch(
    ticketId: string,
    optimisticFields: Partial<Ticket>,
    verb: string,
    call: () => Promise<TicketResult>,
  ): Promise<Ticket | null> {
    const found = this.#view.findTicket(ticketId);
    if (!found) return null; // unknown ticket id — nothing to update
    const { projectId, ticket: original } = found;

    const patchById = (ticket: Ticket) =>
      this.#view.reconcileTickets(projectId, (slice) =>
        slice.map((existing) => (existing.id === ticket.id ? ticket : existing)),
      );

    // The pre-mutation values of exactly the keys we're about to change — the
    // field-scoped revert set, captured before the optimistic write.
    const revertFields: Partial<Ticket> = {};
    for (const key of Object.keys(optimisticFields) as (keyof Ticket)[]) {
      (revertFields as Record<keyof Ticket, unknown>)[key] = original[key];
    }

    patchById({ ...original, ...optimisticFields });

    const result = await writeThrough(verb, call);
    if (!result) {
      // Field-scoped revert onto the FRESH ticket: restore only our keys,
      // leaving any field a concurrent edit changed in between intact.
      this.#view.reconcileTickets(projectId, (slice) =>
        slice.map((existing) =>
          existing.id === ticketId ? { ...existing, ...revertFields } : existing,
        ),
      );
      return null;
    }
    // The authoritative ticket main answers with always carries the real body,
    // whatever field this call edited — so landing it retires any placeholder
    // mark the roster left on this ticket.
    patchById(result.ticket);
    this.#view.markBodyLoaded(ticketId);
    return result.ticket;
  }

  /** Shared optimistic/write-through/reconcile path for one-card and group moves. */
  async #persistMove(
    projectId: string,
    optimisticMove: (previous: Ticket[]) => Ticket[],
    verb: string,
    call: () => Promise<TicketsResult>,
  ): Promise<void> {
    const previous = this.#view.tickets(projectId) ?? [];
    const optimistic = optimisticMove(previous);
    if (optimistic === previous) return;
    this.#view.setTickets(projectId, optimistic);

    const moveLanes = this.#moveLanes;
    let lane = moveLanes.get(projectId);
    if (lane === undefined) {
      lane = { tail: Promise.resolve(), revision: 0, confirmed: previous };
      moveLanes.set(projectId, lane);
    }
    const revision = ++lane.revision;
    const write = lane.tail.then(async () => {
      const result = await writeThrough(verb, call);
      if (result) lane.confirmed = result.tickets;

      // A later optimistic drop is already on screen. Its queued request must
      // be the one that reconciles; applying this older snapshot would make
      // the renderer disagree with SQLite until an unrelated refresh.
      if (revision !== lane.revision) return;
      this.#view.reconcileTickets(projectId, (slice) => mergeAuthoritative(lane.confirmed, slice));
    });
    lane.tail = write;
    await write;
    if (moveLanes.get(projectId) === lane && lane.tail === write) moveLanes.delete(projectId);
  }
}
