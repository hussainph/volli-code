/**
 * Tells main what this window is showing, so an alert for it is not also
 * shouted by the OS (VC-295 rule 5).
 *
 * A hook rather than a store subscription in `main.tsx` because the answer is a
 * fold of four store reads that change on every navigation, and React already
 * re-renders on exactly those. The DECISION is next door in
 * `lib/notification-target.ts`, pure and tested; this is the subscription and
 * the send.
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

import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";
import { useProjectsStore } from "@renderer/stores/projects";
import { activeNotificationTarget } from "@renderer/lib/notification-target";

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

  React.useEffect(() => {
    window.api.notifications.setActiveTarget(
      activeNotificationTarget({ projectId, nav, openTicketId, activeTicketTabId, homeActiveTab }),
    );
  }, [activeTicketTabId, homeActiveTab, nav, openTicketId, projectId]);
}
