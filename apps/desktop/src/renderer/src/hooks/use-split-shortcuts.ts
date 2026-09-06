/**
 * ⌘\ splits the focused pane right, ⇧⌘\ splits it down, ⌃⌘ + an arrow moves
 * between panes (VC-202 §5).
 *
 * The renderer, not `main/menu.ts` — the same argument `use-new-session-shortcut.ts`
 * makes: every app-specific chord in this build is a renderer `keydown` over a
 * pure predicate, and `menu.ts` carries only roles and zoom.
 *
 * MOUNTED BY THE SURFACE, one instance each, which is the one place this
 * departs from ⌘T's placement discipline and it is forced: a split has to
 * record the strip as it stands at the moment it opens (`surfaceTabIds`, so no
 * open tab is left unclaimed — see the store's `splitHomePane`), and the only
 * component that knows that list is the surface drawing it. Both instances are
 * mounted while a ticket workspace is open (Home hosts the detail view), so
 * each asks the SAME pure predicate which surface is in front and the one that
 * is not stands down. Two listeners, one answer.
 *
 * NOTHING HERE ANIMATES. A keyboard-initiated split appears instantly: this is
 * a chord that will be pressed tens of times a day, and animation on those is
 * what makes an app feel slow (the animation decision framework's first rule).
 * The drop zones' motion belongs to the drag, which is a different act.
 */
import * as React from "react";

import { SPLIT_VIEW_ROOT_PANE_ID } from "@volli/shared";

import {
  isSplitGuardedTarget,
  splitShortcutForKeyEvent,
  splitSurfaceForChrome,
} from "@renderer/lib/split-shortcut";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

export interface SplitShortcutTarget {
  projectId: string | null;
  /** `null` for Home; the ticket id for a ticket workspace. */
  ticketId: string | null;
  /**
   * The surface's live strip, in drawn order — what the FIRST split of a
   * surface records as the primary pane's claim. Read at press time through a
   * ref, so a chord resolves against the strip as it is rather than as it was
   * when the listener was installed.
   */
  orderedTabIds: readonly string[];
}

export function useSplitShortcuts({ projectId, ticketId, orderedTabIds }: SplitShortcutTarget) {
  const latest = React.useRef({ projectId, ticketId, orderedTabIds });
  latest.current = { projectId, ticketId, orderedTabIds };

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcut = splitShortcutForKeyEvent(event);
      if (shortcut === null) return;
      if (isSplitGuardedTarget(event.target)) return;

      const mine = latest.current;
      if (mine.projectId === null) return;
      const selectedProjectId = useProjectsStore.getState().selectedProjectId;
      const workspace = useWorkspaceStore.getState();
      const ui = selectedProjectId === null ? undefined : workspace.byProject[selectedProjectId];
      const { settingsOpen, newTicketOpen, terminalFocusTarget } = useUiStore.getState();
      const surface = splitSurfaceForChrome({
        selectedProjectId,
        nav: ui?.nav ?? DEFAULT_WORKSPACE_UI.nav,
        homeActiveTab: ui?.homeActiveTab ?? DEFAULT_WORKSPACE_UI.homeActiveTab,
        settingsOpen,
        newTicketOpen,
        openTicketId: ui?.openTicketId ?? null,
        terminalFocused: terminalFocusTarget !== null,
      });
      // Not this surface's press. Both surfaces listen while a ticket workspace
      // is open, and exactly one of them is the one in front.
      if (
        surface === null ||
        surface.projectId !== mine.projectId ||
        surface.ticketId !== mine.ticketId
      ) {
        return;
      }

      const { ticketId: ticket, projectId: project } = surface;
      const split =
        ticket === null ? (ui?.homeSplitView ?? null) : (ui?.ticketTabs[ticket]?.splitView ?? null);

      if (shortcut.kind === "focus") {
        // Nothing to move between while the surface is one pane — and a chord
        // that does nothing should not also swallow the keypress.
        if (split === null) return;
        event.preventDefault();
        if (ticket === null) workspace.focusAdjacentHomePane(project, shortcut.direction);
        else workspace.focusAdjacentTicketPane(project, ticket, shortcut.direction);
        return;
      }

      event.preventDefault();
      // An unsplit surface is drawn as ONE pane under the root id, which is
      // what lets ⌘\ name its subject before any split exists.
      const paneId = split?.focusedPaneId ?? SPLIT_VIEW_ROOT_PANE_ID;
      const opts = { surfaceTabIds: mine.orderedTabIds };
      if (ticket === null) workspace.splitHomePane(project, paneId, shortcut.edge, opts);
      else workspace.splitTicketPane(project, ticket, paneId, shortcut.edge, opts);
      focusNewPaneMenu();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * Put keyboard focus on the new pane's first menu row.
 *
 * The sanctioned exception to the grid's "nothing here calls `.focus()`" rule
 * (VC-202 §6), and the distinction is the whole of it: the grid must not move
 * focus for a POINTER, because a click already landed it on whatever was
 * clicked. A keyboard act is the opposite — nothing moved, so the pane that
 * just opened is unreachable without a hand on the mouse, which is exactly what
 * the chord existed to avoid.
 *
 * On the next frame, because the pane does not exist until the store write has
 * rendered. A frame later the surface may have gone (Escape, a project switch),
 * so a missing row is a no-op rather than a retry.
 */
function focusNewPaneMenu(): void {
  window.requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(
        '[data-slot="split-view-pane"][data-focused="true"] [data-slot="pane-empty-row"]',
      )
      ?.focus();
  });
}
