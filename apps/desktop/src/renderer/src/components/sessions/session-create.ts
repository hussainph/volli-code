/**
 * Booting terminal sessions + splits, outside the React tree so both surfaces
 * (the Sessions page and the ticket overlay) share one code path. A create
 * boots a PTY in main (ticket scope injects VOLLI_TICKET env there), pre-creates
 * the renderer engine so output arriving before the view mounts is buffered, and
 * only then registers the tab/split in the unified store. Every failure toasts —
 * a mutation is never silently swallowed (CLAUDE.md).
 */
import { errorMessage } from "@volli/shared";
import { toast } from "sonner";

import { useProjectsStore } from "@renderer/stores/projects";
import {
  findSessionPane,
  ownerKey,
  useSessionsStore,
  type SessionScope,
  type TerminalSplitDirection,
} from "@renderer/stores/sessions";
import { disposeEngine, getOrCreateEngine } from "@renderer/terminal/registry";

/** Initial PTY grid; restty re-measures and resizes the shell within a frame. */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

/** The main-process create request derived from a scope (ticket scopes carry env-injection intent). */
function createRequest(scope: SessionScope, projectPath: string) {
  return {
    workspaceId: scope.projectId,
    cwd: projectPath,
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
    ...(scope.kind === "ticket" ? { ticket: { ticketId: scope.ticketId } } : {}),
  };
}

/** The project still tracked in the renderer, or undefined if it was removed mid-flight. */
function trackedProject(projectId: string) {
  return useProjectsStore.getState().projects.find((candidate) => candidate.id === projectId);
}

/** Dispose the pre-created engine and kill the orphaned PTY when a create can't land its tab. */
function abandon(sessionId: string): void {
  disposeEngine(sessionId);
  window.api.terminal
    .kill(sessionId)
    .then((result) => {
      if (!result.ok) toast.error(`Terminal close failed: ${result.error}`);
    })
    .catch((error: unknown) => {
      toast.error(`Terminal close failed: ${errorMessage(error)}`);
    });
}

/**
 * Boot a new session as a fresh tab under `scope`. Resolves with its sessionId,
 * or null on failure / if the owner is no longer tracked. The tab title is the
 * one main seeded on the durable record, so the live tab and the DB agree.
 */
export async function createTerminalSession(scope: SessionScope): Promise<string | null> {
  const store = useSessionsStore.getState();
  const id = ownerKey(scope);
  if (store.starting[id]) return null;
  const project = trackedProject(scope.projectId);
  if (project === undefined) return null;

  store.setStarting(id, true);
  try {
    const result = await window.api.terminal.create(createRequest(scope, project.path));
    if (!result.ok) {
      toast.error(`Could not start session: ${result.error}`);
      return null;
    }
    getOrCreateEngine(result.sessionId);
    // The owner may have been removed while create was in flight; adding the tab
    // would resurrect a session record with a PTY no UI can reach.
    if (trackedProject(scope.projectId) === undefined) {
      abandon(result.sessionId);
      return null;
    }
    useSessionsStore.getState().addSession(scope, result.sessionId, result.session.title);
    return result.sessionId;
  } catch (error) {
    toast.error(`Could not start session: ${errorMessage(error)}`);
    return null;
  } finally {
    useSessionsStore.getState().setStarting(id, false);
  }
}

/** Boot a fresh PTY as a split sibling of `sourcePaneId` inside `tabId`. */
export async function createTerminalSplit(
  scope: SessionScope,
  tabId: string,
  sourcePaneId: string,
  direction: TerminalSplitDirection,
): Promise<void> {
  const store = useSessionsStore.getState();
  const id = ownerKey(scope);
  if (store.starting[id]) return;
  const project = trackedProject(scope.projectId);
  if (project === undefined) return;

  store.setStarting(id, true);
  try {
    const result = await window.api.terminal.create(createRequest(scope, project.path));
    if (!result.ok) {
      toast.error(`Could not split terminal: ${result.error}`);
      return;
    }
    getOrCreateEngine(result.sessionId);
    const tab = useSessionsStore
      .getState()
      .byOwner[id]?.tabs.find((candidate) => candidate.sessionId === tabId);
    if (
      trackedProject(scope.projectId) === undefined ||
      tab === undefined ||
      findSessionPane(tab.layout, sourcePaneId) === null
    ) {
      abandon(result.sessionId);
      return;
    }
    useSessionsStore.getState().addSplit(id, tabId, sourcePaneId, result.sessionId, direction);
  } catch (error) {
    toast.error(`Could not split terminal: ${errorMessage(error)}`);
  } finally {
    useSessionsStore.getState().setStarting(id, false);
  }
}
