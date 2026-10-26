/**
 * Visible browser placeholders, independent of the lifetime of their resident
 * panes. Snapshots change only when an anchor is added, replaced or removed;
 * TerminalViewportBox follows rectangle changes directly through the DOM.
 */
export interface BrowserViewport {
  anchor: HTMLElement;
  /** The current surface's close path, also used by a native page's ⌘W. */
  close(): void;
}

let viewports: ReadonlyMap<string, BrowserViewport> = new Map();
const listeners = new Set<() => void>();

function commit(next: ReadonlyMap<string, BrowserViewport>): void {
  viewports = next;
  for (const listener of listeners) listener();
}

/** Publish an anchor and return its ownership-checked cleanup. */
export function registerBrowserViewport(tabId: string, viewport: BrowserViewport): () => void {
  if (viewports.get(tabId) !== viewport) commit(new Map(viewports).set(tabId, viewport));
  return () => {
    // A replacement may publish before its predecessor finishes unmounting.
    // That predecessor must not clear the new surface's anchor.
    if (viewports.get(tabId) !== viewport) return;
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

export function browserViewportSnapshot(): ReadonlyMap<string, BrowserViewport> {
  return viewports;
}
