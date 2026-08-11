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
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

/** The live chrome the chord resolves against — the band's selectors, read imperatively. */
function readTerminalFocusChrome(): TerminalFocusChrome {
  const selectedProjectId = useProjectsStore.getState().selectedProjectId;
  const workspace =
    selectedProjectId === null
      ? undefined
      : useWorkspaceStore.getState().byProject[selectedProjectId];
  const openTicketId = workspace?.openTicketId ?? null;
  const activeTabId =
    openTicketId === null
      ? TICKET_BODY_TAB_ID
      : (workspace?.ticketTabs[openTicketId]?.active ?? TICKET_BODY_TAB_ID);
  return {
    selectedProjectId,
    nav: workspace?.nav ?? DEFAULT_WORKSPACE_UI.nav,
    settingsOpen: useUiStore.getState().settingsOpen,
    openTicketId,
    activeSessionId: activeTerminalSessionId(
      activeTabId,
      openTicketId === null ? undefined : useSessionsStore.getState().byOwner[openTicketId]?.tabs,
    ),
  };
}

/**
 * ⌥⌘Return toggles terminal focus in both directions — the keyboard twin of the
 * chrome band's `TerminalFocusToggle`, which is why it is mounted from
 * `chrome-bar.tsx` rather than from the shell: the button and the chord are one
 * control, and they should not be able to drift apart across two files.
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
