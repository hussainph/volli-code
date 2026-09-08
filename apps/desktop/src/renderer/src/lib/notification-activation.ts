/**
 * Performing a notification click in this window (VC-295 rule 6).
 *
 * The DESTINATION is decided next door in `notification-target.ts`; this module
 * is the ORDER and the acts. Both halves matter, and round 1 got the second one
 * wrong twice: every Session opened as a chat tab (so a harness waiting in a
 * terminal opened a tab that does not exist), and the item ids the alert
 * carried were used only to print a regret rather than to put the card in
 * front.
 *
 * ── THE ORDER IS THE RULE ─────────────────────────────────────────────────
 * Select the project, open the Session, THEN reveal the item. A reveal request
 * that arrived before the Session was open would be claimed by whatever plane
 * happened to be mounted, which is how a click comes to select a card in a
 * Session nobody asked for. {@link NotificationSurface} exists so that order is
 * testable rather than merely intended.
 *
 * ── WHAT A CLICK MAY AND MAY NOT DO ───────────────────────────────────────
 * It may navigate: the person asked for that by clicking. It may NOT replay the
 * act the alert was about — there is nothing to replay (an answered Interaction
 * is closed and a cleared Attention is gone), and re-asking a question somebody
 * has already answered is the failure this rule exists to prevent. So a stale
 * item opens the Session anyway and says, once, why the thing it named is not
 * there.
 *
 * A Session that never reports its projection says NOTHING: "not loaded" is not
 * evidence that anything resolved, and an unproven claim about someone's own
 * work is worse than silence.
 */
import { toast } from "sonner";

import { requestSessionItemReveal } from "@renderer/chat/session-item-reveal";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import {
  notificationRoute,
  staleNotificationItemMessage,
  type NotificationRouteInstruction,
  type TerminalSessionPlacement,
} from "@renderer/lib/notification-target";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { findTerminalPlacement, useSessionsStore } from "@renderer/stores/sessions";
import { useUpdateStore } from "@renderer/stores/update";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import type { NotificationTarget, SessionNotificationItem } from "@volli/shared";

/** Sonner's default is tuned for glanceable news; this is an explanation. */
const STALE_TOAST_MS = 6000;

/** How long a stale check waits for the Session's first snapshot before giving up. */
const PROJECTION_WAIT_MS = 5000;

/** What a Session is currently holding open, as the stale check reads it. */
export interface SessionItemsReading {
  interactionIds: readonly string[];
  attentionIds: readonly string[];
}

/**
 * Everything a click does to this window, as ports.
 *
 * A seam rather than direct store calls in the function below, because the
 * thing worth testing here is not which store answers — it is the sequence, and
 * that a terminal Session never takes the chat route.
 */
export interface NotificationSurface {
  /** Where this Session lives as a terminal, or null when it is a chat Session. */
  terminalPlacement(sessionId: string): TerminalSessionPlacement | null;
  selectProject(projectId: string): void;
  openTicket(projectId: string, ticketId: string): void;
  openChatSession(
    route: Extract<NotificationRouteInstruction, { kind: "ticket-session" | "project-session" }>,
  ): void;
  openTerminal(
    route: Extract<NotificationRouteInstruction, { kind: "ticket-terminal" | "project-terminal" }>,
  ): void;
  /** Asks the Session's chat plane to put this exact question or failure in front. */
  revealItem(sessionId: string, item: SessionNotificationItem): void;
  openUpdate(): void;
  /** The Session's open items once it has reported; null when it never does. */
  sessionItems(sessionId: string): Promise<SessionItemsReading | null>;
  /** One sentence to the person. */
  say(message: string): void;
}

/** Opens what a clicked alert pointed at. Safe to call for any target. */
export async function activateNotificationTarget(
  target: NotificationTarget,
  surface: NotificationSurface = desktopNotificationSurface,
): Promise<void> {
  const route = notificationRoute(
    target,
    target.kind === "session" ? surface.terminalPlacement(target.sessionId) : null,
  );
  if (route.kind === "update") {
    // The existing update surface, not a new one: the dialog is where an
    // install is accepted, and the badge beside it is the same state.
    surface.openUpdate();
    return;
  }
  // The target may belong to a project this window is not looking at. Selecting
  // it first is what makes every later store write land in the right workspace.
  surface.selectProject(route.projectId);
  if (route.kind === "ticket") {
    surface.openTicket(route.projectId, route.ticketId);
    return;
  }
  if (route.kind === "ticket-terminal" || route.kind === "project-terminal") {
    // A terminal IS its own reveal: the pane comes forward with its scrollback
    // and its prompt, and there is no durable item to select inside it.
    surface.openTerminal(route);
    return;
  }
  surface.openChatSession(route);
  const item = { interactionId: route.interactionId, attentionId: route.attentionId };
  if (item.interactionId === null && item.attentionId === null) return;
  // Now, and not before: the plane that claims this request has to be the one
  // the click just put in front.
  surface.revealItem(route.sessionId, item);
  const current = await surface.sessionItems(route.sessionId);
  const message = staleNotificationItemMessage(item, current);
  if (message !== null) surface.say(message);
}

/** The real surface: the stores this window already drives. */
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
