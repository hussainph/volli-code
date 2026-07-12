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
  type Label,
  type Ticket,
  type TicketFilter,
  type TicketPriority,
  type TicketResult,
  type TicketsResult,
  type TicketStatus,
} from "@volli/shared";
import { create } from "zustand";

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
}

const defaultGateway: BoardGateway = {
  createTicket: (input) => window.api.tickets.create(input),
  moveTicket: (input) => window.api.tickets.move(input),
  setTicketPriority: (input) => window.api.tickets.setPriority(input),
};

interface BoardState {
  ticketsByProject: Record<string, Ticket[]>;
  labelsByProject: Record<string, Label[]>;
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
  setSearch(projectId: string, search: string): void;
  togglePriority(projectId: string, priority: TicketPriority): void;
  toggleLabel(projectId: string, label: string): void;
  toggleHarness(projectId: string, harnessId: string): void;
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
      if (!(projectId in byProject)) return;
      set({ ticketsByProject: { ...byProject, [projectId]: update(byProject[projectId] ?? []) } });
    }

    return {
      ticketsByProject: {},
      labelsByProject: {},
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
        const optimistic = setTicketPriorityOp(previous, ticketId, priority, Date.now());
        if (optimistic === previous) return; // shared op's no-op guard: unknown id or unchanged priority
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
          const original = previous.find((ticket) => ticket.id === ticketId);
          if (original) patch(original);
          return;
        }
        patch(result.ticket);
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

      toggleHarness(projectId, harnessId) {
        patchFilter(projectId, (current) => ({
          harnessIds: toggleValue(current.harnessIds, harnessId),
        }));
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
        const { ticketsByProject, labelsByProject, filterByProject, selectedByProject } = get();
        const hasTickets = projectId in ticketsByProject;
        const hasLabels = projectId in labelsByProject;
        const hasFilter = projectId in filterByProject;
        const hasSelection = projectId in selectedByProject;
        if (!hasTickets && !hasLabels && !hasFilter && !hasSelection) return;

        const nextTickets = { ...ticketsByProject };
        delete nextTickets[projectId];
        const nextLabels = { ...labelsByProject };
        delete nextLabels[projectId];
        const nextFilter = { ...filterByProject };
        delete nextFilter[projectId];
        const nextSelected = { ...selectedByProject };
        delete nextSelected[projectId];
        set({
          ticketsByProject: nextTickets,
          labelsByProject: nextLabels,
          filterByProject: nextFilter,
          selectedByProject: nextSelected,
        });
      },
    };
  });
}

/** App-wide singleton; components import this directly. */
export const useBoardStore = createBoardStore();
