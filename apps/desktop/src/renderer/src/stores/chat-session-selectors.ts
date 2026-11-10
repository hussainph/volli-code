/**
 * Chat-store selectors that would otherwise walk every resident Session on
 * every store write (VC-515).
 *
 * A streaming chat writes the store once per frame, and every mounted
 * subscriber's selector runs on each write. A selector that folds the whole
 * `sessions` map therefore costs O(open chats) per frame for as long as any
 * one of them streams — whether or not its component has anything to draw.
 * These are the two such selectors outside the sidebar, held to O(1) per
 * write when they have nothing to answer.
 */
import type { ChatSessionsState } from "./chat-sessions";

const NO_TITLES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * The ⌘K palette's resident titles: a durable row's title as this window
 * knows it now, ahead of the listing. Only an OPEN palette has rows to label,
 * so a closed one — which is mounted for the app's whole life — answers the
 * same empty map without reading the store.
 *
 * Wrap in `useShallow`: the open answer is a fresh object per write.
 */
export function paletteResidentTitlesSelector(
  open: boolean,
): (state: ChatSessionsState) => Readonly<Record<string, string>> {
  if (!open) return () => NO_TITLES;
  return (state) => {
    const titles: Record<string, string> = {};
    for (const [sessionId, slice] of Object.entries(state.sessions)) {
      const title = slice.projection?.session.title;
      if (title !== null && title !== undefined) titles[sessionId] = title;
    }
    return titles;
  };
}

/**
 * A value that moves whenever any chat Session's lifecycle moves — the usage
 * rail's cue to re-read a rollup. The store keeps the count as it writes
 * (`settleRevision`), so reading it is O(1) where joining every slice's
 * lifecycle was O(open chats) per streamed frame. A string, because the usage
 * cache compares the signal it read under by value.
 */
export function selectSettleSignal(state: ChatSessionsState): string {
  return String(state.settleRevision);
}
