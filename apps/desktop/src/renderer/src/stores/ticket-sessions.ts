/**
 * Ticket-scoped live terminal sessions (ticket-detail-mvp decision #19), keyed
 * by `ticketId`, reusing the exact tab model from `stores/sessions.ts` (the
 * project sessions surface) — single-pane tabs here, since a ticket session is
 * one terminal in the detail's tab plane. Live PTY state stays in-memory as it
 * does for scratch sessions; the durable trace lives in the `sessions` table.
 * Per-session output recency (`lastOutputAt`) + the exited flag feed the honest
 * PTY-derived status vocabulary, derived by the pure {@link sessionActivityState}.
 */
import { create } from "zustand";
import type { SessionActivityState } from "@volli/shared";
import { findSessionPane, type SessionTab } from "./sessions";

/** Output within this window reads as `working`; quiet-but-live reads as `idle`. */
const WORKING_WINDOW_MS = 10_000;
/** Coalesce output bumps: at most one `lastOutputAt` write per session per second. */
const OUTPUT_THROTTLE_MS = 1_000;

/**
 * Honest PTY-derived session status (ticket-detail-mvp decision #5): `working`
 * when output landed within ~10s, `idle` when live but quiet, `exited` once the
 * shell is gone. Pure so the derivation is unit-tested independent of the clock;
 * hook-driven states (waiting-for-input, …) reuse this vocabulary later.
 */
export function sessionActivityState(
  lastOutputAt: number | null,
  exited: boolean,
  now: number,
): SessionActivityState {
  if (exited) return "exited";
  if (lastOutputAt !== null && now - lastOutputAt <= WORKING_WINDOW_MS) return "working";
  return "idle";
}

/** One ticket's live terminal sessions — same tab model as the sessions surface. */
export interface TicketSessions {
  tabs: SessionTab[];
  activeSessionId: string | null;
}

interface TicketSessionsState {
  byTicket: Record<string, TicketSessions>;
  /** sessionId → last PTY-output time (ms); only ticket-owned sessions are tracked. */
  lastOutputAt: Record<string, number>;
  /**
   * sessionId → owning ticketId, maintained on create/close/forget. Lets the
   * per-chunk {@link TicketSessionsState.bumpOutput} hot path do an O(1)
   * ownership check (and cheap scratch-session early-out) instead of scanning
   * every ticket's every tab on each chunk.
   */
  sessionTicket: Record<string, string>;
  /** Tickets with a terminal-create in flight (disables the rail's New session). */
  startingTickets: Record<string, true>;
  addSession(ticketId: string, sessionId: string, title: string): void;
  setActiveSession(ticketId: string, sessionId: string): void;
  closeSession(ticketId: string, sessionId: string): void;
  markExited(sessionId: string, exitCode: number): void;
  bumpOutput(sessionId: string, now: number): void;
  setStarting(ticketId: string, starting: boolean): void;
  forgetTicket(ticketId: string): void;
}

const EMPTY_TICKET: TicketSessions = { tabs: [], activeSessionId: null };

/** Factory so tests get isolated instances. */
export function createTicketSessionsStore() {
  return create<TicketSessionsState>()((set) => ({
    byTicket: {},
    lastOutputAt: {},
    sessionTicket: {},
    startingTickets: {},

    addSession(ticketId, sessionId, title) {
      set((state) => {
        const current = state.byTicket[ticketId] ?? EMPTY_TICKET;
        if (current.tabs.some((tab) => findSessionPane(tab.layout, sessionId) !== null)) {
          return state;
        }
        const tab: SessionTab = {
          sessionId,
          title,
          layout: { kind: "pane", sessionId, exitCode: null },
          activePaneId: sessionId,
        };
        return {
          byTicket: {
            ...state.byTicket,
            [ticketId]: { tabs: [...current.tabs, tab], activeSessionId: sessionId },
          },
          sessionTicket: { ...state.sessionTicket, [sessionId]: ticketId },
        };
      });
    },

    setActiveSession(ticketId, sessionId) {
      set((state) => {
        const current = state.byTicket[ticketId];
        if (current === undefined || !current.tabs.some((tab) => tab.sessionId === sessionId)) {
          return state;
        }
        return {
          byTicket: { ...state.byTicket, [ticketId]: { ...current, activeSessionId: sessionId } },
        };
      });
    },

    closeSession(ticketId, sessionId) {
      set((state) => {
        const current = state.byTicket[ticketId];
        if (current === undefined) return state;
        const removedIndex = current.tabs.findIndex((tab) => tab.sessionId === sessionId);
        if (removedIndex === -1) return state;
        const tabs = current.tabs.filter((tab) => tab.sessionId !== sessionId);
        let activeSessionId = current.activeSessionId;
        if (activeSessionId === sessionId) {
          activeSessionId =
            tabs.length === 0 ? null : tabs[Math.min(removedIndex, tabs.length - 1)]!.sessionId;
        }
        const lastOutputAt = { ...state.lastOutputAt };
        delete lastOutputAt[sessionId];
        const sessionTicket = { ...state.sessionTicket };
        delete sessionTicket[sessionId];
        return {
          byTicket: { ...state.byTicket, [ticketId]: { tabs, activeSessionId } },
          lastOutputAt,
          sessionTicket,
        };
      });
    },

    markExited(sessionId, exitCode) {
      set((state) => {
        for (const [ticketId, current] of Object.entries(state.byTicket)) {
          const index = current.tabs.findIndex((tab) => tab.sessionId === sessionId);
          if (index === -1) continue;
          const tabs = current.tabs.slice();
          tabs[index] = { ...tabs[index]!, layout: { kind: "pane", sessionId, exitCode } };
          return { byTicket: { ...state.byTicket, [ticketId]: { ...current, tabs } } };
        }
        return state;
      });
    },

    bumpOutput(sessionId, now) {
      set((state) => {
        // Hot path: runs for EVERY chunk of EVERY live session (scratch PTYs
        // included, since they share the output stream). Do the O(1) ownership
        // lookup FIRST so a scratch chunk early-returns for free; only then the
        // ≥1s throttle, and only then an actual state write.
        if (!(sessionId in state.sessionTicket)) return state;
        const last = state.lastOutputAt[sessionId] ?? 0;
        if (now - last < OUTPUT_THROTTLE_MS) return state;
        return { lastOutputAt: { ...state.lastOutputAt, [sessionId]: now } };
      });
    },

    setStarting(ticketId, starting) {
      set((state) => {
        const isStarting = ticketId in state.startingTickets;
        if (starting === isStarting) return state;
        const startingTickets = { ...state.startingTickets };
        if (starting) startingTickets[ticketId] = true;
        else delete startingTickets[ticketId];
        return { startingTickets };
      });
    },

    forgetTicket(ticketId) {
      set((state) => {
        const current = state.byTicket[ticketId];
        if (current === undefined) return state;
        const byTicket = { ...state.byTicket };
        delete byTicket[ticketId];
        const lastOutputAt = { ...state.lastOutputAt };
        const sessionTicket = { ...state.sessionTicket };
        for (const tab of current.tabs) {
          delete lastOutputAt[tab.sessionId];
          delete sessionTicket[tab.sessionId];
        }
        return { byTicket, lastOutputAt, sessionTicket };
      });
    },
  }));
}

export const useTicketSessionsStore = createTicketSessionsStore();
