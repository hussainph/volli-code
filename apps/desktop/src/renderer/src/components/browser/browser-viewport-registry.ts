/**
 * Visible browser placeholders, independent of the lifetime of their resident
 * panes. Snapshots change only when an anchor is added, replaced or removed;
 * TerminalViewportBox follows rectangle changes directly through the DOM.
 */
let viewports: ReadonlyMap<string, HTMLElement> = new Map();
const listeners = new Set<() => void>();

function commit(next: ReadonlyMap<string, HTMLElement>): void {
  viewports = next;
  for (const listener of listeners) listener();
}

/** Publish an anchor and return its ownership-checked cleanup. */
export function registerBrowserViewport(tabId: string, anchor: HTMLElement): () => void {
  if (viewports.get(tabId) !== anchor) commit(new Map(viewports).set(tabId, anchor));
  return () => {
    // A replacement may publish before its predecessor finishes unmounting.
    // That predecessor must not clear the new surface's anchor.
    if (viewports.get(tabId) !== anchor) return;
    const next = new Map(viewports);
    next.delete(tabId);
    commit(next);
  };
}

export function subscribeBrowserViewports(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function browserViewportSnapshot(): ReadonlyMap<string, HTMLElement> {
  return viewports;
}
