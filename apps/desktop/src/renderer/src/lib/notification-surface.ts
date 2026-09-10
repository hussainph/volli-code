/**
 * The real notification surface: the stores this window already drives
 * (VC-295 round 2).
 *
 * Split from `notification-activation.ts` on purpose. That module owns the
 * DECISION — which route, in which order, and what to say about an item that
 * has resolved — and is covered as such; this one owns the store calls that
 * carry it out, which is view glue in the same sense `main.tsx` is: there is
 * nothing here a test could get right that the ported executor beside it does
 * not already state.
 */
import { toast } from "sonner";

import { requestSessionItemReveal } from "@renderer/chat/session-item-reveal";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import type {
  NotificationSurface,
  SessionItemsReading,
} from "@renderer/lib/notification-activation";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { findTerminalPlacement, useSessionsStore } from "@renderer/stores/sessions";
import { useUpdateStore } from "@renderer/stores/update";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** Sonner's default is tuned for glanceable news; this is an explanation. */
const STALE_TOAST_MS = 6000;

/** How long a stale check waits for the Session's first snapshot before giving up. */
const PROJECTION_WAIT_MS = 5000;

export const desktopNotificationSurface: NotificationSurface = {
  terminalPlacement: (sessionId) =>
    findTerminalPlacement(useSessionsStore.getState().byOwner, sessionId),
  selectProject: (projectId) => useProjectsStore.getState().select(projectId),
  openTicket: (projectId, ticketId) =>
    useWorkspaceStore.getState().openTicketWorkspace(projectId, ticketId),
  openChatSession: (route) => {
    const chat = useChatSessionsStore.getState();
    chat.adoptChatSession(route.sessionId);
    if (route.kind === "ticket-session") {
      chat.openChatTab(route.ticketId, route.sessionId);
      useWorkspaceStore.getState().openTicketWorkspace(route.projectId, route.ticketId, {
        tabId: route.tabId,
      });
      return;
    }
    // A Board Session has no ticket to open behind it; its tab lives on Home
    // under the project's own id.
    chat.openChatTab(route.projectId, route.sessionId);
    useWorkspaceStore.getState().openHome(route.projectId, chatTabId(route.sessionId));
  },
  openTerminal: (route) => {
    const sessions = useSessionsStore.getState();
    if (route.kind === "ticket-terminal") {
      // One seam, because these three writes are one act: the workspace has to
      // be on the ticket, the strip on that tab, and the split on that pane.
      useWorkspaceStore
        .getState()
        .openTicketSession(route.projectId, route.ticketId, route.tabId, route.paneId);
      return;
    }
    useWorkspaceStore.getState().openHome(route.projectId, route.tabId);
    sessions.setActiveSession(route.projectId, route.tabId);
    sessions.setActivePane(route.projectId, route.tabId, route.paneId);
  },
  revealItem: (sessionId, item) => requestSessionItemReveal(sessionId, item),
  openUpdate: () => useUpdateStore.getState().openDialog(),
  sessionItems: (sessionId) => waitForProjection(sessionId),
  say: (message) => void toast(message, { duration: STALE_TOAST_MS }),
};

/**
 * The Session's open questions and active attentions, once its projection has
 * arrived. `null` when none arrives in time — which the caller reads as "say
 * nothing", never as "it is gone".
 */
function waitForProjection(sessionId: string): Promise<SessionItemsReading | null> {
  const read = (): SessionItemsReading | null => {
    const projection = useChatSessionsStore.getState().sessions[sessionId]?.projection;
    if (projection === null || projection === undefined) return null;
    return {
      interactionIds: projection.interactions.active.map(({ id }) => id),
      attentionIds: projection.attention.active.map(({ id }) => id),
    };
  };
  const immediate = read();
  if (immediate !== null) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    const settle = (value: SessionItemsReading | null): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), PROJECTION_WAIT_MS);
    const unsubscribe = useChatSessionsStore.subscribe(() => {
      const value = read();
      if (value !== null) settle(value);
    });
  });
}
