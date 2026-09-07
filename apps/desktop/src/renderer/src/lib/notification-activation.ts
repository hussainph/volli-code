/**
 * Performing a notification click in this window (VC-295 rule 6).
 *
 * The DECISIONS are next door in `notification-target.ts` — where a target
 * routes, and what to say about an item that has since resolved. This module is
 * the store work that carries them out, kept out of `main.tsx` because it is
 * four stores deep and because "select the Session first, then reveal the item"
 * is an order, not a line.
 *
 * ── WHAT A CLICK MAY AND MAY NOT DO ───────────────────────────────────────
 * It may navigate: the person asked for that by clicking. It may NOT replay the
 * act the alert was about — there is nothing to replay (an answered Interaction
 * is closed and a cleared Attention is gone), and re-asking a question somebody
 * has already answered is the failure this rule exists to prevent. So a stale
 * item opens the Session anyway and says, once, why the thing it named is not
 * there.
 *
 * ── WHY THE STALE CHECK WAITS ─────────────────────────────────────────────
 * A Session adopted a moment ago has no projection yet, and "no projection" is
 * not evidence that anything resolved. So the check waits for the first
 * snapshot, up to {@link PROJECTION_WAIT_MS}, and stays silent if none arrives:
 * an unproven claim about someone's own work is worse than no claim.
 */
import { toast } from "sonner";

import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { notificationRoute, staleNotificationItemMessage } from "@renderer/lib/notification-target";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUpdateStore } from "@renderer/stores/update";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import type { NotificationTarget } from "@volli/shared";

/** How long a stale check waits for the Session's first snapshot before giving up. */
const PROJECTION_WAIT_MS = 5000;

/** Sonner's default is tuned for glanceable news; this is an explanation. */
const STALE_TOAST_MS = 6000;

/** Opens what a clicked alert pointed at. Safe to call for any target. */
export function activateNotificationTarget(target: NotificationTarget): void {
  const route = notificationRoute(target);
  if (route.kind === "update") {
    // The existing update surface, not a new one: the dialog is where an
    // install is accepted, and the badge beside it is the same state.
    useUpdateStore.getState().openDialog();
    return;
  }
  // The target may belong to a project this window is not looking at. Selecting
  // it first is what makes every later store write land in the right workspace.
  useProjectsStore.getState().select(route.projectId);
  if (route.kind === "ticket") {
    useWorkspaceStore.getState().openTicketWorkspace(route.projectId, route.ticketId);
    return;
  }
  const chat = useChatSessionsStore.getState();
  chat.adoptChatSession(route.sessionId);
  if (route.kind === "ticket-session") {
    chat.openChatTab(route.ticketId, route.sessionId);
    useWorkspaceStore.getState().openTicketWorkspace(route.projectId, route.ticketId, {
      tabId: route.tabId,
    });
  } else {
    // A Board Session has no ticket to open behind it; its tab lives on Home
    // under the project's own id.
    chat.openChatTab(route.projectId, route.sessionId);
    useWorkspaceStore.getState().openHome(route.projectId, chatTabId(route.sessionId));
  }
  if (route.interactionId === null && route.attentionId === null) return;
  void reportStaleItem(route.sessionId, {
    interactionId: route.interactionId,
    attentionId: route.attentionId,
  });
}

/** Waits for the Session's first snapshot, then explains a vanished item. */
async function reportStaleItem(
  sessionId: string,
  item: { interactionId: string | null; attentionId: string | null },
): Promise<void> {
  const current = await waitForProjection(sessionId);
  const message = staleNotificationItemMessage(item, current);
  if (message !== null) toast(message, { duration: STALE_TOAST_MS });
}

/**
 * The Session's open questions and active attentions, once its projection has
 * arrived. `null` when none arrives in time — which the caller reads as "say
 * nothing", never as "it is gone".
 */
function waitForProjection(
  sessionId: string,
): Promise<{ interactionIds: readonly string[]; attentionIds: readonly string[] } | null> {
  const read = (): {
    interactionIds: readonly string[];
    attentionIds: readonly string[];
  } | null => {
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
    const settle = (
      value: { interactionIds: readonly string[]; attentionIds: readonly string[] } | null,
    ): void => {
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
