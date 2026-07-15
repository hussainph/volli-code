/**
 * Per-project board: tickets + labels (SQLite-backed, migration 001) plus the
 * board's search/filter and card-selection state, which stay SESSION-ONLY —
 * like the rest of the app's transient UI, they reset on relaunch instead of
 * following the ticket data. Selection lives here rather than in the board
 * component so other surfaces (the sidebar's Active Sessions) can select a
 * card too.
 *
 * `hydrate` is the ONE place `ticketsByProject`/`labelsByProject` are seeded
 * wholesale, from the boot payload (see lib/boot.ts); every mutation after
 * that is an async write-through via `gateway` that reconciles the
 * authoritative result or reverts on failure, surfacing every failure via a
 * toast (CLAUDE.md: never silently swallow a failed mutation).
 */
import {
  EMPTY_TICKET_FILTER,
  moveTicket as moveTicketOp,
  setTicketPriority as setTicketPriorityOp,
  type ArchivedTicket,
  type ArchivedTicketsResult,
  type Label,
  type Result,
  type Ticket,
  type TicketFilter,
  type TicketPriority,
  type TicketResult,
  type TicketsResult,
  type TicketStatus,
} from "@volli/shared";
import { create } from "zustand";

import { killTicketSessions } from "@renderer/terminal/session-lifecycle";

import { writeThrough } from "./mutate";

/** The subset of the preload API the board store needs — narrow and fake-able for tests. */
export interface BoardGateway {
  createTicket(input: {
    projectId: string;
    status: TicketStatus;
    title: string;
    priority?: TicketPriority;
  }): Promise<TicketResult>;
  moveTicket(input: {
    projectId: string;
    ticketId: string;
    toStatus: TicketStatus;
    toIndex: number;
  }): Promise<TicketsResult>;
  setTicketPriority(input: { ticketId: string; priority: TicketPriority }): Promise<TicketResult>;
  updateTicket(input: {
    ticketId: string;
    title?: string;
    body?: string;
    worktreePath?: string | null;
    branch?: string | null;
    baseBranch?: string | null;
  }): Promise<TicketResult>;
  setLabels(input: { ticketId: string; labels: string[] }): Promise<TicketResult>;
  archiveTicket(input: { ticketId: string }): Promise<Result>;
  unarchiveTicket(input: { ticketId: string }): Promise<TicketResult>;
  deleteTicket(input: { ticketId: string }): Promise<Result>;
  listArchived(projectId: string): Promise<ArchivedTicketsResult>;
}

const defaultGateway: BoardGateway = {
  createTicket: (input) => window.api.tickets.create(input),
  moveTicket: (input) => window.api.tickets.move(input),
  setTicketPriority: (input) => window.api.tickets.setPriority(input),
  updateTicket: (input) => window.api.tickets.update(input),
  setLabels: (input) => window.api.tickets.setLabels(input),
  archiveTicket: (input) => window.api.tickets.archive(input),
  unarchiveTicket: (input) => window.api.tickets.unarchive(input),
  deleteTicket: (input) => window.api.tickets.delete(input),
  listArchived: (projectId) => window.api.tickets.listArchived(projectId),
};

