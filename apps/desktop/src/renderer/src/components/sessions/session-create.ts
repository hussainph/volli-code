/**
 * Booting Sessions outside the React tree, so every surface that can start one
 * (the Sessions page, the ticket overlay's tab strip, the ticket rail) shares
 * one code path per kind. A terminal create boots a PTY in main (ticket scope
 * injects VOLLI_TICKET env there), pre-creates the renderer engine so output
 * arriving before the view mounts is buffered, and only then registers the
 * tab/split in the unified store. A chat create mints one durable Session over
 * the Session edge and only then opens its tab. The two agree on nothing they
 * DO and on every race guard, which is {@link underOwnerGuard}. Every failure
 * toasts — a mutation is never silently swallowed (CLAUDE.md).
 */
import { errorMessage, type HarnessId, type Project } from "@volli/shared";

import { chatTabId, nextChatOrdinal } from "@renderer/components/ticket/ticket-chat-tab";
import { toastError } from "@renderer/lib/toast";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import {
  findSessionPane,
  ownerKey,
  scratchScope,
  ticketScope,
  useSessionsStore,
  type SessionLaunch,
  type SessionScope,
  type TerminalSplitDirection,
} from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useWorkspaceStore } from "@renderer/stores/workspace";
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
export function terminalCreateRequest(
  scope: SessionScope,
  projectPath: string,
  placement: "tab" | "split",
  kickoff?: SessionKickoff,
  resume?: SessionResume,
  purpose?: "model-access",
) {
  return {
    workspaceId: scope.projectId,
    cwd: projectPath,
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
    placement,
    ...(scope.kind === "scratch" && purpose ? { purpose } : {}),
    ...(scope.kind === "ticket"
      ? {
          ticket: {
            ticketId: scope.ticketId,
            ...(purpose ? { purpose } : {}),
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

/**
 * Where a surface keeps its per-owner in-flight flag, so {@link underOwnerGuard}
 * can hold one create at a time without deciding whose flag that is.
 *
 * Deliberately NOT one shared flag. The PTY store's `starting` is a fact about
 * a pane coming up, and everything that reads it reads it as one — the rail's
 * New-session button, this module's own re-entry check — so a chat create
 * latching it would be a lie about a terminal that does not exist. The two are
 * ORed only where one control mints both kinds (the ticket detail's "+"), which
 * is exactly where "something is starting here" is the honest reading.
 */
interface StartingFlag {
  isStarting(ownerId: string): boolean;
  setStarting(ownerId: string, starting: boolean): void;
}

const terminalStarting: StartingFlag = {
  isStarting: (ownerId) => useSessionsStore.getState().starting[ownerId] === true,
  setStarting: (ownerId, starting) => useSessionsStore.getState().setStarting(ownerId, starting),
};

const chatStarting: StartingFlag = {
  isStarting: (ownerId) => useChatSessionsStore.getState().starting[ownerId] === true,
  setStarting: (ownerId, starting) =>
    useChatSessionsStore.getState().setStarting(ownerId, starting),
};

/**
 * The race guards every Session boot shares, whatever it is booting: one create
 * per owner at a time (keyed by {@link ownerKey} — a projectId for a scratch
 * scope, a ticketId for a ticket one, so the flag names exactly the surface
 * whose "+" goes quiet), no boot at all into a project the renderer has stopped
 * tracking, and a `finally` that clears the flag against FRESH state however
 * the boot ended. `boot` is handed the tracked project because a terminal needs
 * its path for the PTY's cwd; a guard hit resolves null without running it.
 */
async function underOwnerGuard<T>(
  scope: SessionScope,
  flag: StartingFlag,
  boot: (project: Project) => Promise<T | null>,
): Promise<T | null> {
  const ownerId = ownerKey(scope);
  if (flag.isStarting(ownerId)) return null;
  const project = trackedProject(scope.projectId);
  if (project === undefined) return null;

  flag.setStarting(ownerId, true);
  try {
    return await boot(project);
  } finally {
    flag.setStarting(ownerId, false);
  }
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
 * The shared terminal boot pipeline behind {@link createTerminalSession} and
 * {@link createTerminalSplit}: the two differ only in how the booted PTY LANDS
 * (a fresh tab vs a split sibling) and in the failure wording, so everything
 * else — {@link underOwnerGuard}'s entry checks, the engine pre-create, the
 * stale-owner revalidation after the await, and `abandon()` when it can't land
 * — lives here exactly once. `land` performs the surface-specific placement
 * against FRESH store state and returns whether it landed (false ⇒ the
 * tab/source pane vanished mid-flight, so abandon the orphaned PTY). `verb`
 * fills `Couldn't ${verb}:`. `kickoff`/`resume` are mutually exclusive launch
 * intents (only ticket scopes ever pass either). Resolves the booted sessionId,
 * or null on any guard/failure.
 *
 * `land` receives the whole durable record main persisted, not just its title:
 * only main knows whether a harness command line was actually written into the
 * shell it spawned, and the store needs that to declare a harness expectation
 * at launch (see {@link SessionLaunch}).
 */
async function bootSession(
  scope: SessionScope,
  placement: "tab" | "split",
  verb: string,
  land: (sessionId: string, launch: SessionLaunch) => boolean,
  kickoff?: SessionKickoff,
  resume?: SessionResume,
  purpose?: "model-access",
): Promise<string | null> {
  return underOwnerGuard(scope, terminalStarting, async (project) => {
    try {
      const result = await window.api.terminal.create(
        terminalCreateRequest(scope, project.path, placement, kickoff, resume, purpose),
      );
      if (!result.ok) {
        toastError(`Couldn't ${verb}: ${result.error}`);
        return null;
      }
      getOrCreateEngine(result.sessionId);
      // The owner may have been removed while create was in flight; landing the
      // tab would resurrect a session record with a PTY no UI can reach. `land`
      // does any further revalidation (a split's source pane must still exist).
      if (
        trackedProject(scope.projectId) === undefined ||
        !land(result.sessionId, result.session)
      ) {
        abandon(result.sessionId);
        return null;
      }
      return result.sessionId;
    } catch (error) {
      toastError(`Couldn't ${verb}: ${errorMessage(error)}`);
      return null;
    }
  });
}

/**
 * Boot a new session as a fresh tab under `scope`. Resolves with its sessionId,
 * or null on failure / if the owner is no longer tracked. The tab title is the
 * one main seeded on the durable record, so the live tab and the DB agree —
 * and with a `kickoff`, the record also says an agent was launched, which is
 * what registers the session's harness expectation.
 */
export async function createTerminalSession(
  scope: SessionScope,
  kickoff?: SessionKickoff,
): Promise<string | null> {
  return bootSession(
    scope,
    "tab",
    "start session",
    (sessionId, launch) => {
      useSessionsStore.getState().addSession(scope, sessionId, launch);
      return true;
    },
    kickoff,
  );
}

/** Open the main-owned bundled Pi CLI so the user can run `/login`. */
export async function createModelAccessTerminal(scope: SessionScope): Promise<string | null> {
  return bootSession(
    scope,
    "tab",
    "open Model Access",
    (sessionId, launch) => {
      useSessionsStore.getState().addSession(scope, sessionId, launch);
      return true;
    },
    undefined,
    undefined,
    "model-access",
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
 * `window.api.terminal.create` directly. Main records a resume as an `agent`
 * launch (it refuses to resume anything else), so a resumed session declares
 * its harness expectation exactly as a fresh kickoff does.
 */
export async function resumeTicketSession(
  scope: SessionScope,
  resumeOfSessionId: string,
): Promise<string | null> {
  return bootSession(
    scope,
    "tab",
    "resume session",
    (sessionId, launch) => {
      useSessionsStore.getState().addSession(scope, sessionId, launch);
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

/** How a chat create lands once the Session is durable. */
export interface ChatBoot {
  title: string;
  /**
   * Registers the tab against FRESH store state, returning whether it landed —
   * false ⇒ the owner vanished mid-flight, so this surface lets the Session go.
   */
  land(sessionId: string): boolean;
}

/**
 * Let go of a chat Session this surface created but could not land.
 *
 * Byte-identical to closing a chat tab, and that is the point: "this surface
 * let go" has exactly one meaning, so the client is disposed and the slice
 * dropped and nothing else happens. The durable row is NOT deleted — no delete
 * channel exists, by design — and the attachment is NOT released. A Session was
 * created, so the row staying visible in the rail and in history is the honest
 * account of what happened; the alternative would be a Session the ledger
 * remembers and no surface admits to.
 */
function abandonChat(sessionId: string): void {
  useChatSessionsStore.getState().closeChatSession(sessionId);
}

/**
 * Boot one durable chat Session under `scope` and land its tab, with the same
 * guarantees the terminal path has always had: one create per owner in flight,
 * no create into an untracked project, and a stale-owner revalidation against
 * FRESH store state after the await. Resolves the Session's id, or null on any
 * guard/failure. Ticket scopes carry their ticketId onto the Session; a scratch
 * scope mints a ticketless chat, which the Session edge already accepts.
 *
 * Landing is gated on the CREATE and never on the attach: `createChatSession`
 * resolves the id even when the executor refuses to start, because the Session
 * exists either way and the tab it opens carries its own Retry. Only a failed
 * `session.create` — which has already toasted, and left nothing durable behind
 * — resolves null, and only that skips the tab.
 */
/* -------------------------------------------------------------------------- */
/* The project's ticketless Sessions — one path per kind                       */
/* -------------------------------------------------------------------------- */

/**
 * Start one of a project's ticketless Sessions and put its tab in front.
 *
 * Two callers, and they must not drift: the Sessions surface's split control
 * and the ⌘T / ⌥⌘T chords (`lib/new-session-shortcut.ts`). A chord that started
 * a Session the button would not have — or landed it somewhere the button
 * doesn't — is the class of bug you only find by pressing the key, so there is
 * one function per kind and both surfaces call it.
 *
 * The tab is recorded on `sessionsActiveTab` explicitly rather than left to the
 * container's own `activeSessionId`: {@link resolveActiveTabId} in
 * `sessions-layer.tsx` prefers the recorded id while it still names an open tab,
 * so a fresh terminal opened while another tab was recorded would otherwise land
 * behind it — the chord would look like it had done nothing at all.
 */
export async function startScratchTerminal(projectId: string): Promise<void> {
  const sessionId = await createTerminalSession(scratchScope(projectId));
  if (sessionId === null) return;
  useWorkspaceStore.getState().setSessionsActiveTab(projectId, sessionId);
}

/**
 * The chat half of {@link startScratchTerminal}.
 *
 * The ordinal counts only what is OPEN, because that is all this surface has: a
 * project's ticketless chats have no durable listing the way a ticket's do. Read
 * at call time rather than passed in, so a chord fired from another page counts
 * the same tabs the strip would have.
 */
export async function startScratchChat(projectId: string): Promise<void> {
  const openChats = useChatSessionsStore.getState().openTabs[projectId]?.length ?? 0;
  await bootChatSession(scratchScope(projectId), {
    title: `Chat ${nextChatOrdinal(0, openChats)}`,
    land: (sessionId) => {
      useChatSessionsStore.getState().openChatTab(projectId, sessionId);
      useWorkspaceStore.getState().setSessionsActiveTab(projectId, chatTabId(sessionId));
      return true;
    },
  });
}

/* -------------------------------------------------------------------------- */
/* A ticket's own Sessions — the same two paths, one owner up                  */
/* -------------------------------------------------------------------------- */

/**
 * Start one of a TICKET's Sessions and put its tab in front.
 *
 * The ticket half of {@link startScratchTerminal}, and it exists for the same
 * reason: ⌘T / ⌥⌘T resolve against what is on screen now
 * (`lib/new-session-shortcut.ts`), so inside a ticket the chord has to land a
 * Session exactly where the ticket's own control lands one. A chord that opened
 * a tab the button would not have — or left it behind the tab that was already
 * in front — is the class of bug you only find by pressing the key.
 *
 * The tab is recorded on the ticket's `active` id explicitly, not left to the
 * session container: `ticket-detail.tsx` renders whichever tab that id names, so
 * a fresh Session opened while another tab was active would otherwise land
 * behind it and the chord would look like it had done nothing.
 */
export async function startTicketTerminal(projectId: string, ticketId: string): Promise<void> {
  const sessionId = await createTerminalSession(ticketScope(projectId, ticketId));
  if (sessionId === null) return;
  useWorkspaceStore.getState().setTicketActiveTab(projectId, ticketId, sessionId);
}

/**
 * The chat half of {@link startTicketTerminal}.
 *
 * Both counts are read at call time rather than passed in, so a chord fired
 * without the rail on screen numbers the chat off the same two facts the strip
 * would have: the ticket's durable chat rows, and the tabs currently open on it.
 */
export async function startTicketChat(projectId: string, ticketId: string): Promise<void> {
  const openChats = useChatSessionsStore.getState().openTabs[ticketId]?.length ?? 0;
  const durableChats = (useTicketSessionRecordsStore.getState().byTicket[ticketId] ?? []).filter(
    (row) => row.kind === "chat",
  ).length;
  await bootChatSession(ticketScope(projectId, ticketId), {
    title: `Chat ${nextChatOrdinal(durableChats, openChats)}`,
    land: (sessionId) => {
      // The ticket itself may have been deleted while the create was in flight;
      // a tab on a card that no longer exists is unreachable, so let the Session
      // go (its durable row stands — see {@link bootChatSession}).
      const tickets = useBoardStore.getState().ticketsByProject[projectId] ?? [];
      if (!tickets.some((candidate) => candidate.id === ticketId)) return false;
      useChatSessionsStore.getState().openChatTab(ticketId, sessionId);
      useWorkspaceStore.getState().setTicketActiveTab(projectId, ticketId, chatTabId(sessionId));
      // So the rail's row for it appears without waiting on a terminal event.
      void useTicketSessionRecordsStore.getState().refresh(ticketId);
      return true;
    },
  });
}

export async function bootChatSession(
  scope: SessionScope,
  { title, land }: ChatBoot,
): Promise<string | null> {
  return underOwnerGuard(scope, chatStarting, async () => {
    try {
      const sessionId = await useChatSessionsStore.getState().createChatSession({
        projectId: scope.projectId,
        ticketId: scope.kind === "ticket" ? scope.ticketId : null,
        title,
      });
      if (sessionId === null) return null;
      // The owner may have been removed while `session.create` was in flight;
      // `land` re-checks its own owner (a ticket must still be on the board) the
      // way a split re-checks its source pane.
      if (trackedProject(scope.projectId) === undefined || !land(sessionId)) {
        abandonChat(sessionId);
        return null;
      }
      return sessionId;
    } catch (error) {
      toastError(`Couldn't start chat: ${errorMessage(error)}`);
      return null;
    }
  });
}
