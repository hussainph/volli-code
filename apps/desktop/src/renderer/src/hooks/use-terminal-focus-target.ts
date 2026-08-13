/**
 * What terminal focus would take — asked two ways, answered once.
 *
 * Two callers need the same six chrome facts and cannot read them the same way:
 * the control drawn ON the pane (`sessions/session-split-layout.tsx`) has to be
 * SUBSCRIBED so it appears and disappears as the chrome moves, while the
 * ⌥⌘Return chord (`hooks/use-terminal-focus-shortcut.ts`) has to read them at
 * PRESS TIME, from a listener that was registered once. That is a difference in
 * mechanism, not in meaning — so every fact below is derived exactly once, as a
 * plain function of a store's state, and the two readers differ only in whether
 * they hand it `useStore(selector)` or `useStore.getState()`. The pair used to
 * be two hand-written copies of the same six lines, where a gate added to one
 * would have silently disagreed with the other and nothing would have caught it.
 *
 * The decision itself stays in `lib/terminal-focus.ts`, pure and inside the
 * coverage gate; this module holds only the store reads.
 */
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import {
  activeTerminalSessionId,
  terminalFocusTargetForChrome,
  type TerminalFocusChrome,
} from "@renderer/lib/terminal-focus";
import { useProjectsStore } from "@renderer/stores/projects";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore, type TerminalFocusTarget } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore, type NavKey } from "@renderer/stores/workspace";

type WorkspaceState = ReturnType<typeof useWorkspaceStore.getState>;
type SessionsState = ReturnType<typeof useSessionsStore.getState>;

/** The selected project's nav page, defaulted for a project it has no record for. */
function selectNav(state: WorkspaceState, projectId: string | null): NavKey {
  if (projectId === null) return DEFAULT_WORKSPACE_UI.nav;
  return state.byProject[projectId]?.nav ?? DEFAULT_WORKSPACE_UI.nav;
}

/** The selected project's open ticket, or null on the plain board. */
function selectOpenTicketId(state: WorkspaceState, projectId: string | null): string | null {
  if (projectId === null) return null;
  return state.byProject[projectId]?.openTicketId ?? null;
}

/** The open ticket's active tab. A ticket always has at least its Body in front. */
function selectTicketTabId(
  state: WorkspaceState,
  projectId: string | null,
  ticketId: string | null,
): string | null {
  if (projectId === null || ticketId === null) return null;
  return state.byProject[projectId]?.ticketTabs[ticketId]?.active ?? TICKET_BODY_TAB_ID;
}

/** The Sessions page's active tab — null for a project that has never had one. */
function selectScratchTabId(state: WorkspaceState, projectId: string | null): string | null {
  if (projectId === null) return null;
  return state.byProject[projectId]?.sessionsActiveTab ?? null;
}

/**
 * The live terminal Session an owner's active tab names, else null.
 *
 * One function for both surfaces: `byOwner` is keyed by ticketId for a ticket
 * Session and by projectId for a ticketless one, so "which owner" is the only
 * thing that differs between the ticket strip's answer and the Sessions page's.
 */
function selectTerminalSessionId(
  state: SessionsState,
  ownerId: string | null,
  tabId: string | null,
): string | null {
  return activeTerminalSessionId(
    tabId,
    ownerId === null ? undefined : state.byOwner[ownerId]?.tabs,
  );
}

/** The live chrome the chord resolves against, read imperatively at press time. */
export function readTerminalFocusChrome(): TerminalFocusChrome {
  const selectedProjectId = useProjectsStore.getState().selectedProjectId;
  const workspace = useWorkspaceStore.getState();
  const sessions = useSessionsStore.getState();
  const openTicketId = selectOpenTicketId(workspace, selectedProjectId);
  return {
    selectedProjectId,
    nav: selectNav(workspace, selectedProjectId),
    settingsOpen: useUiStore.getState().settingsOpen,
    openTicketId,
    ticketSessionId: selectTerminalSessionId(
      sessions,
      openTicketId,
      selectTicketTabId(workspace, selectedProjectId, openTicketId),
    ),
    scratchSessionId: selectTerminalSessionId(
      sessions,
      selectedProjectId,
      selectScratchTabId(workspace, selectedProjectId),
    ),
  };
}

/**
 * The same answer, subscribed — what `PaneFocusControl` renders off.
 *
 * Every selector below returns a PRIMITIVE, and that is not style. A selector
 * that built `{sessionId}` or sliced a fresh array would hand Zustand a new
 * identity on every store write anywhere in the app and re-render forever;
 * neither lint nor typecheck can see that. The composed target IS a fresh object
 * each render, which is fine — it is a return value, not a selector result.
 *
 * `sessionsActiveTab` is the Sessions page's receipt rather than its own
 * derivation: `sessions-layer.tsx` re-derives which tab is in front on every
 * render and writes the answer straight back, so reading the record here is
 * reading what that surface just decided. A one-frame-stale id simply fails to
 * name a live terminal tab, and the control does not draw — a fail-safe, not a
 * fail-wrong.
 */
export function useTerminalFocusTarget(): TerminalFocusTarget | null {
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const nav = useWorkspaceStore((state) => selectNav(state, selectedProjectId));
  const openTicketId = useWorkspaceStore((state) => selectOpenTicketId(state, selectedProjectId));
  const ticketTabId = useWorkspaceStore((state) =>
    selectTicketTabId(state, selectedProjectId, openTicketId),
  );
  const scratchTabId = useWorkspaceStore((state) => selectScratchTabId(state, selectedProjectId));
  const ticketSessionId = useSessionsStore((state) =>
    selectTerminalSessionId(state, openTicketId, ticketTabId),
  );
  const scratchSessionId = useSessionsStore((state) =>
    selectTerminalSessionId(state, selectedProjectId, scratchTabId),
  );

  return terminalFocusTargetForChrome({
    selectedProjectId,
    nav,
    settingsOpen,
    openTicketId,
    ticketSessionId,
    scratchSessionId,
  });
}
