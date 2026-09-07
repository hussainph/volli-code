/**
 * What this window is showing, and where a clicked notification goes (VC-295).
 *
 * Both directions of the same vocabulary, in one pure module so they cannot
 * drift: the target this reports as "on screen" is the same shape main compares
 * an alert against, and the route below is what makes that report true — a
 * click that opened somewhere else would mean suppression was silencing alerts
 * for a place the click does not even go.
 *
 * ── WHAT COUNTS AS "ON SCREEN AND ACTIVE" ─────────────────────────────────
 * Narrow, and one level at a time:
 *
 *  - a chat tab in front inside an open ticket IS that Session;
 *  - any other tab in front inside an open ticket is that TICKET, not its
 *    Sessions — a diff tab is not a Session's question;
 *  - a Home Session tab in front is that (Board) Session;
 *  - the board itself is neither, so nothing is suppressed while it is up;
 *  - Automations and Configure show neither, whatever the ticket record still
 *    remembers.
 *
 * Whether the WINDOW is focused is deliberately not asked here: this process
 * cannot answer it honestly (a document can have focus in an unfocused window,
 * on another Space, on a second display), and main pairs this report with
 * Electron's own focus.
 */
import type { NotificationTarget } from "@volli/shared";

import { chatTabId, parseChatTabId } from "@renderer/components/ticket/ticket-chat-tab";

/** The store reads this decision is a function of. */
export interface ActiveTargetReading {
  projectId: string | null;
  nav: "home" | "automations" | "configure";
  openTicketId: string | null;
  /** The ticket workspace's active tab id, when a ticket is open. */
  activeTicketTabId: string | null;
  /** Home's active tab id — `board`, or a Session/file/browser tab. */
  homeActiveTab: string;
}

/** What this window is showing, in the vocabulary main suppresses against. */
export function activeNotificationTarget(reading: ActiveTargetReading): NotificationTarget | null {
  const { projectId } = reading;
  if (projectId === null || reading.nav !== "home") return null;
  if (reading.openTicketId !== null) {
    const sessionId =
      reading.activeTicketTabId === null ? null : parseChatTabId(reading.activeTicketTabId);
    return sessionId === null
      ? { kind: "ticket", projectId, ticketId: reading.openTicketId }
      : {
          kind: "session",
          projectId,
          ticketId: reading.openTicketId,
          sessionId,
          // A window reports WHERE it is, never which question it is looking
          // at: the match is by Session, and carrying ids here would invite a
          // comparison this rule does not make.
          interactionId: null,
          attentionId: null,
        };
  }
  const homeSessionId = parseChatTabId(reading.homeActiveTab);
  return homeSessionId === null
    ? null
    : {
        kind: "session",
        projectId,
        ticketId: null,
        sessionId: homeSessionId,
        interactionId: null,
        attentionId: null,
      };
}

/**
 * Where a clicked alert lands, as store-independent instructions.
 *
 * A shape rather than a store call so the routing decision is testable on its
 * own; `main.tsx` performs it. The tab id is computed here because "which tab
 * is this Session" is the same grammar the active-target read above parses, and
 * two spellings of it is how a click comes to open a tab nobody is watching.
 */
export type NotificationRouteInstruction =
  | {
      kind: "ticket-session";
      projectId: string;
      ticketId: string;
      sessionId: string;
      tabId: string;
      interactionId: string | null;
      attentionId: string | null;
    }
  | {
      kind: "project-session";
      projectId: string;
      sessionId: string;
      tabId: string;
      interactionId: string | null;
      attentionId: string | null;
    }
  | { kind: "ticket"; projectId: string; ticketId: string }
  | { kind: "update" };

export function notificationRoute(target: NotificationTarget): NotificationRouteInstruction {
  switch (target.kind) {
    case "session":
      return target.ticketId === null
        ? {
            kind: "project-session",
            projectId: target.projectId,
            sessionId: target.sessionId,
            tabId: chatTabId(target.sessionId),
            interactionId: target.interactionId,
            attentionId: target.attentionId,
          }
        : {
            kind: "ticket-session",
            projectId: target.projectId,
            ticketId: target.ticketId,
            sessionId: target.sessionId,
            tabId: chatTabId(target.sessionId),
            interactionId: target.interactionId,
            attentionId: target.attentionId,
          };
    case "ticket":
      return { kind: "ticket", projectId: target.projectId, ticketId: target.ticketId };
    case "update":
      return { kind: "update" };
  }
}

/**
 * What to say when the thing an alert named is no longer there — VC-295 rule 6's
 * second half.
 *
 * The Session opens either way: the person clicked to go somewhere and the
 * routing is not conditional on the item still existing. What must not happen
 * is REPLAYING the old item (there is nothing to replay — an answered
 * Interaction is closed) or saying nothing, which reads as Volli having lost the
 * thing it just interrupted them about.
 *
 * `null` for the projection means "not loaded yet", which is deliberately NOT
 * evidence of staleness: claiming a question was answered because the snapshot
 * has not arrived would be a false statement the person could only disprove by
 * scrolling.
 */
export function staleNotificationItemMessage(
  target: { interactionId: string | null; attentionId: string | null },
  current: { interactionIds: readonly string[]; attentionIds: readonly string[] } | null,
): string | null {
  if (current === null) return null;
  if (target.interactionId !== null) {
    return current.interactionIds.includes(target.interactionId)
      ? null
      : "That question was already answered.";
  }
  if (target.attentionId !== null) {
    return current.attentionIds.includes(target.attentionId)
      ? null
      : "That problem is no longer active.";
  }
  return null;
}
