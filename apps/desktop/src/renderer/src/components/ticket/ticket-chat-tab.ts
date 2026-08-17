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
 * The two facts a chat tab's dot is a function of, as the resident slice holds
 * them.
 *
 * Structural rather than `ChatSessionSlice` itself: the dot reads exactly these
 * two things, naming them is what says so, and a test can then state a Session
 * without building a whole projection to do it.
 */
export interface ChatTabReading {
  lifecycle: ChatSessionLifecycle;
  /**
   * The durable projection, or `null` before this Session's first snapshot. Its
   * open interactions are the whole of what is read: a request that is waiting
   * is a person who is needed.
   */
  projection: { interactions: { active: readonly unknown[] } } | null;
}

/**
 * A chat tab's dot. The lifecycles line up one for one with the strip's own
 * vocabulary; the only reading a chat slice cannot make is `idle`, which is what
 * the absence of a slice means — the tab is there and nothing is behind it yet.
 *
 * **`waiting` outranks `working`, for the same reason it does in the sidebar.**
 * An agent that has stopped to ask something is still inside an open turn, so
 * the strip drew the live-turn dot at it — the one dot in the app that means
 * "leave this alone, it is getting on with it" — for as long as the question
 * stood. A tab is the whole of what a background chat shows of itself, so that
 * was a Session asking for a person and telling them not to come.
 *
 * A failure still outranks both, on the plane's own precedence
 * (`sessionBlocker`): if the stream is gone, the request we are holding is a
 * memory, and a tab promising an answerable question over a dead transport
 * sends someone to a card that cannot be answered.
 */
export function chatTabStatus(slice: ChatTabReading | undefined): TicketTabStatus {
  if (slice === undefined) return "idle";
  if (slice.lifecycle === "error") return "error";
  return (slice.projection?.interactions.active.length ?? 0) > 0 ? "waiting" : slice.lifecycle;
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
