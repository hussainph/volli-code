import * as React from "react";

import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import {
  activeTerminalSessionId,
  isTerminalFocusKeyEvent,
  terminalFocusTargetForChrome,
  type TerminalFocusChrome,
} from "@renderer/lib/terminal-focus";
import { useProjectsStore } from "@renderer/stores/projects";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore, type TerminalFocusTarget } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

/** The live chrome the chord resolves against, read imperatively at press time. */
function readTerminalFocusChrome(): TerminalFocusChrome {
  const selectedProjectId = useProjectsStore.getState().selectedProjectId;
  const workspace =
    selectedProjectId === null
      ? undefined
      : useWorkspaceStore.getState().byProject[selectedProjectId];
  const openTicketId = workspace?.openTicketId ?? null;
  const sessions = useSessionsStore.getState();
  return {
    selectedProjectId,
    nav: workspace?.nav ?? DEFAULT_WORKSPACE_UI.nav,
    settingsOpen: useUiStore.getState().settingsOpen,
    openTicketId,
    ticketSessionId: activeTerminalSessionId(
      openTicketId === null
        ? null
        : (workspace?.ticketTabs[openTicketId]?.active ?? TICKET_BODY_TAB_ID),
      openTicketId === null ? undefined : sessions.byOwner[openTicketId]?.tabs,
    ),
    scratchSessionId: activeTerminalSessionId(
      workspace?.sessionsActiveTab ?? null,
      selectedProjectId === null ? undefined : sessions.byOwner[selectedProjectId]?.tabs,
    ),
  };
}

/**
 * The same answer, subscribed — what {@link PaneFocusControl} renders off.
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
  const nav = useWorkspaceStore((state) =>
    selectedProjectId === null
      ? DEFAULT_WORKSPACE_UI.nav
      : (state.byProject[selectedProjectId]?.nav ?? DEFAULT_WORKSPACE_UI.nav),
  );
  const openTicketId = useWorkspaceStore((state) =>
    selectedProjectId === null ? null : (state.byProject[selectedProjectId]?.openTicketId ?? null),
  );
  const ticketTabId = useWorkspaceStore((state) =>
    selectedProjectId === null || openTicketId === null
      ? null
      : (state.byProject[selectedProjectId]?.ticketTabs[openTicketId]?.active ??
        TICKET_BODY_TAB_ID),
  );
  const scratchTabId = useWorkspaceStore((state) =>
    selectedProjectId === null
      ? null
      : (state.byProject[selectedProjectId]?.sessionsActiveTab ?? null),
  );
  const ticketSessionId = useSessionsStore((state) =>
    activeTerminalSessionId(
      ticketTabId,
      openTicketId === null ? undefined : state.byOwner[openTicketId]?.tabs,
    ),
  );
  const scratchSessionId = useSessionsStore((state) =>
    activeTerminalSessionId(
      scratchTabId,
      selectedProjectId === null ? undefined : state.byOwner[selectedProjectId]?.tabs,
    ),
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

/**
 * ⌥⌘Return toggles terminal focus in both directions — the keyboard twin of two
 * buttons now, the pane's own corner control (enter) and the band's persistent
 * Exit. It stays mounted from `chrome-bar.tsx` because the band is the one
 * component alive on every page: the enter control comes and goes with the pane
 * it sits on, and a chord hosted by a component that unmounts is a chord that
 * stops working exactly where it is hardest to notice.
 *
 * CAPTURE phase, and it stops the event dead. Both halves are load-bearing:
 *
 *  • Exiting has to work while a PTY holds keyboard focus, which is the one
 *    state where a bubble-phase window listener is at the mercy of whatever the
 *    terminal host does with the key first. (⌘ chords do reach the app today —
 *    `optionAsAltSequence` bails on `metaKey` — but "today" is not a contract.)
 *  • The chord is swallowed even when nothing can be focused, exactly as ⌥⌘B is.
 *    Falling through would hand ⌥⌘Return to the nearest composer, whose submit
 *    guard reads `event.key === "Enter" && (event.metaKey || event.ctrlKey)` and
 *    does not exclude Option — so the chord would silently SEND A MESSAGE on
 *    precisely the screens where it cannot mean terminal focus. A chord that
 *    means two unrelated things depending on what is on screen is a chord you
 *    have to look up before pressing.
 *
 * Stores are read at press time rather than from a render closure, so the chord
 * resolves against the chrome as it is when the key goes down.
 */
export function useTerminalFocusShortcut(): void {
  React.useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (!isTerminalFocusKeyEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      const { terminalFocusTarget, setTerminalFocusTarget } = useUiStore.getState();
      // Exiting needs no gate: the store's own invariants already keep the
      // target naming a tab of the ticket that is open.
      if (terminalFocusTarget !== null) {
        setTerminalFocusTarget(null);
        return;
      }
      const target = terminalFocusTargetForChrome(readTerminalFocusChrome());
      if (target === null) return;
      setTerminalFocusTarget(target);
    };

    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, []);
}
