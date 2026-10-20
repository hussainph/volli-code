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
 *  - Automations, Configure and Settings show neither, whatever the ticket
 *    record still remembers.
 *
 * A ticket is on screen only while Home's BOARD tab is in front with that
 * ticket open. Any other Home tab is on screen as itself, a project-scoped
 * tab, whether or not a ticket is still remembered behind it. Settings, and
 * every nav page but Home, put nothing on screen. A Session reported here has
 * its alerts suppressed and is marked read, so when a surface is in doubt the
 * report names less, never more. {@link visibleNotificationSurface} applies
 * these gates, the same ones `terminalFocusTargetForChrome` applies, and its
 * one answer feeds both this decision and the hook's store reads.
 *
 * Whether the WINDOW is focused is deliberately not asked here: this process
 * cannot answer it honestly (a document can have focus in an unfocused window,
 * on another Space, on a second display), and main pairs this report with
 * Electron's own focus.
 */
import type { NotificationTarget, SessionNotificationItem } from "@volli/shared";

import { isHomeBoardTab } from "@renderer/components/home/home-tabs";
import { chatTabId, parseChatTabId } from "@renderer/components/ticket/ticket-chat-tab";

/**
 * Where a terminal Session actually lives, as the terminal store holds it.
 *
 * A Session id is not enough to open a terminal: the strip is keyed by the
 * TAB's root session, the pane inside it is a second id, and which container
 * holds it (a ticket's, or the project's Board strip) is a third fact. Using
 * `chat:<sessionId>` for a harness would open a chat tab that does not exist.
 *
 * Resolved by the caller from `stores/sessions`, so this module stays pure and
 * `@volli/shared` never learns desktop tab grammar.
 */
export interface TerminalSessionPlacement {
  /** The terminal store's container key: a ticketId, or a projectId for Board. */
  ownerId: string;
  /** The tab's root Session id — also the strip's tab id. */
  tabId: string;
  /** The pane inside that tab holding the Session the alert named. */
  paneId: string;
  scope:
    | { kind: "project"; projectId: string }
    | { kind: "ticket"; projectId: string; ticketId: string };
}

/** The store reads this decision is a function of. */
interface ActiveTargetReading {
  projectId: string | null;
  nav: "home" | "automations" | "configure";
  /** App-wide Settings is chrome layered OVER the workspace, hiding Home. */
  settingsOpen: boolean;
  /** The REMEMBERED ticket — on screen only behind Home's Board tab. */
  openTicketId: string | null;
  /** The ticket workspace's active tab id, when a ticket is open. */
  activeTicketTabId: string | null;
  /** Home's active tab id — `board`, or a Session/file/browser tab. */
  homeActiveTab: string;
  /**
   * The terminal Session the active tab is showing — its ACTIVE PANE, not the
   * tab's root — or null when the active tab is not a terminal. Resolved from
   * the terminal store by the caller, which is what makes a bare-uuid tab id
   * distinguishable from a file or browser one without guessing at its shape.
   */
  terminalSessionId: string | null;
  /**
   * What the active chat Session is showing right now, from
   * `sessionNotificationItem` — the same derivation the producer used. Only
   * read when the active tab IS a chat tab.
   */
  chatItem: SessionNotificationItem;
}

/** The surface in front: the ticket it belongs to, if any, and its active tab. */
interface VisibleNotificationSurface {
  projectId: string;
  /** The ticket on screen — null on a Home work tab, even with one remembered. */
  ticketId: string | null;
  /** The tab in front of that surface, or null when it has none. */
  activeTabId: string | null;
  /** The terminal store's container key for that surface's strip. */
  ownerId: string;
}

/**
 * Which surface is in front, or null when no Home surface is visible at all.
 *
 * Home's Board tab with a ticket open shows that ticket's active tab; any other
 * Home tab shows itself, as a project-scoped tab, whatever ticket is still
 * remembered behind it. The hook reads its tab and terminal owner from this too,
 * so the report and the store reads feeding it cannot pick different surfaces.
 */
export function visibleNotificationSurface(
  reading: Pick<
    ActiveTargetReading,
    "projectId" | "nav" | "settingsOpen" | "openTicketId" | "activeTicketTabId" | "homeActiveTab"
  >,
): VisibleNotificationSurface | null {
  const { projectId } = reading;
  if (projectId === null || reading.settingsOpen || reading.nav !== "home") return null;
  if (isHomeBoardTab(reading.homeActiveTab)) {
    const ticketId = reading.openTicketId;
    return ticketId === null
      ? { projectId, ticketId: null, activeTabId: null, ownerId: projectId }
      : { projectId, ticketId, activeTabId: reading.activeTicketTabId, ownerId: ticketId };
  }
  return { projectId, ticketId: null, activeTabId: reading.homeActiveTab, ownerId: projectId };
}

/**
 * What this window is showing, in the vocabulary main suppresses against.
 *
 * Takes the surface `visibleNotificationSurface` resolved rather than resolving
 * it again, so the facts read about that surface's tab (`reading`) and the
 * surface this reports are one answer, not two.
 */
export function activeNotificationTarget(
  surface: VisibleNotificationSurface | null,
  reading: Pick<ActiveTargetReading, "terminalSessionId" | "chatItem">,
): NotificationTarget | null {
  if (surface === null) return null;
  const { projectId, ticketId, activeTabId } = surface;
  const chatSessionId = activeTabId === null ? null : parseChatTabId(activeTabId);
  // A chat Session in front is reported WITH the item it is showing.
  // Reporting the Session alone made a person reading one question swallow the
  // alert about the failure that had just stopped it.
  if (chatSessionId !== null) {
    return {
      kind: "session",
      projectId,
      ticketId,
      sessionId: chatSessionId,
      ...reading.chatItem,
    };
  }
  // A terminal in front is the Session its ACTIVE PANE is running, which the
  // caller reads from `surface.ownerId`'s strip. A harness alert names that
  // pane, and carries no item — a TUI's question is not a durable Interaction —
  // so the two compare equal exactly when the person is looking at the terminal
  // that is asking.
  if (reading.terminalSessionId !== null) {
    return {
      kind: "session",
      projectId,
      ticketId,
      sessionId: reading.terminalSessionId,
      interactionId: null,
      attentionId: null,
    };
  }
  // A file, a diff, a browser tab, or a strip with nothing in front: the ticket
  // is what is on screen. On Home, that is the board, which is nothing at all.
  return ticketId === null ? null : { kind: "ticket", projectId, ticketId };
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
  | { kind: "ticket-terminal"; projectId: string; ticketId: string; tabId: string; paneId: string }
  | { kind: "project-terminal"; projectId: string; tabId: string; paneId: string }
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

export function notificationRoute(
  target: NotificationTarget,
  /**
   * Where this Session lives as a terminal, when it does. Resolved by the
   * caller against the live terminal store: a Session that IS a terminal must
   * open its terminal, and only the store knows which tab and pane that is.
   */
  terminal: TerminalSessionPlacement | null,
): NotificationRouteInstruction {
  switch (target.kind) {
    case "session":
      // The placement wins over what the alert remembered: it is read from the
      // live strip, while the alert's ids are a memory from when it was posted.
      if (terminal !== null) {
        return terminal.scope.kind === "ticket"
          ? {
              kind: "ticket-terminal",
              projectId: terminal.scope.projectId,
              ticketId: terminal.scope.ticketId,
              tabId: terminal.tabId,
              paneId: terminal.paneId,
            }
          : {
              kind: "project-terminal",
              projectId: terminal.scope.projectId,
              tabId: terminal.tabId,
              paneId: terminal.paneId,
            };
      }
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
