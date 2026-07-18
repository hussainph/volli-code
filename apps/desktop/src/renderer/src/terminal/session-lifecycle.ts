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

import { toastError } from "@renderer/lib/toast";
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

/**
 * Tear down every TICKET session whose scope belongs to `projectId`, keyed off
 * the sessions store rather than the board's live ticket list — so archived
 * tickets (whose ids `ticketsByProject` no longer holds) don't leak a PTY when
 * their project is removed. Each ticket owner's tabs all share the ticket's
 * scope, so one tab's scope identifies the whole container's project.
 */
export function killProjectTicketSessions(projectId: string): void {
  const owners = Object.entries(useSessionsStore.getState().byOwner)
    .filter(([, container]) =>
      container.tabs.some(
        (tab) => tab.scope.kind === "ticket" && tab.scope.projectId === projectId,
      ),
    )
    .map(([ownerId]) => ownerId);
  for (const ownerId of owners) killOwnerSessions(ownerId);
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
 * Rename a session everywhere and persist it — the canonical rename path for
 * BOTH live and ended sessions (CLAUDE.md: never silently swallow a failed
 * mutation). Panels should route ALL renames here, including ended (no live
 * tab) session rows, instead of duplicating the trim/no-op/persist/toast rules.
 *
 * - LIVE tab: optimistically retitle it, persist, and roll the live title back
 *   with a toast if the write fails — UNLESS a newer rename changed the title
 *   in the meantime (rolling back would resurrect a stale title the newer
 *   rename replaced).
 * - ENDED session (no live tab): nothing to retitle, so persist directly with
 *   the same trim guard and failure toast.
 *
 * No-ops on a blank (or, for a live tab, unchanged) title. Resolves `true` when
 * the title was persisted, `false` on a no-op or failed write — callers holding
 * a durable-record copy (the ticket Sessions panel) can refetch on `false`.
 */
export async function renameTerminalSession(sessionId: string, title: string): Promise<boolean> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;

  const found = findTabBySessionId(useSessionsStore.getState().byOwner, sessionId);
  if (found === null) {
    // Ended session: no live tab to retitle — persist directly so the durable
    // record still updates and failures still surface.
    return persistRename(sessionId, trimmed);
  }

  const previous = found.tab.title;
  if (trimmed === previous) return false;

  useSessionsStore.getState().renameSession(sessionId, trimmed);
  const ok = await persistRename(sessionId, trimmed);
  if (!ok) {
    // Roll back to `previous` ONLY if this call's optimistic title is still what
    // the store holds; a newer rename that landed mid-flight already replaced
    // it, and clobbering that with our stale `previous` would undo it.
    const current = findTabBySessionId(useSessionsStore.getState().byOwner, sessionId)?.tab.title;
    if (current === trimmed) useSessionsStore.getState().renameSession(sessionId, previous);
  }
  return ok;
}

/** Persist a rename via main; toast on failure. Resolves whether it stuck. */
async function persistRename(sessionId: string, title: string): Promise<boolean> {
  try {
    const result = await window.api.sessions.rename({ sessionId, title });
    if (result.ok) return true;
    toastError(`Rename failed: ${result.error}`);
    return false;
  } catch (error) {
    toastError(`Rename failed: ${errorMessage(error)}`);
    return false;
  }
}

/** An exited tab has no PTY left in main — killing it would only toast an error. */
function killIfLive(pane: SessionPane): void {
  if (pane.exitCode !== null) return;
  window.api.terminal
    .kill(pane.sessionId)
    .then((result) => {
      if (!result.ok) toastError(`Terminal close failed: ${result.error}`);
    })
    .catch((error: unknown) => {
      toastError(`Terminal close failed: ${errorMessage(error)}`);
    });
}
