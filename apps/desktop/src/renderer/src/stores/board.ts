/**
 * Per-project board: the ticket list (persisted) and its search/filter state.
 * Filters are session-only — like the rest of the app's transient UI, they
 * reset on relaunch instead of following the ticket data. `ensureSeeded`
 * plants the placeholder demo board (lib/demo-tickets.ts) the first time a
 * project's board is opened, until the SQLite ticket layer lands.
 */
import {
  createTicket,
  EMPTY_TICKET_FILTER,
  moveTicket as moveTicketOp,
  nextTicketNumber,
  removeTicket as removeTicketOp,
  setTicketPriority as setTicketPriorityOp,
  type Ticket,
  type TicketFilter,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { buildDemoTickets } from "../lib/demo-tickets";

interface BoardState {
  ticketsByProject: Record<string, Ticket[]>;
  /** Session-only — never persisted; see module doc. */
  filterByProject: Record<string, TicketFilter>;
  ensureSeeded(projectId: string, ticketPrefix: string): void;
  moveTicket(projectId: string, ticketId: string, toStatus: TicketStatus, toIndex: number): void;
  addTicket(projectId: string, ticketPrefix: string, status: TicketStatus, title: string): void;
  setTicketPriority(projectId: string, ticketId: string, priority: TicketPriority): void;
  removeTicket(projectId: string, ticketId: string): void;
  setSearch(projectId: string, search: string): void;
  togglePriority(projectId: string, priority: TicketPriority): void;
  toggleTag(projectId: string, tag: string): void;
  toggleHarness(projectId: string, harnessId: string): void;
  clearFilter(projectId: string): void;
  forget(projectId: string): void;
}

type PersistedBoardState = Pick<BoardState, "ticketsByProject">;

/** Toggles `value` in `values`: drops it if present, appends it otherwise. */
function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

/** Factory so tests can supply an in-memory storage instead of localStorage. */
export function createBoardStore(storage?: StateStorage) {
  return create<BoardState>()(
    persist(
      (set, get) => ({
        ticketsByProject: {},
        filterByProject: {},

        ensureSeeded(projectId, ticketPrefix) {
          const { ticketsByProject } = get();
          if (projectId in ticketsByProject) return;
          set({
            ticketsByProject: {
              ...ticketsByProject,
              [projectId]: buildDemoTickets(projectId, ticketPrefix),
            },
          });
        },

        moveTicket(projectId, ticketId, toStatus, toIndex) {
          const { ticketsByProject } = get();
          const current = ticketsByProject[projectId] ?? [];
          const next = moveTicketOp(current, ticketId, toStatus, toIndex, Date.now());
          if (next === current) return; // shared op's no-op guard: unknown id or unchanged position
          set({ ticketsByProject: { ...ticketsByProject, [projectId]: next } });
        },

        addTicket(projectId, ticketPrefix, status, title) {
          const trimmed = title.trim();
          if (trimmed === "") return;

          const { ticketsByProject } = get();
          const current = ticketsByProject[projectId] ?? [];
          const order = current.filter((ticket) => ticket.status === status).length;
          const ticket = createTicket({
            prefix: ticketPrefix,
            projectId,
            ticketNumber: nextTicketNumber(current),
            title: trimmed,
            status,
            order,
            now: Date.now(),
          });
          set({ ticketsByProject: { ...ticketsByProject, [projectId]: [...current, ticket] } });
        },

        setTicketPriority(projectId, ticketId, priority) {
          const { ticketsByProject } = get();
          const current = ticketsByProject[projectId] ?? [];
          const next = setTicketPriorityOp(current, ticketId, priority, Date.now());
          if (next === current) return; // shared op's no-op guard: unknown id or unchanged priority
          set({ ticketsByProject: { ...ticketsByProject, [projectId]: next } });
        },

        removeTicket(projectId, ticketId) {
          const { ticketsByProject } = get();
          const current = ticketsByProject[projectId] ?? [];
          const next = removeTicketOp(current, ticketId);
          if (next === current) return; // shared op's no-op guard: unknown id
          set({ ticketsByProject: { ...ticketsByProject, [projectId]: next } });
        },

        setSearch(projectId, search) {
          const { filterByProject } = get();
          const current = filterByProject[projectId] ?? EMPTY_TICKET_FILTER;
          set({ filterByProject: { ...filterByProject, [projectId]: { ...current, search } } });
        },

        togglePriority(projectId, priority) {
          const { filterByProject } = get();
          const current = filterByProject[projectId] ?? EMPTY_TICKET_FILTER;
          set({
            filterByProject: {
              ...filterByProject,
              [projectId]: { ...current, priorities: toggleValue(current.priorities, priority) },
            },
          });
        },

        toggleTag(projectId, tag) {
          const { filterByProject } = get();
          const current = filterByProject[projectId] ?? EMPTY_TICKET_FILTER;
          set({
            filterByProject: {
              ...filterByProject,
              [projectId]: { ...current, tags: toggleValue(current.tags, tag) },
            },
          });
        },

        toggleHarness(projectId, harnessId) {
          const { filterByProject } = get();
          const current = filterByProject[projectId] ?? EMPTY_TICKET_FILTER;
          set({
            filterByProject: {
              ...filterByProject,
              [projectId]: { ...current, harnessIds: toggleValue(current.harnessIds, harnessId) },
            },
          });
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

        forget(projectId) {
          const { ticketsByProject, filterByProject } = get();
          const hasTickets = projectId in ticketsByProject;
          const hasFilter = projectId in filterByProject;
          if (!hasTickets && !hasFilter) return;

          const nextTickets = { ...ticketsByProject };
          delete nextTickets[projectId];
          const nextFilter = { ...filterByProject };
          delete nextFilter[projectId];
          set({ ticketsByProject: nextTickets, filterByProject: nextFilter });
        },
      }),
      {
        name: "volli:board",
        version: 1,
        storage: createJSONStorage(() => storage ?? localStorage),
        partialize: (state): PersistedBoardState => ({ ticketsByProject: state.ticketsByProject }),
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useBoardStore = createBoardStore();
