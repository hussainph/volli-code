/**
 * Where a rail navigator's view state lives while its page is not mounted
 * (VC-406, the audit's low-priority finding against `home-rail.tsx:150-177`,
 * `home-files-panel.tsx:85-91`, `ticket-rail.tsx:237-239` and
 * `search-panel.tsx:84-91`).
 *
 * THE DEFECT. The rail draws one page at a time and mounts only that one, so
 * switching from Files to Now and back unmounted the navigator and took its
 * folder, its filter toggle and its query with it. Walk three folders deep,
 * glance at Now, come back to the repository root. The same switch threw away
 * a typed search query, which is worse: the query was the work.
 *
 * WHY NOT `useState` HIGHER UP, and why not the UI store. Higher up is
 * `ticket-rail.tsx` / `home-rail.tsx`, which hand the navigators in as
 * `filesContent` props — a folder threaded through there would make the rail's
 * chrome know what a folder is, and the same prop would have to cross
 * `ticket-detail.tsx`. The UI store is DURABLE (it persists across launches),
 * and a folder the app silently reopened weeks later, possibly deleted since,
 * is not a promise this state can keep. What the audit asked for is narrower
 * than both: remember it *for this run of the app*, per scope, and forget it
 * when there are too many to be worth remembering.
 *
 * SO: a module-level map, deliberately ephemeral (a reload is a fresh app and a
 * fresh map) and deliberately BOUNDED. It holds plain data — no subscriptions,
 * no timers, no watchers — so a remembered folder cannot keep a directory watch
 * or a search request alive behind an unmounted page. Watchers still live and
 * die with the panel that opened them.
 *
 * THE KEY IS THE SCOPE, and the scope is what makes the memory truthful: a
 * ticket's worktree folder is meaningless in another ticket's worktree, and
 * Main's is meaningless in both. `navigatorScopeKey` is the only place that
 * pairing is spelled, so no page can accidentally read another checkout's
 * folder.
 */
import * as React from "react";

/** The page whose state is being remembered — one namespace per rail page. */
export type NavigatorScopeKind = "files" | "search" | "diffs";

/**
 * Which checkout a page was pointed at.
 *
 * `ticketId` absent is Home's Main checkout, exactly as it is in
 * `use-navigator-mutations.ts` and `search-model.ts`: one shape for both
 * scopes, so a surface cannot forget which one it is in.
 */
export interface NavigatorScope {
  readonly projectId: string;
  readonly ticketId?: string | undefined;
}

/**
 * The scope's cache key. Includes the page kind, because Files' folder and
 * Search's query are different answers about the same checkout and must not
 * share a slot.
 */
export function navigatorScopeKey(kind: NavigatorScopeKind, scope: NavigatorScope): string {
  return scope.ticketId === undefined
    ? `${kind}:${scope.projectId}`
    : `${kind}:${scope.projectId}/${scope.ticketId}`;
}

/**
 * How many scopes are worth remembering at once.
 *
 * A bound rather than a sweep: the entries are three short strings and a
 * boolean, so the cost of one is nothing and the cost of an UNBOUNDED map is a
 * slow leak across a long session that touches hundreds of tickets. Twenty-four
 * is roughly "every ticket a person opened today"; past that, the
 * least-recently-touched scope is the one they are least likely to return to.
 */
export const NAVIGATOR_SCOPE_LIMIT = 24;

/** What a navigator remembers about where it was. */
export interface NavigatorViewState {
  /** The project-relative folder being browsed, `""` at the root. */
  readonly cwd: string;
  /** Whether the filter field is open. */
  readonly filtering: boolean;
  /** What is in it. Kept beside `filtering` so reopening restores the words. */
  readonly query: string;
}

export const EMPTY_NAVIGATOR_VIEW: NavigatorViewState = { cwd: "", filtering: false, query: "" };

/**
 * The live map. `Map` preserves insertion order, which is what makes the
 * eviction below a real LRU: a read re-inserts, so the oldest key is always the
 * least recently touched.
 */
const remembered = new Map<string, NavigatorViewState>();

/** What `key` was last left at, or the root state if this scope is new. */
export function readNavigatorView(key: string): NavigatorViewState {
  const found = remembered.get(key);
  if (found === undefined) return EMPTY_NAVIGATOR_VIEW;
  // Touch: re-inserting moves it to the end, so it is no longer the eviction
  // candidate. Reading a scope is evidence the person is using it.
  remembered.delete(key);
  remembered.set(key, found);
  return found;
}

/**
 * Remembers `state` for `key`, evicting the least recently touched scope once
 * the map is over its bound.
 *
 * A state that is the resting one is FORGOTTEN rather than stored: a navigator
 * sitting at its root with no filter has nothing to restore, and keeping a slot
 * for it would spend the bound on scopes that would draw identically without it.
 */
export function writeNavigatorView(key: string, state: NavigatorViewState): void {
  remembered.delete(key);
  if (state.cwd === "" && !state.filtering && state.query === "") return;
  remembered.set(key, state);
  while (remembered.size > NAVIGATOR_SCOPE_LIMIT) {
    const oldest = remembered.keys().next();
    if (oldest.done === true) break;
    remembered.delete(oldest.value);
  }
}

/** How many scopes are currently remembered — the bound's own test hook. */
export function rememberedNavigatorScopeCount(): number {
  return remembered.size;
}

/**
 * Forgets everything. For tests, and for nothing else: the app has no event
 * that invalidates every scope at once, and a project or ticket that goes away
 * simply stops being asked about.
 */
export function clearRememberedNavigatorViews(): void {
  remembered.clear();
}

/**
 * One page's view state, restored on mount and written through on every change.
 *
 * WRITE-THROUGH rather than write-on-unmount, because unmount is exactly the
 * moment this has to survive and a cleanup that runs after a React error
 * boundary, a StrictMode double-invoke or a hot reload is not a guarantee. The
 * value is three fields; writing it twice costs nothing.
 *
 * A CHANGED KEY IS A DIFFERENT SCOPE, not a changed state: the ticket under the
 * panel was swapped, so the answer is whatever THAT scope was left at, resolved
 * during render (React's documented "adjust state when a prop changes" shape)
 * so the first paint is already the right folder rather than the previous
 * ticket's folder for one frame.
 */
export function useRememberedNavigatorView(
  key: string,
): [NavigatorViewState, (next: NavigatorViewState) => void] {
  const [entry, setEntry] = React.useState(() => ({ key, view: readNavigatorView(key) }));
  const view = entry.key === key ? entry.view : readNavigatorView(key);
  if (entry.key !== key) setEntry({ key, view });

  const set = React.useCallback(
    (next: NavigatorViewState) => {
      setEntry({ key, view: next });
      writeNavigatorView(key, next);
    },
    [key],
  );

  return [view, set];
}
