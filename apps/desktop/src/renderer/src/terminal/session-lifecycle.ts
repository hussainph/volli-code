/**
 * Explicit terminal-session teardown + rename, deliberately OUTSIDE the React
 * tree: engines and PTYs outlive views (keep-alive tabs, future headless agent
 * sessions, project removal while another page is showing), so teardown must
 * never depend on a TerminalView unmount happening to run. The functions in
 * this module are the only places a session's engine is disposed or PTY killed.
 *
 * Everything is addressed by the unified sessions store's OWNER id — a projectId
 * for scratch sessions, a ticketId for ticket sessions (ticket-scoped wrappers
 * kept as named entry points so `stores/projects.ts` keeps its stable API).
 */
import { errorMessage } from "@volli/shared";
import { toast } from "sonner";

import {
  findSessionPane,
  findTabBySessionId,
  sessionPanes,
  useSessionsStore,
  type SessionPane,
} from "../stores/sessions";
import { disposeEngine } from "./registry";

/** Close one tab and every independent pane session it owns. */
export function closeTerminalSession(ownerId: string, sessionId: string): void {
  const tab = useSessionsStore
    .getState()
    .byOwner[ownerId]?.tabs.find((candidate) => candidate.sessionId === sessionId);
  useSessionsStore.getState().closeSession(ownerId, sessionId);
  if (tab === undefined) return;
  for (const pane of sessionPanes(tab.layout)) {
    disposeEngine(pane.sessionId);
    killIfLive(pane);
  }
}

/** Close one split leaf; closing the final leaf closes its containing tab. */
export function closeTerminalPane(ownerId: string, tabId: string, sessionId: string): void {
  const tab = useSessionsStore
    .getState()
    .byOwner[ownerId]?.tabs.find((candidate) => candidate.sessionId === tabId);
  if (tab === undefined) return;
  const panes = sessionPanes(tab.layout);
  const pane = findSessionPane(tab.layout, sessionId);
  if (pane === null) return;
  if (panes.length === 1) {
    closeTerminalSession(ownerId, tabId);
    return;
  }
  useSessionsStore.getState().closePane(ownerId, tabId, sessionId);
  disposeEngine(sessionId);
  killIfLive(pane);
}

/**
 * Close one ticket-session tab and kill its PTY — a thin alias over
 * {@link closeTerminalSession} (a ticketId is just an owner id), kept named so
 * the ticket surfaces read intent-first.
 */
export function closeTicketSession(ticketId: string, sessionId: string): void {
  closeTerminalSession(ticketId, sessionId);
}

/** Tear down every ticket session of a ticket (e.g. its project was removed). */
export function killTicketSessions(ticketId: string): void {
  killOwnerSessions(ticketId);
}

/** Tear down every session of a removed project, whether or not views are mounted. */
export function killProjectSessions(projectId: string): void {
  killOwnerSessions(projectId);
}

/** Dispose every engine + kill every live PTY under an owner, then forget it. */
function killOwnerSessions(ownerId: string): void {
  const tabs = useSessionsStore.getState().byOwner[ownerId]?.tabs ?? [];
  for (const tab of tabs) {
    for (const pane of sessionPanes(tab.layout)) {
      disposeEngine(pane.sessionId);
      killIfLive(pane);
    }
  }
  useSessionsStore.getState().forgetOwner(ownerId);
}

/**
 * Rename a session everywhere: optimistically retitle the live tab, persist the
 * new title, and roll the live title back with a toast if the write fails
 * (CLAUDE.md: never silently swallow a failed mutation). No-ops on a blank or
 * unchanged title. Works for both scratch and ticket sessions.
 */
export function renameTerminalSession(sessionId: string, title: string): void {
  const trimmed = title.trim();
  const found = findTabBySessionId(useSessionsStore.getState().byOwner, sessionId);
  if (found === null) return;
  const previous = found.tab.title;
  if (trimmed.length === 0 || trimmed === previous) return;

  useSessionsStore.getState().renameSession(sessionId, trimmed);
  window.api.sessions
    .rename({ sessionId, title: trimmed })
    .then((result) => {
      if (!result.ok) {
        useSessionsStore.getState().renameSession(sessionId, previous);
        toast.error(`Rename failed: ${result.error}`);
      }
    })
    .catch((error: unknown) => {
      useSessionsStore.getState().renameSession(sessionId, previous);
      toast.error(`Rename failed: ${errorMessage(error)}`);
    });
}

/** An exited tab has no PTY left in main — killing it would only toast an error. */
function killIfLive(pane: SessionPane): void {
  if (pane.exitCode !== null) return;
  window.api.terminal
    .kill(pane.sessionId)
    .then((result) => {
      if (!result.ok) toast.error(`Terminal close failed: ${result.error}`);
    })
    .catch((error: unknown) => {
      toast.error(`Terminal close failed: ${errorMessage(error)}`);
    });
}