interface BoardState {
  ticketsByProject: Record<string, Ticket[]>;
  labelsByProject: Record<string, Label[]>;
  /**
   * A project's archived tickets — cold storage for the Archive view, kept OUT
   * of `ticketsByProject` (the board holds only live cards) and loaded on
   * demand via {@link BoardState.loadArchived}, not at boot. A missing entry
   * means "not loaded yet", not "no archived tickets".
   */
  archivedByProject: Record<string, ArchivedTicket[]>;
  /** Session-only — never persisted; see module doc. */
  filterByProject: Record<string, TicketFilter>;
  /** The selected card per project. Session-only — never persisted; see module doc. */
  selectedByProject: Record<string, string | null>;
  /** Seeds tickets/labels from the boot payload — the ONE place state is set wholesale outside a mutation. */
  hydrate(
    ticketsByProject: Record<string, Ticket[]>,
    labelsByProject: Record<string, Label[]>,
  ): void;
  moveTicket(
    projectId: string,
    ticketId: string,
    toStatus: TicketStatus,
    toIndex: number,
  ): Promise<void>;
  /**
   * Creates a ticket in `status`'s column via `gateway`. Returns the created
   * {@link Ticket}, or `null` when the trimmed title is empty (no-op, no IPC
   * call) or the creation failed (already toasted) — callers that need the
   * new ticket (e.g. the global New-ticket dialog, to toast its display id)
   * can await the return value; the inline column composers ignore it.
   */
  addTicket(
    projectId: string,
    status: TicketStatus,
    title: string,
    options?: { priority?: TicketPriority },
  ): Promise<Ticket | null>;
  setTicketPriority(projectId: string, ticketId: string, priority: TicketPriority): Promise<void>;
  /**
   * Patches a ticket's title/body/worktree-identity fields via `api.tickets.update`
   * (ticket-detail-mvp step 3). Ticket-scoped, not project-scoped — the ticket's
   * project is located by scanning `ticketsByProject` for it, so callers (the
   * properties rail's branch/baseBranch fields today; step 4's title/body
   * autosave next) only need the ticket's id. Optimistic; reverts to the
   * pre-patch ticket on failure. A no-op (no IPC) for an unknown ticket id.
   */
  updateTicket(input: {
    ticketId: string;
    title?: string;
    body?: string;
    worktreePath?: string | null;
    branch?: string | null;
    baseBranch?: string | null;
  }): Promise<void>;
  /**
   * Replaces a ticket's labels wholesale via `api.tickets.setLabels`. Same
   * ticket-scoped shape as {@link BoardState.updateTicket}. Optimistic;
   * reverts to the pre-edit label set on failure.
   */
  setLabels(ticketId: string, labels: string[]): Promise<void>;
  /**
   * Fetches the project's archived tickets into `archivedByProject` (the
   * Archive view calls this on open). Resolves `false` when the fetch failed
   * (already toasted) so the view can show a retry state instead of an
   * indefinite "Loading…".
   */
  loadArchived(projectId: string): Promise<boolean>;
  /** Archives a ticket: optimistically removes it from the board, reverting (and toasting) on failure. */
  archiveTicket(projectId: string, ticketId: string): Promise<void>;
  /** Returns an archived ticket to the board: drops it from the Archive slice and appends the revived live ticket. */
  unarchiveTicket(projectId: string, ticketId: string): Promise<void>;
  /** Permanently deletes an archived ticket (the only destructive act); optimistic, reverts on failure. */
  deleteArchivedTicket(projectId: string, ticketId: string): Promise<void>;
  setSearch(projectId: string, search: string): void;
  togglePriority(projectId: string, priority: TicketPriority): void;
  toggleLabel(projectId: string, label: string): void;
  clearFilter(projectId: string): void;
  selectTicket(projectId: string, ticketId: string | null): void;
  forget(projectId: string): void;
}

/** Toggles `value` in `values`: drops it if present, appends it otherwise. */
function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
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
function restoreAt<T extends { id: string }>(slice: T[], ticket: T, index: number): T[] {
  if (slice.some((existing) => existing.id === ticket.id)) return slice;
  const at = Math.max(0, Math.min(index, slice.length));
  return [...slice.slice(0, at), ticket, ...slice.slice(at)];
}

