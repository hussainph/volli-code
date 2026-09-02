/**
 * WHERE EACH LIVE TERMINAL IS DRAWN — one map, kept outside React (VC-202).
 *
 * A terminal's React tree is never mounted by the surface that shows it: every
 * live PTY in the app hangs off the always-mounted sessions layer, precisely so
 * that switching tab, ticket, project or nav cannot unmount one (CLAUDE.md).
 * What a surface owns instead is a BOX — a measured placeholder saying "draw
 * that terminal here" — and this module is the channel between the two.
 *
 * It began as a single `currentTarget` inside `ticket-terminal-host.tsx`, when
 * exactly one terminal could be on screen at a time. Split view makes that
 * false on both surfaces at once: one pane per terminal, several panes per
 * surface, and a ticket's grid and Home's may both be alive in the same frame.
 * So the one slot becomes a MAP keyed by terminal TAB id, and the hosts draw
 * one positioned box per published entry.
 *
 * OUTSIDE REACT for the reason the single slot was: an anchor republishes
 * whenever layout moves it, and a re-render of the host tree per layout tick
 * would re-render every terminal in the app. Subscribers here are only ever the
 * two hosts, and they re-render when the SET of boxes changes — not when one
 * moves, which the box syncs itself through the DOM.
 *
 * The snapshot is REPLACED, never mutated, so `useSyncExternalStore` can tell
 * frames apart by identity; a publish that changes nothing returns the same map
 * and notifies nobody.
 */

/** One terminal tab's on-screen box, as the pane that draws it published it. */
export interface TerminalViewport {
  /**
   * The sessions-store owner key this tab belongs to — a projectId for a Home
   * Session, a ticketId for a ticket's. Carried so a host draws only the tabs
   * it owns: the two hosts share this map, and neither may position a box over
   * an anchor the other surface put up.
   */
  readonly ownerId: string;
  /** The measured placeholder in the pane; the host rect-syncs its box onto it. */
  readonly anchor: HTMLElement;
}

const EMPTY: ReadonlyMap<string, TerminalViewport> = new Map();

let viewports: ReadonlyMap<string, TerminalViewport> = EMPTY;
const listeners = new Set<() => void>();

/**
 * Publish (or clear, with `null`) the box for one terminal tab.
 *
 * Called by {@link TerminalPaneAnchor} on mount and on unmount. A clear is
 * unconditional rather than ownership-checked, which is safe because React runs
 * every effect CLEANUP of a commit before any of that commit's effects: a tab
 * moving from one pane to another therefore always clears before it republishes,
 * and two anchors for one tab are never mounted at once.
 */
export function publishTerminalViewport(tabId: string, target: TerminalViewport | null): void {
  const current = viewports.get(tabId);
  if (target === null) {
    if (current === undefined) return;
    const next = new Map(viewports);
    next.delete(tabId);
    commit(next);
    return;
  }
  if (
    current !== undefined &&
    current.ownerId === target.ownerId &&
    current.anchor === target.anchor
  ) {
    return;
  }
  commit(new Map(viewports).set(tabId, target));
}

function commit(next: ReadonlyMap<string, TerminalViewport>): void {
  viewports = next;
  for (const listener of listeners) listener();
}

/** Subscribe to the SET of published boxes changing. */
export function subscribeTerminalViewports(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The published boxes, by terminal tab id. Stable between changes. */
export function terminalViewportSnapshot(): ReadonlyMap<string, TerminalViewport> {
  return viewports;
}

/**
 * Forget every published box.
 *
 * Not a product path — a surface unpublishes its own anchors as it unmounts —
 * but module state that outlives a test is state the next test inherits.
 */
export function resetTerminalViewports(): void {
  if (viewports === EMPTY) return;
  commit(EMPTY);
}
