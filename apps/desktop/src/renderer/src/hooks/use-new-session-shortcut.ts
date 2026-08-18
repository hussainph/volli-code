import * as React from "react";

import {
  startProjectChat,
  startProjectTerminal,
  startTicketChat,
  startTicketTerminal,
} from "@renderer/components/sessions/session-create";
import {
  isNewSessionGuardedTarget,
  newSessionKindForKeyEvent,
  newSessionLandingForChrome,
} from "@renderer/lib/new-session-shortcut";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * ⌘T starts a chat, ⌥⌘T starts a terminal, on whatever owns the surface in
 * front — the open ticket, or the project itself.
 *
 * The renderer, not `main/menu.ts`. Every app-specific shortcut this build has —
 * ⌘K, ⌘1–9, ⌘[ / ⌘], ⌥⌘B, bare "c" — is a renderer `keydown` listener over a
 * pure predicate, and `menu.ts` carries only roles and zoom; putting the one
 * create verb in the app on a different rail from every other verb would be the
 * odd thing, not the consistent one.
 *
 * Stores are read at press time rather than from a render closure, so the chord
 * resolves against the chrome as it is when the key goes down. Mounted once,
 * from `SessionsLayer` — the app's one always-mounted component.
 *
 * No terminal-focus guard, deliberately, and it is the one place this differs
 * from ⌘K: a pty is sent Ctrl chords, not Cmd chords, so ⌘T means nothing to a
 * shell and suppressing it would break the chord exactly where a second Session
 * is most often wanted. ⌘K guards because ⌘K clears a shell; ⌘T has no twin.
 *
 * An EDITOR guard, though, for the opposite reason to plain-"c"'s: ⌘T inserts no
 * character, so there is no typing to protect — what there is, is an uncommitted
 * edit that a new tab would move the surface out from under. Double-click a tab
 * to rename it and press ⌘T, and a chat Session boots behind a rename box still
 * waiting on Enter. See {@link isNewSessionGuardedTarget} for what it covers and
 * for the two surfaces it deliberately does not.
 *
 * No in-flight guard either. Both boot paths already run under
 * `underOwnerGuard`, which allows one create per owner at a time, so a held key
 * is refused twice over — here by the predicate's `repeat` rejection, there by
 * the guard.
 */
export function useNewSessionShortcut(): void {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const kind = newSessionKindForKeyEvent(event);
      if (kind === null) return;
      if (isNewSessionGuardedTarget(event.target)) return;

      const selectedProjectId = useProjectsStore.getState().selectedProjectId;
      const workspace = useWorkspaceStore.getState();
      const ui = selectedProjectId === null ? undefined : workspace.byProject[selectedProjectId];
      const { settingsOpen, newTicketOpen } = useUiStore.getState();
      const landing = newSessionLandingForChrome({
        selectedProjectId,
        nav: ui?.nav ?? DEFAULT_WORKSPACE_UI.nav,
        settingsOpen,
        newTicketOpen,
        openTicketId: ui?.openTicketId ?? null,
      });
      if (landing === null) return;

      event.preventDefault();
      // Navigate first: the Session lands on a surface that is already the one
      // in front, so the tab appears where the user is looking rather than
      // behind a page they then have to find. A ticket landing never navigates
      // — the ticket IS the surface in front.
      if (landing.navigateTo !== null) workspace.setNav(landing.projectId, landing.navigateTo);
      const { projectId, ticketId } = landing;
      // One call per cell of the same 2×2 the controls draw, and every one of
      // them is the exact function the matching control calls (session-create.ts)
      // — the chord and the button cannot start different things.
      void (ticketId === null
        ? kind === "chat"
          ? startProjectChat(projectId)
          : startProjectTerminal(projectId)
        : kind === "chat"
          ? startTicketChat(projectId, ticketId)
          : startTicketTerminal(projectId, ticketId));
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
