/**
 * Booting terminal sessions + splits, outside the React tree so both surfaces
 * (the Sessions page and the ticket overlay) share one code path. A create
 * boots a PTY in main (ticket scope injects VOLLI_TICKET env there), pre-creates
 * the renderer engine so output arriving before the view mounts is buffered, and
 * only then registers the tab/split in the unified store. Every failure toasts —
 * a mutation is never silently swallowed (CLAUDE.md).
 */
import { errorMessage, type HarnessId } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";
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

/**
 * The agent-launch intent for a ticket session's initial shell: main runs the
 * harness CLI with `prompt` as its opening argument (see `pty.ts`). Only
 * meaningful for ticket scopes.
 */
export interface SessionKickoff {
  harnessId: HarnessId;
  prompt: string;
}

/**
 * The resume intent for a ticket session's boot (interrupt/resume, issue
 * #78): `sessionId` names the ENDED session whose durable record (harness +
 * harness session id) main resolves into a resume command, run in that
 * ticket's existing worktree cwd. Mutually exclusive with {@link SessionKickoff}.
 */
export interface SessionResume {
  sessionId: string;
}

/** The main-process create request derived from a scope (ticket scopes carry env-injection intent). */
function createRequest(
  scope: SessionScope,
  projectPath: string,
  placement: "tab" | "split",
  kickoff?: SessionKickoff,
  resume?: SessionResume,
) {
  return {
    workspaceId: scope.projectId,
    cwd: projectPath,
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
    placement,
    ...(scope.kind === "ticket"
      ? {
          ticket: {
            ticketId: scope.ticketId,
            ...(kickoff ? { kickoff } : {}),
            ...(resume ? { resume } : {}),
          },
        }
      : {}),
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
      if (!result.ok) toastError(`Terminal close failed: ${result.error}`);
    })
    .catch((error: unknown) => {
      toastError(`Terminal close failed: ${errorMessage(error)}`);
    });
}

/**
 * The shared boot pipeline behind {@link createTerminalSession} and
 * {@link createTerminalSplit}: the two differ only in how the booted PTY LANDS
 * (a fresh tab vs a split sibling) and in the failure wording, so every race
 * guard — the per-owner starting flag, the tracked-project check, the engine
 * pre-create, the stale-owner revalidation after the await, `abandon()` when it
 * can't land, and the `finally` that clears `starting` — lives here exactly
 * once. `land` performs the surface-specific placement against FRESH store
 * state and returns whether it landed (false ⇒ the tab/source pane vanished
 * mid-flight, so abandon the orphaned PTY). `verb` fills `Could not ${verb}:`.
 * `kickoff`/`resume` are mutually exclusive launch intents (only ticket
 * scopes ever pass either). Resolves the booted sessionId, or null on any
 * guard/failure.
 */
async function bootSession(
  scope: SessionScope,
  placement: "tab" | "split",
  verb: string,
  land: (sessionId: string, title: string) => boolean,
  kickoff?: SessionKickoff,
  resume?: SessionResume,
): Promise<string | null> {
  const store = useSessionsStore.getState();
  const id = ownerKey(scope);
  if (store.starting[id]) return null;
  const project = trackedProject(scope.projectId);
  if (project === undefined) return null;

  store.setStarting(id, true);
  try {
    const result = await window.api.terminal.create(
      createRequest(scope, project.path, placement, kickoff, resume),
    );
    if (!result.ok) {
      toastError(`Could not ${verb}: ${result.error}`);
      return null;
    }
    getOrCreateEngine(result.sessionId);
    // The owner may have been removed while create was in flight; landing the
    // tab would resurrect a session record with a PTY no UI can reach. `land`
    // does any further revalidation (a split's source pane must still exist).
    if (
      trackedProject(scope.projectId) === undefined ||
      !land(result.sessionId, result.session.title)
    ) {
      abandon(result.sessionId);
      return null;
    }
    return result.sessionId;
  } catch (error) {
    toastError(`Could not ${verb}: ${errorMessage(error)}`);
    return null;
  } finally {
    useSessionsStore.getState().setStarting(id, false);
  }
}

/**
 * Boot a new session as a fresh tab under `scope`. Resolves with its sessionId,
 * or null on failure / if the owner is no longer tracked. The tab title is the
 * one main seeded on the durable record, so the live tab and the DB agree.
 */
export async function createTerminalSession(
  scope: SessionScope,
  kickoff?: SessionKickoff,
): Promise<string | null> {
  return bootSession(
    scope,
    "tab",
    "start session",
    (sessionId, title) => {
      useSessionsStore.getState().addSession(scope, sessionId, title);
      return true;
    },
    kickoff,
  );
}

/**
 * Boot a resumed session as a fresh tab (interrupt/resume, issue #78): the
 * exact same boot pipeline as {@link createTerminalSession} — starting-flag
 * guard, engine pre-create, stale-owner abandon, structured-error toast — but
 * main resolves the harness's resume command from `resumeOfSessionId`'s own
 * durable record instead of a fresh kickoff prompt, and runs it in the
 * ticket's existing worktree. `scope` is typed as the general {@link SessionScope}
 * (matching `createTerminalSession`'s own convention — callers pass whatever
 * `ticketScope()`/a live tab's `.scope` hands them) but is only ever called
 * with a ticket scope in practice: resume has no scratch-session meaning, and
 * a scratch `ticketId`-less ticket object passed to main's IPC layer would
 * simply omit the `ticket` field, so nothing resumes. The resumed session
 * lands as a NEW tab; the ended session's own pane/scrollback is left
 * untouched. Every one of the rail, exited-pane overlay, and ticket context
 * menu resume affordances call only this — no surface talks to
 * `window.api.terminal.create` directly.
 */
export async function resumeTicketSession(
  scope: SessionScope,
  resumeOfSessionId: string,
): Promise<string | null> {
  return bootSession(
    scope,
    "tab",
    "resume session",
    (sessionId, title) => {
      useSessionsStore.getState().addSession(scope, sessionId, title);
      return true;
    },
    undefined,
    { sessionId: resumeOfSessionId },
  );
}

/** Boot a fresh PTY as a split sibling of `sourcePaneId` inside `tabId`. */
export async function createTerminalSplit(
  scope: SessionScope,
  tabId: string,
  sourcePaneId: string,
  direction: TerminalSplitDirection,
): Promise<void> {
  const id = ownerKey(scope);
  await bootSession(scope, "split", "split terminal", (sessionId) => {
    const tab = useSessionsStore
      .getState()
      .byOwner[id]?.tabs.find((candidate) => candidate.sessionId === tabId);
    if (tab === undefined || findSessionPane(tab.layout, sourcePaneId) === null) return false;
    useSessionsStore.getState().addSplit(id, tabId, sourcePaneId, sessionId, direction);
    return true;
  });
}
