/**
 * Tells main what this window is showing, so an alert for it is not also
 * shouted by the OS (VC-295 rule 5).
 *
 * A hook rather than a store subscription in `main.tsx` because the answer is a
 * fold of several store reads that change on every navigation, and React
 * already re-renders on exactly those. The DECISION is next door in
 * `lib/notification-target.ts`, pure and tested; this is the subscription and
 * the send.
 *
 * ── WHAT IT HAS TO RESOLVE BEFORE IT CAN ANSWER ───────────────────────────
 * The report needs to know which surface is in front first:
 * `visibleNotificationSurface`, the same resolution the decision reads, so the
 * remembered ticket behind a Home Session tab or under Settings is never the
 * strip a terminal or chat item is looked up in. Then two facts about it:
 *
 *  - **Which Session a terminal tab is showing.** A terminal tab's id is a bare
 *    session uuid, indistinguishable by shape from a file or browser tab id, so
 *    the terminal registry is asked rather than the string parsed. A harness
 *    alert names a PANE, so the active pane is what is reported.
 *  - **Which item a chat Session is showing.** Reporting the Session alone made
 *    a person reading one question swallow the alert about the failure beside
 *    it. `sessionNotificationItem` is the same derivation the producer used.
 *
 * ── AND WHICH ITEM, WHEN A CLICK HAS OVERRIDDEN THE PLANE ────────────────
 * A click can ask the blocker to draw an OLDER live Attention than the primary,
 * or the card slot to draw a question other than the first. Reporting the
 * primary-derived item would tell main that a problem not on screen was
 * visible, suppressing its alert. One record of what a plane was asked to show
 * (`chat/session-item-reveal.ts`) and one rule over it
 * (`shownSessionNotificationItem`), read here and by the plane alike.
 *
 * The report is advisory and one-way. If it never arrives — a dropped send, a
 * window still booting — the cost is one duplicate notification, which is the
 * harmless direction: the expensive failure is a person never being told their
 * agent is blocked, not being told twice.
 *
 * Focus is deliberately not reported. Main pairs this with Electron's own
 * `isFocused()`, which is the only honest source: a renderer's document can
 * hold focus in a window that is behind another app, on another Space, or on a
 * display nobody is looking at.
 */
import * as React from "react";
import { NO_SESSION_NOTIFICATION_ITEM, shownSessionNotificationItem } from "@volli/shared";

import {
  claimedSessionItem,
  subscribeClaimedSessionItems,
} from "@renderer/chat/session-item-reveal";
import { parseChatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import {
  activeNotificationTarget,
  visibleNotificationSurface,
} from "@renderer/lib/notification-target";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_PROJECT_UI, useProjectUiStore } from "@renderer/stores/project-ui";

export function useNotificationTargetReport(): void {
  const projectId = useProjectsStore((state) => state.selectedProjectId);
  const nav = useProjectUiStore((state) =>
    projectId === null
      ? DEFAULT_PROJECT_UI.nav
      : (state.byProject[projectId]?.nav ?? DEFAULT_PROJECT_UI.nav),
  );
  const openTicketId = useProjectUiStore((state) =>
    projectId === null ? null : (state.byProject[projectId]?.openTicketId ?? null),
  );
  const activeTicketTabId = useProjectUiStore((state) => {
    if (projectId === null || openTicketId === null) return null;
    return state.byProject[projectId]?.ticketTabs[openTicketId]?.active ?? null;
  });
  const homeActiveTab = useProjectUiStore((state) =>
    projectId === null
      ? DEFAULT_PROJECT_UI.homeActiveTab
      : (state.byProject[projectId]?.homeActiveTab ?? DEFAULT_PROJECT_UI.homeActiveTab),
  );
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  // Memoized so the report below re-sends when the surface changes, not on
  // every render that builds an equal object.
  const surface = React.useMemo(
    () =>
      visibleNotificationSurface({
        projectId,
        nav,
        settingsOpen,
        openTicketId,
        activeTicketTabId,
        homeActiveTab,
      }),
    [activeTicketTabId, homeActiveTab, nav, openTicketId, projectId, settingsOpen],
  );
  const activeTabId = surface?.activeTabId ?? null;
  const chatSessionId = activeTabId === null ? null : parseChatTabId(activeTabId);

  // The terminal registry answers "is this tab a terminal, and which pane is
  // live in it" — the pane, because that is what a harness alert names and what
  // the person is actually typing into.
  const terminalSessionId = useSessionsStore((state) => {
    if (surface === null || activeTabId === null || chatSessionId !== null) return null;
    const owner = state.byOwner[surface.ownerId];
    const tab = owner?.tabs.find((candidate) => candidate.sessionId === activeTabId);
    return tab?.activePaneId ?? null;
  });

  // The chat Session's own item, from its live projection. The PROJECTION is
  // what is selected — a selector returning a fresh object every call is an
  // infinite render loop — and the item is derived from it here. Nothing known
  // means nothing in particular is on screen, which is the direction that
  // DELIVERS an alert.
  const projection = useChatSessionsStore((state) =>
    chatSessionId === null ? null : (state.sessions[chatSessionId]?.projection ?? null),
  );
  // What a notification click asked this Session's plane to draw, if anything.
  // Subscribed rather than read once: the override arrives after this window is
  // already reporting, and a report that missed it would go on describing a row
  // nobody is drawing.
  const claimed = React.useSyncExternalStore(subscribeClaimedSessionItems, () =>
    chatSessionId === null ? null : claimedSessionItem(chatSessionId),
  );
  const chatItem = React.useMemo(
    () =>
      projection === null
        ? NO_SESSION_NOTIFICATION_ITEM
        : shownSessionNotificationItem(projection, claimed),
    [claimed, projection],
  );

  React.useEffect(() => {
    window.api.notifications.setActiveTarget(
      activeNotificationTarget(surface, { terminalSessionId, chatItem }),
    );
  }, [chatItem, surface, terminalSessionId]);
}
