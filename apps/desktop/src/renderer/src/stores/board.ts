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
  errorMessage,
  moveTicket as moveTicketOp,
  setTicketPriority as setTicketPriorityOp,
  type Label,
  type Ticket,
  type TicketCreateResult,
  type TicketFilter,
  type TicketPriority,
  type TicketsResult,
  type TicketStatus,
} from "@volli/shared";
import { toast } from "sonner";
import { create } from "zustand";

/** The subset of the preload API the board store needs — narrow and fake-able for tests. */
export interface BoardGateway {
  createTicket(input: {
    projectId: string;
    status: TicketStatus;
    title: string;
    priority?: TicketPriority;
  }): Promise<TicketCreateResult>;
  moveTicket(input: {
    projectId: string;
    ticketId: string;
    toStatus: TicketStatus;
    toIndex: number;
  }): Promise<TicketsResult>;
  setTicketPriority(input: { ticketId: string; priority: TicketPriority }): Promise<TicketsResult>;
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

        let result: TicketCreateResult;
        try {
          result = await gateway.createTicket({
            projectId,
            status,
            title: trimmed,
            priority: options?.priority,
          });
        } catch (error) {
          toast.error(`Could not create ticket: ${errorMessage(error)}`);
          return null;
        }
        if (!result.ok) {
          toast.error(`Could not create ticket: ${result.error}`);
          return null;
        }

        const { ticketsByProject } = get();
        const current = ticketsByProject[projectId] ?? [];
        set({
          ticketsByProject: { ...ticketsByProject, [projectId]: [...current, result.ticket] },
        });
        return result.ticket;
      },

      async moveTicket(projectId, ticketId, toStatus, toIndex) {
        const { ticketsByProject } = get();
        const previous = ticketsByProject[projectId] ?? [];
        const optimistic = moveTicketOp(previous, ticketId, toStatus, toIndex, Date.now());
        if (optimistic === previous) return; // shared op's no-op guard: unknown id or unchanged position
        set({ ticketsByProject: { ...ticketsByProject, [projectId]: optimistic } });

        let result: TicketsResult;
        try {
          result = await gateway.moveTicket({ projectId, ticketId, toStatus, toIndex });
        } catch (error) {
          set({ ticketsByProject: { ...get().ticketsByProject, [projectId]: previous } });
          toast.error(`Could not move ticket: ${errorMessage(error)}`);
          return;
        }
        if (!result.ok) {
          set({ ticketsByProject: { ...get().ticketsByProject, [projectId]: previous } });
          toast.error(`Could not move ticket: ${result.error}`);
          return;
        }
        set({ ticketsByProject: { ...get().ticketsByProject, [projectId]: result.tickets } });
      },

      async setTicketPriority(projectId, ticketId, priority) {
        const { ticketsByProject } = get();
        const previous = ticketsByProject[projectId] ?? [];
        const optimistic = setTicketPriorityOp(previous, ticketId, priority, Date.now());
        if (optimistic === previous) return; // shared op's no-op guard: unknown id or unchanged priority
        set({ ticketsByProject: { ...ticketsByProject, [projectId]: optimistic } });

        let result: TicketsResult;
        try {
          result = await gateway.setTicketPriority({ ticketId, priority });
        } catch (error) {
          set({ ticketsByProject: { ...get().ticketsByProject, [projectId]: previous } });
          toast.error(`Could not update priority: ${errorMessage(error)}`);
          return;
        }
        if (!result.ok) {
          set({ ticketsByProject: { ...get().ticketsByProject, [projectId]: previous } });
          toast.error(`Could not update priority: ${result.error}`);
          return;
        }
        set({ ticketsByProject: { ...get().ticketsByProject, [projectId]: result.tickets } });
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
