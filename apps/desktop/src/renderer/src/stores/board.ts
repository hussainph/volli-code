/**
 * Per-project board: the ticket list (persisted) and its search/filter and
 * card-selection state. Filters AND selection are session-only (excluded from
 * partialize) — like the rest of the app's transient UI, they reset on
 * relaunch instead of following the ticket data. Selection lives here rather
 * than in the board component so other surfaces (the sidebar's Active
 * Sessions) can select a card too. `ensureSeeded` plants the placeholder demo
 * board (lib/demo-tickets.ts) the first time a project's board is opened,
 * until the SQLite ticket layer lands.
 */
import {
  createTicket,
  EMPTY_TICKET_FILTER,
  moveTicket as moveTicketOp,
  nextTicketNumber,
  setTicketPriority as setTicketPriorityOp,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Ticket,
  type TicketFilter,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { buildDemoTickets } from "../lib/demo-tickets";

interface BoardState {
  /** Marks all localStorage board data as disposable scaffold state, never SQLite input. */
  persistenceKind: "demo-scaffold";
  ticketsByProject: Record<string, Ticket[]>;
  /** Session-only — never persisted; see module doc. */
  filterByProject: Record<string, TicketFilter>;
  /** The selected card per project. Session-only — never persisted; see module doc. */
  selectedByProject: Record<string, string | null>;
  ensureSeeded(projectId: string, ticketPrefix: string): void;
  moveTicket(projectId: string, ticketId: string, toStatus: TicketStatus, toIndex: number): void;
  /**
   * Appends a new ticket to the end of `status`'s column. Returns the created
   * {@link Ticket}, or `null` (no-op) when the trimmed title is empty —
   * callers that need the new ticket (e.g. the global New-ticket dialog, to
   * toast its id) can use the return value; the inline column composers
   * ignore it.
   */
  addTicket(
    projectId: string,
    ticketPrefix: string,
    status: TicketStatus,
    title: string,
    options?: { priority?: TicketPriority },
  ): Ticket | null;
  setTicketPriority(projectId: string, ticketId: string, priority: TicketPriority): void;
  setSearch(projectId: string, search: string): void;
  togglePriority(projectId: string, priority: TicketPriority): void;
  toggleTag(projectId: string, tag: string): void;
  toggleHarness(projectId: string, harnessId: string): void;
  clearFilter(projectId: string): void;
  selectTicket(projectId: string, ticketId: string | null): void;
  forget(projectId: string): void;
}

type PersistedBoardState = Pick<BoardState, "persistenceKind" | "ticketsByProject">;

/** Toggles `value` in `values`: drops it if present, appends it otherwise. */
function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

const TICKET_STRING_FIELDS = ["id", "projectId", "title", "body", "harnessId"] as const;
const TICKET_NUMBER_FIELDS = ["ticketNumber", "order", "createdAt", "updatedAt"] as const;

/**
 * Whether a rehydrated value is a ticket every consumer can trust — an unknown
 * `status` in particular would throw inside `groupTicketsByStatus`
 * (`groups[status].push`) on every board render until storage is cleared.
 * Checks exactly the fields the board's render/sort/move paths dereference.
 */
function isValidTicket(value: unknown): value is Ticket {
  if (typeof value !== "object" || value === null) return false;
  const ticket = value as Record<string, unknown>;
  return (
    TICKET_STRING_FIELDS.every((field) => typeof ticket[field] === "string") &&
    TICKET_NUMBER_FIELDS.every((field) => typeof ticket[field] === "number") &&
    TICKET_STATUSES.includes(ticket.status as TicketStatus) &&
    TICKET_PRIORITIES.includes(ticket.priority as TicketPriority) &&
    typeof ticket.usesWorktree === "boolean" &&
    Array.isArray(ticket.tags) &&
    ticket.tags.every((tag) => typeof tag === "string")
  );
}

/**
 * Rehydrated board data comes from JSON a past (possibly older) build wrote —
 * validate rather than trust, like the workspace store's merge. Tickets that
 * fail {@link isValidTicket} are dropped individually; a record that is not an
 * array at all is dropped whole. Losing scaffold rows beats crashing the board
 * on every launch (this data is demo-scaffold by declaration, never SQLite
 * input — see `persistenceKind`).
 */
function sanitizeTicketsByProject(persisted: unknown): Record<string, Ticket[]> {
  const ticketsByProject =
    typeof persisted === "object" && persisted !== null
      ? (persisted as Partial<PersistedBoardState>).ticketsByProject
      : undefined;
  if (typeof ticketsByProject !== "object" || ticketsByProject === null) return {};

  const sanitized: Record<string, Ticket[]> = {};
  for (const [projectId, tickets] of Object.entries(ticketsByProject)) {
    if (!Array.isArray(tickets)) continue;
    sanitized[projectId] = tickets.filter(isValidTicket);
  }
  return sanitized;
}

/** Factory so tests can supply an in-memory storage instead of localStorage. */
export function createBoardStore(storage?: StateStorage) {
  return create<BoardState>()(
    persist(
      (set, get) => {
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
          persistenceKind: "demo-scaffold",
          ticketsByProject: {},
          filterByProject: {},
          selectedByProject: {},

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

          addTicket(projectId, ticketPrefix, status, title, options) {
            const trimmed = title.trim();
            if (trimmed === "") return null;

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
              priority: options?.priority,
            });
            set({ ticketsByProject: { ...ticketsByProject, [projectId]: [...current, ticket] } });
            return ticket;
          },

          setTicketPriority(projectId, ticketId, priority) {
            const { ticketsByProject } = get();
            const current = ticketsByProject[projectId] ?? [];
            const next = setTicketPriorityOp(current, ticketId, priority, Date.now());
            if (next === current) return; // shared op's no-op guard: unknown id or unchanged priority
            set({ ticketsByProject: { ...ticketsByProject, [projectId]: next } });
          },

          setSearch(projectId, search) {
            patchFilter(projectId, () => ({ search }));
          },

          togglePriority(projectId, priority) {
            patchFilter(projectId, (current) => ({
              priorities: toggleValue(current.priorities, priority),
            }));
          },

          toggleTag(projectId, tag) {
            patchFilter(projectId, (current) => ({ tags: toggleValue(current.tags, tag) }));
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
            const { ticketsByProject, filterByProject, selectedByProject } = get();
            const hasTickets = projectId in ticketsByProject;
            const hasFilter = projectId in filterByProject;
            const hasSelection = projectId in selectedByProject;
            if (!hasTickets && !hasFilter && !hasSelection) return;

            const nextTickets = { ...ticketsByProject };
            delete nextTickets[projectId];
            const nextFilter = { ...filterByProject };
            delete nextFilter[projectId];
            const nextSelected = { ...selectedByProject };
            delete nextSelected[projectId];
            set({
              ticketsByProject: nextTickets,
              filterByProject: nextFilter,
              selectedByProject: nextSelected,
            });
          },
        };
      },
      {
        name: "volli:board",
        version: 1,
        storage: createJSONStorage(() => storage ?? localStorage),
        partialize: (state): PersistedBoardState => ({
          persistenceKind: state.persistenceKind,
          ticketsByProject: state.ticketsByProject,
        }),
        merge: (persisted, current) => ({
          ...current,
          ticketsByProject: sanitizeTicketsByProject(persisted),
        }),
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useBoardStore = createBoardStore();
