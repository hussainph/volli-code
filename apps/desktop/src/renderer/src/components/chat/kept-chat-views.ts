/**
 * Which chat views a surface keeps mounted behind the one in front (VC-1080).
 *
 * A chat pane used to draw only its front tab, keyed by Session, so going back
 * to a chat one tab over rebuilt it from nothing: Streamdown re-parsed up to a
 * transcript window of markdown, Shiki re-applied every code block's tokens in
 * a second render, and the scroll restore measured layout synchronously. The
 * fold, the stream and the reading position all survived the unmount (the
 * registry client, `transcript-window.ts`), so the rebuild bought nothing.
 *
 * So the last few chats a pane showed stay mounted behind React `<Activity
 * mode="hidden">`. Hidden is not "visible with display:none": Activity tears
 * every effect of the subtree down, which is what keeps a kept view from
 * counting as SHOWN to the chat store (`showChatSession`, VC-515 — a hidden view
 * must not pin its client against idle eviction), from answering keyboard
 * shortcuts or holding store subscriptions, and its effects come back on reveal
 * exactly as a mount's would. What survives is the rendered tree: the parsed
 * markdown, the highlighted code, the DOM.
 *
 * MEMORY BOUND. At most {@link KEPT_HIDDEN_CHAT_VIEWS} hidden views per surface
 * (Home is one surface, each Ticket view another), each one transcript window —
 * {@link TRANSCRIPT_TAIL_ROWS} rows plus whatever pages its reader revealed.
 * That is below the chat store's idle-client cap (`MAX_HIDDEN_IDLE_CLIENTS`, 8),
 * so the views a surface keeps never outnumber the clients it may keep warm. A
 * view whose tab closed, or whose pane went away, leaves the list on the same
 * render.
 *
 * Pure and keyed by pane: a Session's view belongs to the pane cell it was
 * drawn in, and a split can show one Session in two panes at once.
 *
 * @see TRANSCRIPT_TAIL_ROWS in `transcript-window.ts`
 */
import * as React from "react";

import { parseChatTabId } from "@renderer/components/ticket/ticket-chat-tab";

/** One chat view in one pane cell. */
export interface ChatViewPlace {
  readonly paneId: string;
  readonly sessionId: string;
}

/**
 * Hidden chat views a surface keeps mounted. Must stay at or below the chat
 * store's idle-client cap (`MAX_HIDDEN_IDLE_CLIENTS` in `stores/chat-sessions.ts`).
 */
export const KEPT_HIDDEN_CHAT_VIEWS = 3;

const placeKey = (place: ChatViewPlace): string => `${place.paneId}\u0000${place.sessionId}`;

/**
 * The views to keep after this render, least recently shown first: every shown
 * one, and up to `cap` of the most recently shown hidden ones still held by a
 * pane. Returns `previous` itself when nothing changed, so a caller holding it
 * in state can tell a real change from a re-render.
 *
 * @param previous  What the last render kept, in the same order.
 * @param shown     The chat each pane has in front.
 * @param present   Every chat tab a pane holds, shown or not — a kept view
 *                  whose tab is gone is dropped.
 */
export function keepChatViews(
  previous: readonly ChatViewPlace[],
  shown: readonly ChatViewPlace[],
  present: readonly ChatViewPlace[],
  cap: number = KEPT_HIDDEN_CHAT_VIEWS,
): readonly ChatViewPlace[] {
  const shownKeys = new Set(shown.map(placeKey));
  const presentKeys = new Set(present.map(placeKey));
  const hidden = previous.filter((place) => {
    const key = placeKey(place);
    return !shownKeys.has(key) && presentKeys.has(key);
  });
  const trimmed = hidden.slice(Math.max(0, hidden.length - cap));
  // Shown last: they are the most recent. Kept in their previous relative
  // order when they were already kept, so an unchanged render is unchanged.
  const shownOrdered = [
    ...previous.filter((place) => shownKeys.has(placeKey(place))),
    ...shown.filter((place) => !previous.some((kept) => placeKey(kept) === placeKey(place))),
  ];
  const seen = new Set<string>();
  const next = [...trimmed, ...shownOrdered].filter((place) => {
    const key = placeKey(place);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return next.length === previous.length &&
    next.every((place, index) => placeKey(place) === placeKey(previous[index]!))
    ? previous
    : next;
}

/**
 * Hold {@link keepChatViews}' answer across renders and return a membership
 * test. Resolved DURING render rather than in an effect: an effect would land a
 * commit late, after the switch had already unmounted the view it meant to keep.
 */
export function useKeptChatViews(
  shown: readonly ChatViewPlace[],
  present: readonly ChatViewPlace[],
  cap: number = KEPT_HIDDEN_CHAT_VIEWS,
): (paneId: string, sessionId: string) => boolean {
  const [kept, setKept] = React.useState<readonly ChatViewPlace[]>([]);
  const next = keepChatViews(kept, shown, present, cap);
  // React's "state from the previous render" pattern: re-runs this component
  // with the new list before committing, never an extra commit.
  if (next !== kept) setKept(next);
  const keys = React.useMemo(() => new Set(next.map(placeKey)), [next]);
  return React.useCallback(
    (paneId: string, sessionId: string) => keys.has(placeKey({ paneId, sessionId })),
    [keys],
  );
}

/** The slice of a resolved split-view pane this module reads. */
export interface ChatViewPane {
  readonly id: string;
  readonly tabIds: readonly string[];
  readonly activeTabId: string | null;
}

/** One chat view a pane cell draws: the one in front, or one kept hidden. */
export interface PaneChatView {
  readonly sessionId: string;
  readonly shown: boolean;
}

/**
 * {@link useKeptChatViews} for a surface's split-view panes. Returns, per pane,
 * the chat views its cell should draw, in the pane's own tab order — a stable
 * order, so a switch never moves a kept view's DOM node (which would reset its
 * scroller).
 */
export function usePaneChatViews(
  panes: readonly ChatViewPane[],
): (pane: ChatViewPane) => readonly PaneChatView[] {
  const shown: ChatViewPlace[] = [];
  const present: ChatViewPlace[] = [];
  for (const pane of panes) {
    for (const tabId of pane.tabIds) {
      const sessionId = parseChatTabId(tabId);
      if (sessionId !== null) present.push({ paneId: pane.id, sessionId });
    }
    const front = pane.activeTabId === null ? null : parseChatTabId(pane.activeTabId);
    if (front !== null) shown.push({ paneId: pane.id, sessionId: front });
  }
  const isKept = useKeptChatViews(shown, present);
  return React.useCallback(
    (pane: ChatViewPane) => {
      const front = pane.activeTabId === null ? null : parseChatTabId(pane.activeTabId);
      const views: PaneChatView[] = [];
      for (const tabId of pane.tabIds) {
        const sessionId = parseChatTabId(tabId);
        if (sessionId === null || views.some((view) => view.sessionId === sessionId)) continue;
        if (sessionId === front) views.push({ sessionId, shown: true });
        else if (isKept(pane.id, sessionId)) views.push({ sessionId, shown: false });
      }
      if (front !== null && !views.some((view) => view.sessionId === front)) {
        views.push({ sessionId: front, shown: true });
      }
      return views;
    },
    [isKept],
  );
}