/** Factory so tests can inject a fake gateway instead of the real preload bridge. */
export function createBoardStore(gateway: BoardGateway = defaultGateway) {
  return create<BoardState>()((set, get) => {
    /**
     * Merges a change into the project's filter record (initializing from
     * {@link EMPTY_TICKET_FILTER}) — the one write path behind the four
     * facet actions, mirroring workspace.ts's `patchWorkspace`.
     */
    function patchFilter(
      projectId: string,
      changes: (current: TicketFilter) => Partial<TicketFilter>,
    ): void {
      const { filterByProject } = get();
      const current = filterByProject[projectId] ?? EMPTY_TICKET_FILTER;
      set({
        filterByProject: {
          ...filterByProject,
          [projectId]: { ...current, ...changes(current) },
        },
      });
    }

    /**
     * Applies `update` to the project's ticket slice read FRESH from state (so
     * a mutation that landed on another card mid-flight isn't clobbered),
     * guarding a slice the project's removal (`forget`) dropped while the IPC
     * was in flight — never resurrect a slice SQLite no longer has. The single
     * reconcile path behind every ticket mutation's success and revert.
     */
    function reconcileSlice(projectId: string, update: (slice: Ticket[]) => Ticket[]): void {
      const byProject = get().ticketsByProject;
      const slice: Ticket[] | undefined = byProject[projectId];
      if (!slice) return;
      set({ ticketsByProject: { ...byProject, [projectId]: update(slice) } });
    }

    /**
     * Locates `ticketId` across every project's slice — the lookup behind
     * {@link BoardState.updateTicket}/{@link BoardState.setLabels}, whose
     * signatures (deliberately) take no `projectId`: both are ticket-scoped
     * mutations reachable from a context (the ticket detail view) that already
     * has the ticket in hand, not the project id. `undefined` for an unknown
     * ticket id.
     */
    function findTicketProject(
      ticketId: string,
    ): { projectId: string; ticket: Ticket } | undefined {
      for (const [projectId, tickets] of Object.entries(get().ticketsByProject)) {
        const ticket = tickets.find((candidate) => candidate.id === ticketId);
        if (ticket) return { projectId, ticket };
      }
      return undefined;
    }

    /**
     * The Archive-slice analog of {@link reconcileSlice}: applies `update` to
     * the project's archived list read FRESH from state, guarding a slice that
     * was never loaded (or was dropped by `forget` while an IPC was in flight)
     * — never resurrect Archive data the store isn't holding.
     */
    function reconcileArchived(
      projectId: string,
      update: (slice: ArchivedTicket[]) => ArchivedTicket[],
    ): void {
      const byProject = get().archivedByProject;
      const slice: ArchivedTicket[] | undefined = byProject[projectId];
      if (!slice) return;
      set({ archivedByProject: { ...byProject, [projectId]: update(slice) } });
    }

    /**
     * The shared optimistic-patch pipeline behind {@link BoardState.updateTicket}
     * and {@link BoardState.setLabels} — both are ticket-scoped field edits with
     * the identical skeleton. Optimistically merges `optimisticFields` into the
     * ticket, runs the write, and on success patches the authoritative ticket in
     * by id. On FAILURE it reverts only the keys THIS call touched back to their
     * pre-mutation values (merged onto the ticket read FRESH from state) — not a
     * whole-ticket snapshot, which would clobber a field a concurrent successful
     * edit committed while this write was in flight (e.g. a title save failing
     * after a body save succeeded must not resurrect the old body). A no-op (no
     * IPC) for an unknown ticket id.
     */
    async function optimisticTicketPatch(
      ticketId: string,
      optimisticFields: Partial<Ticket>,
      verb: string,
      call: () => Promise<TicketResult>,
    ): Promise<void> {
      const found = findTicketProject(ticketId);
      if (!found) return; // unknown ticket id — nothing to update
      const { projectId, ticket: original } = found;

      const patchById = (ticket: Ticket) =>
        reconcileSlice(projectId, (slice) =>
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
        reconcileSlice(projectId, (slice) =>
          slice.map((existing) =>
            existing.id === ticketId ? { ...existing, ...revertFields } : existing,
          ),
        );
        return;
      }
      patchById(result.ticket);
    }

    return {
      ticketsByProject: {},
      labelsByProject: {},
      archivedByProject: {},
      filterByProject: {},
      selectedByProject: {},

      hydrate(ticketsByProject, labelsByProject) {
        set({ ticketsByProject, labelsByProject });
      },

      async addTicket(projectId, status, title, options) {
        const trimmed = title.trim();
        if (trimmed === "") return null;

        const result = await writeThrough(
          "create ticket",
          (): Promise<TicketResult> =>
            gateway.createTicket({
              projectId,
              status,
              title: trimmed,
              priority: options?.priority,
            }),
        );
        if (!result) return null;

        // Append to the FRESH slice; `reconcileSlice` drops the write if the
        // project was removed while the create was in flight (the row is
        // cascade-deleted in SQLite), so we never resurrect a dead slice.
        reconcileSlice(projectId, (slice) => [...slice, result.ticket]);
        return result.ticket;
      },

      async moveTicket(projectId, ticketId, toStatus, toIndex) {
        const previous = get().ticketsByProject[projectId] ?? [];
        const optimistic = moveTicketOp(previous, ticketId, toStatus, toIndex, Date.now());
        if (optimistic === previous) return; // shared op's no-op guard: unknown id or unchanged position
        set({ ticketsByProject: { ...get().ticketsByProject, [projectId]: optimistic } });

        const result = await writeThrough(
          "move ticket",
          (): Promise<TicketsResult> =>
            gateway.moveTicket({ projectId, ticketId, toStatus, toIndex }),
        );
        if (!result) {
          // Revert to the pre-move list, but preserve any ticket created
          // concurrently (in `current`, absent from `previous`) — restoring the
          // bare snapshot would drop it, the confirmed race this fixes.
          reconcileSlice(projectId, (slice) => mergeAuthoritative(previous, slice));
          return;
        }
        // The authoritative post-move list wins for the rows it names; a ticket
        // created concurrently and not yet in that snapshot is preserved.
        reconcileSlice(projectId, (slice) => mergeAuthoritative(result.tickets, slice));
      },

      async setTicketPriority(projectId, ticketId, priority) {
        const previous = get().ticketsByProject[projectId] ?? [];
        const original = previous.find((ticket) => ticket.id === ticketId);
        const optimistic = setTicketPriorityOp(previous, ticketId, priority, Date.now());
        if (!original || optimistic === previous) return; // unknown id or unchanged priority (the shared op's no-op guard)
        set({ ticketsByProject: { ...get().ticketsByProject, [projectId]: optimistic } });

        // Priority never reorders a column (the shared op only edits the
        // ticket's fields), so reconcile by patching just this one ticket by id
        // into the FRESH slice — leaving any sibling a concurrent mutation
        // touched untouched.
        const patch = (ticket: Ticket) =>
          reconcileSlice(projectId, (slice) =>
            slice.map((existing) => (existing.id === ticket.id ? ticket : existing)),
          );

        const result = await writeThrough(
          "update priority",
          (): Promise<TicketResult> => gateway.setTicketPriority({ ticketId, priority }),
        );
        if (!result) {
          patch(original);
          return;
        }
        patch(result.ticket);
      },

      async updateTicket(input) {
        const { ticketId, ...changes } = input;
        // Only the fields the caller actually supplied — `undefined` means
        // "leave as-is", matching `api.tickets.update`'s own semantics.
        const optimisticFields: Partial<Ticket> = {};
        if (changes.title !== undefined) optimisticFields.title = changes.title;
        if (changes.body !== undefined) optimisticFields.body = changes.body;
        if (changes.worktreePath !== undefined)
          optimisticFields.worktreePath = changes.worktreePath;
        if (changes.branch !== undefined) optimisticFields.branch = changes.branch;
        if (changes.baseBranch !== undefined) optimisticFields.baseBranch = changes.baseBranch;

        await optimisticTicketPatch(ticketId, optimisticFields, "update ticket", () =>
          gateway.updateTicket(input),
        );
      },

      async setLabels(ticketId, labels) {
        await optimisticTicketPatch(ticketId, { labels }, "update labels", () =>
          gateway.setLabels({ ticketId, labels }),
        );
      },

      async loadArchived(projectId) {
        const result = await writeThrough(
          "load archive",
          (): Promise<ArchivedTicketsResult> => gateway.listArchived(projectId),
        );
        if (!result) return false;
        // Wholesale-set this ONE project's archived slice from the authoritative
        // fetch — the Archive view is a fresh read each open, so a snapshot
        // replace (not a merge) is exactly right here.
        set({ archivedByProject: { ...get().archivedByProject, [projectId]: result.tickets } });
        return true;
      },

      async archiveTicket(projectId, ticketId) {
        const previous = get().ticketsByProject[projectId] ?? [];
        const target = previous.find((ticket) => ticket.id === ticketId);
        if (!target) return; // unknown id — nothing to archive
        const index = previous.indexOf(target);

        // Optimistically drop the card from the board.
        reconcileSlice(projectId, (slice) => slice.filter((ticket) => ticket.id !== ticketId));

        const result = await writeThrough(
          "archive ticket",
          (): Promise<Result> => gateway.archiveTicket({ ticketId }),
        );
        if (!result) {
          // Revert: restore the card into the FRESH slice, unless a concurrent
          // mutation already put it back.
          reconcileSlice(projectId, (slice) => restoreAt(slice, target, index));
          return;
        }
        // The ticket is archived now, so its live terminal sessions must die —
        // an archived ticket has no surface to reach them, and nothing else
        // tears them down (killTicketSessions was only reachable via project
        // removal, which skips archived tickets). Do it on SUCCESS only: a
        // failed archive left the ticket live, so its sessions must survive.
        killTicketSessions(ticketId);
        // Success — drop it from the board slice AGAIN: a move IPC in flight
        // when the archive committed returns an authoritative list snapshotted
        // while this ticket was still live, and mergeAuthoritative would have
        // resurrected it as an "extra". Responses arrive in send order, so
        // this later word wins.
        reconcileSlice(projectId, (slice) => slice.filter((ticket) => ticket.id !== ticketId));
        // The ticket is now archived; any cached Archive slice is stale, so drop
        // it — the next `loadArchived` (on Archive-view open) refetches it in.
        const { archivedByProject } = get();
        if (projectId in archivedByProject) {
          const next = { ...archivedByProject };
          delete next[projectId];
          set({ archivedByProject: next });
        }
        // An archived card can't stay selected — `forget` clears selection on
        // project removal; the archive lifecycle does the same on its way out
        // (otherwise Escape-deselect binds to a phantom and a later restore
        // reappears pre-selected).
        const { selectedByProject } = get();
        if (selectedByProject[projectId] === ticketId) {
          set({ selectedByProject: { ...selectedByProject, [projectId]: null } });
        }
      },

      async unarchiveTicket(projectId, ticketId) {
        const previousArchived = get().archivedByProject[projectId] ?? [];
        const target = previousArchived.find((ticket) => ticket.id === ticketId);
        if (!target) return; // not in the loaded Archive slice (e.g. a double-fired Restore) — no IPC

        const index = previousArchived.indexOf(target);
        // Optimistically drop it from the Archive slice.
        reconcileArchived(projectId, (slice) => slice.filter((ticket) => ticket.id !== ticketId));

        const result = await writeThrough(
          "unarchive ticket",
          (): Promise<TicketResult> => gateway.unarchiveTicket({ ticketId }),
        );
        if (!result) {
          // Revert: restore it to its old Archive slot unless already back.
          reconcileArchived(projectId, (slice) => restoreAt(slice, target, index));
          return;
        }
        // Success — drop it from the Archive slice AGAIN: a `loadArchived`
        // refetch in flight (snapshotted before the unarchive committed) can
        // have wholesale-set the slice with this ticket still listed; responses
        // arrive in send order, so this later word wins. Then append the
        // revived LIVE ticket to the board (reconcileSlice drops it if the
        // project was forgotten mid-flight — never resurrect a dead slice).
        reconcileArchived(projectId, (slice) => slice.filter((ticket) => ticket.id !== ticketId));
        const revived = result.ticket;
        reconcileSlice(projectId, (slice) =>
          slice.some((ticket) => ticket.id === revived.id) ? slice : [...slice, revived],
        );
      },

      async deleteArchivedTicket(projectId, ticketId) {
        const previousArchived = get().archivedByProject[projectId] ?? [];
        const target = previousArchived.find((ticket) => ticket.id === ticketId);
        // Not in the loaded Archive slice (e.g. a double-fired Delete after the
        // optimistic drop) — no IPC, which would throw "Unknown ticket" and
        // toast a spurious error for an operation that already succeeded.
        if (!target) return;

        const index = previousArchived.indexOf(target);
        // Optimistically drop it from the Archive slice.
        reconcileArchived(projectId, (slice) => slice.filter((ticket) => ticket.id !== ticketId));

        const result = await writeThrough(
          "delete ticket",
          (): Promise<Result> => gateway.deleteTicket({ ticketId }),
        );
        if (!result) {
          // Revert: restore it to its old Archive slot unless already back.
          reconcileArchived(projectId, (slice) => restoreAt(slice, target, index));
          return;
        }
        // Any live terminal sessions the ticket still owns must die with it —
        // belt-and-suspenders alongside archiveTicket's own teardown (a ticket
        // reachable here should already be sessionless, but never leak a PTY).
        killTicketSessions(ticketId);
        // Success — drop it AGAIN: an in-flight `loadArchived` refetch can have
        // re-listed it (see unarchiveTicket); the later response wins.
        reconcileArchived(projectId, (slice) => slice.filter((ticket) => ticket.id !== ticketId));
      },

      setSearch(projectId, search) {
        patchFilter(projectId, () => ({ search }));
      },

      togglePriority(projectId, priority) {
        patchFilter(projectId, (current) => ({
          priorities: toggleValue(current.priorities, priority),
        }));
      },

      toggleLabel(projectId, label) {
        patchFilter(projectId, (current) => ({ labels: toggleValue(current.labels, label) }));
      },

      // Drops the project's filter record entirely rather than writing back
      // EMPTY_TICKET_FILTER: a missing record already reads as "no filter"
      // everywhere above (see the `?? EMPTY_TICKET_FILTER` fallbacks), so
      // clearing is just forgetting.
      clearFilter(projectId) {
        const { filterByProject } = get();
        if (!(projectId in filterByProject)) return;
        const next = { ...filterByProject };
        delete next[projectId];
        set({ filterByProject: next });
      },

      // Clearing (ticketId === null) drops the project's record rather than
      // storing an explicit null: a missing record already reads as "nothing
      // selected" (`?? null` at use sites) — same shape as clearFilter above.
      selectTicket(projectId, ticketId) {
        const { selectedByProject } = get();
        if (ticketId === null) {
          if (!(projectId in selectedByProject)) return;
          const next = { ...selectedByProject };
          delete next[projectId];
          set({ selectedByProject: next });
          return;
        }
        if (selectedByProject[projectId] === ticketId) return;
        set({ selectedByProject: { ...selectedByProject, [projectId]: ticketId } });
      },

      forget(projectId) {
        const {
          ticketsByProject,
          labelsByProject,
          archivedByProject,
          filterByProject,
          selectedByProject,
        } = get();
        const hasTickets = projectId in ticketsByProject;
        const hasLabels = projectId in labelsByProject;
        const hasArchived = projectId in archivedByProject;
        const hasFilter = projectId in filterByProject;
        const hasSelection = projectId in selectedByProject;
        if (!hasTickets && !hasLabels && !hasArchived && !hasFilter && !hasSelection) return;

        const nextTickets = { ...ticketsByProject };
        delete nextTickets[projectId];
        const nextLabels = { ...labelsByProject };
        delete nextLabels[projectId];
        const nextArchived = { ...archivedByProject };
        delete nextArchived[projectId];
        const nextFilter = { ...filterByProject };
        delete nextFilter[projectId];
        const nextSelected = { ...selectedByProject };
        delete nextSelected[projectId];
        set({
          ticketsByProject: nextTickets,
          labelsByProject: nextLabels,
          archivedByProject: nextArchived,
          filterByProject: nextFilter,
          selectedByProject: nextSelected,
        });
      },
    };
  });
}

/** App-wide singleton; components import this directly. */
export const useBoardStore = createBoardStore();
