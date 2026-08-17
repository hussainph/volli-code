/**
 * Chat-tab identity for the ticket strip, and the one decision a relaunch has
 * to make about it.
 *
 * The id is prefixed — `chat:<sessionId>` — because a terminal tab's id is a
 * bare session id, and two kinds of tab sharing one id space is a routing bug
 * waiting for the first collision.
 */

import type { ChatSessionLifecycle } from "@renderer/chat/client";
import type { TicketTabStatus } from "@renderer/components/ticket/ticket-tabs";

const CHAT_TAB_PREFIX = "chat:";

/**
 * The label a chat tab wears before its Session's own title has arrived. Never
 * the id: a tab named after a UUID says less than nothing.
 */
export const CHAT_TAB_FALLBACK_LABEL = "Chat";

/**
 * A chat tab's dot. The lifecycles line up one for one with the strip's own
 * vocabulary; the only reading a chat slice cannot make is `idle`, which is what
 * the absence of a slice means — the tab is there and nothing is behind it yet.
 */
export function chatTabStatus(lifecycle: ChatSessionLifecycle | undefined): TicketTabStatus {
  return lifecycle ?? "idle";
}

/** Stable tab id for a chat Session (`chat:<sessionId>`). */
export function chatTabId(sessionId: string): string {
  return `${CHAT_TAB_PREFIX}${sessionId}`;
}

/**
 * Inverse of {@link chatTabId}: the Session id, or `null` when `tabId` is not a
 * well-formed chat tab id.
 */
export function parseChatTabId(tabId: string): string | null {
  if (!tabId.startsWith(CHAT_TAB_PREFIX)) return null;
  const sessionId = tabId.slice(CHAT_TAB_PREFIX.length);
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * What to do about a persisted active tab that nothing on screen can render.
 *
 * Terminal sessions do not survive an app restart, so a persisted id naming one
 * is stale by definition and resets to the Ticket Body. Chat Sessions do
 * survive: the id is right, there is simply no client behind it yet. So the
 * reset has to wait for the ticket's durable Session list before it can tell a
 * Session that is gone from one that has not been read yet — resetting in the
 * meantime silently drops the tab a person left open.
 *
 * `chatSessions` is the ticket's durable chat Session ids, or `undefined` while
 * that listing has never been fetched.
 */
export type ChatTabRelaunch =
  | { kind: "wait" }
  | { kind: "adopt"; sessionId: string }
  | { kind: "reset" };

export function resolveChatRelaunch(
  activeTabId: string,
  chatSessions: readonly string[] | undefined,
): ChatTabRelaunch {
  const sessionId = parseChatTabId(activeTabId);
  if (sessionId === null) return { kind: "reset" };
  if (chatSessions === undefined) return { kind: "wait" };
  return chatSessions.includes(sessionId) ? { kind: "adopt", sessionId } : { kind: "reset" };
}
