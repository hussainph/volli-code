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
 * Round 2 added the two facts that made the report honest:
 *
 *  - **Which Session a terminal tab is showing.** A terminal tab's id is a bare
 *    session uuid, indistinguishable by shape from a file or browser tab id, so
 *    the terminal registry is asked rather than the string parsed. A harness
 *    alert names a PANE, so the active pane is what is reported.
 *  - **Which item a chat Session is showing.** Reporting the Session alone made
 *    a person reading one question swallow the alert about the failure beside
 *    it. `sessionNotificationItem` is the same derivation the producer used.
 *
 * ── AND WHICH ITEM, WHEN A CLICK HAS OVERRIDDEN THE ROW ──────────────────
 * A click can ask the blocker to draw an OLDER live Attention than the primary.
 * Round 3 reported the primary-derived item anyway, so the row showed one
 * problem while this told main another was visible — and the alert for the
 * problem that was NOT on screen got suppressed. There is now one record of
 * what a plane was asked to show (`chat/session-item-reveal.ts`) and one rule
 * over it (`shownSessionNotificationItem`), read here and by the blocker alike.
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
import { activeNotificationTarget } from "@renderer/lib/notification-target";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { useSessionsStore } from "@renderer/stores/sessions";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

export function useNotificationTargetReport(): void {
  const projectId = useProjectsStore((state) => state.selectedProjectId);
  const nav = useWorkspaceStore((state) =>
    projectId === null
      ? DEFAULT_WORKSPACE_UI.nav
      : (state.byProject[projectId]?.nav ?? DEFAULT_WORKSPACE_UI.nav),
  );
  const openTicketId = useWorkspaceStore((state) =>
    projectId === null ? null : (state.byProject[projectId]?.openTicketId ?? null),
  );
  const activeTicketTabId = useWorkspaceStore((state) => {
    if (projectId === null || openTicketId === null) return null;
    return state.byProject[projectId]?.ticketTabs[openTicketId]?.active ?? null;
  });
  const homeActiveTab = useWorkspaceStore((state) =>
    projectId === null
      ? DEFAULT_WORKSPACE_UI.homeActiveTab
      : (state.byProject[projectId]?.homeActiveTab ?? DEFAULT_WORKSPACE_UI.homeActiveTab),
  );
  const activeTabId = openTicketId === null ? homeActiveTab : activeTicketTabId;
  const chatSessionId = activeTabId === null ? null : parseChatTabId(activeTabId);

  // The terminal registry answers "is this tab a terminal, and which pane is
  // live in it" — the pane, because that is what a harness alert names and what
  // the person is actually typing into.
  const terminalSessionId = useSessionsStore((state) => {
    if (activeTabId === null || chatSessionId !== null) return null;
    const owner = state.byOwner[openTicketId ?? projectId ?? ""];
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
        : shownSessionNotificationItem(projection, claimed?.attentionId ?? null),
    [claimed, projection],
  );

  React.useEffect(() => {
    window.api.notifications.setActiveTarget(
      activeNotificationTarget({
        projectId,
        nav,
        openTicketId,
        activeTicketTabId,
        homeActiveTab,
        terminalSessionId,
        chatItem,
      }),
    );
  }, [activeTicketTabId, chatItem, homeActiveTab, nav, openTicketId, projectId, terminalSessionId]);
}
