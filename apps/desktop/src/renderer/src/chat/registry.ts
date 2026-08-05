/**
 * Module-level registry of live chat clients, keyed by Session id. Living
 * OUTSIDE the React tree is the whole point, and it is the terminal registry's
 * point restated for a different kind of live thing: a Session's stream, its
 * fold and its queue must survive every incidental unmount — nav switches,
 * project switches, Settings, React StrictMode's dev double-mount — and only
 * ever die when the Session itself is closed.
 *
 * The React layer treats this as get-or-create: a chat view looks its client up
 * here on mount instead of constructing one, which is what makes a queued
 * message written before a tab was closed still leave when the harness frees up.
 */
import { ChatSessionClient, type ChatSessionClientDeps } from "@renderer/chat/client";

const clients = new Map<string, ChatSessionClient>();
const membershipListeners = new Set<() => void>();

/**
 * Tell every watcher the client set changed. Snapshot AND per-listener catch:
 * the snapshot is because a listener unsubscribing itself mid-walk would skip
 * its neighbour, and the catch is because a THROWING watcher must never abort
 * the create/dispose it was merely observing — an exception escaping
 * `disposeChatClient` would strand the caller's remaining subscriptions open.
 */
function announceMembership(): void {
  const watchers = [...membershipListeners];
  for (const listener of watchers) {
    try {
      listener();
    } catch (error) {
      console.warn("chat client-set listener failed:", error);
    }
  }
}

/** The client for `sessionId`, constructing it on first request. */
export function getOrCreateChatClient(
  sessionId: string,
  deps: ChatSessionClientDeps,
): ChatSessionClient {
  let client = clients.get(sessionId);
  if (client === undefined) {
    client = new ChatSessionClient(sessionId, deps);
    clients.set(sessionId, client);
    announceMembership();
  }
  return client;
}

/**
 * Lookup only — for the React and command paths, which must NEVER construct: a
 * get-or-create there would mint a client with no stream for every keystroke
 * that races a Session close.
 */
export function getChatClient(sessionId: string): ChatSessionClient | undefined {
  return clients.get(sessionId);
}

/**
 * Every live client, in creation order. A snapshot array rather than
 * `clients.values()`: a Map iterator is single-pass, and one escaping this
 * module would read as empty the second time a caller walked it.
 */
export function liveChatClients(): readonly ChatSessionClient[] {
  return [...clients.values()];
}

/** Subscribe to the client set growing or shrinking. Paired with {@link liveChatClients}. */
export function onLiveChatClientsChanged(listener: () => void): () => void {
  membershipListeners.add(listener);
  return () => {
    membershipListeners.delete(listener);
  };
}

/** Dispose and forget a client. Call only when its Session is truly gone. */
export function disposeChatClient(sessionId: string): void {
  const client = clients.get(sessionId);
  if (client === undefined) return;
  // Forget it BEFORE disposing, so anything folding the registry into a reading
  // on the way out never counts a dying client as a live one.
  clients.delete(sessionId);
  client.dispose();
  announceMembership();
}
