import * as React from "react";

import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { BrowserPane } from "@renderer/components/browser/browser-pane";
import {
  browserViewportSnapshot,
  registerBrowserViewport,
  subscribeBrowserViewports,
  type BrowserViewport,
} from "@renderer/components/browser/browser-viewport-registry";
import { TerminalViewportBox } from "@renderer/components/sessions/terminal-viewport-box";
import { paneIdForElement } from "@renderer/components/split/split-view-grid";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useProjectUiStore } from "@renderer/stores/project-ui";

/**
 * The surface owns only a placeholder, never BrowserPane's lifetime. `visible`
 * must include both the selected tab and its area's navigation visibility:
 * retained background panes must not publish over a hidden Home/Ticket surface.
 */
export function BrowserPaneAnchor({
  tabId,
  visible,
  onClose,
}: {
  tabId: string;
  visible: boolean;
  onClose(): void;
}) {
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  React.useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!visible || anchor === null) return;
    return registerBrowserViewport(tabId, { anchor, close: () => closeRef.current() });
  }, [tabId, visible]);

  return <div ref={anchorRef} data-slot="browser-pane-anchor" className="absolute inset-0" />;
}

/**
 * Mount once beside HomeSurface's switching content, not inside either area.
 * All projects' strip tabs remain keyed by opaque tab id here, preserving native
 * page controllers and unfinished address edits across navigation and pairing.
 * Only a published visible anchor lends a resident pane an on-screen rectangle.
 */
export function ResidentBrowserPanes({ api }: { api: BrowserApi }) {
  const byId = useBrowserTabsStore((state) => state.byId);
  const receive = useBrowserTabsStore((state) => state.receive);
  const viewports = React.useSyncExternalStore(subscribeBrowserViewports, browserViewportSnapshot);
  const [positionedViewports, setPositionedViewports] = React.useState<
    ReadonlyMap<string, BrowserViewport>
  >(() => new Map());
  React.useLayoutEffect(() => {
    // Child viewport boxes have now positioned themselves. A same-size anchor
    // handoff can change only x/y, which ResizeObserver does not report. Reuse
    // BrowserPane's existing resize measurement path before allowing show to
    // flush those fresh bounds; neither its controller nor chrome remounts.
    window.dispatchEvent(new Event("resize"));
    setPositionedViewports(viewports);
  }, [viewports]);

  return (
    <>
      {Object.values(byId)
        .filter((tab) => tab.presentation === "tab")
        .map((tab) => {
          const viewport = viewports.get(tab.tabId);
          const anchor = viewport?.anchor ?? null;
          // Native page clicks bypass renderer pointer capture. Replayed chords
          // must start in the pane currently lending this resident its bounds.
          const focusPane = () => {
            const paneId = paneIdForElement(anchor);
            if (paneId === null) return;
            const workspace = useProjectUiStore.getState();
            if (tab.ticketId === null) workspace.focusHomePane(tab.projectId, paneId);
            else workspace.focusTicketPane(tab.projectId, tab.ticketId, paneId);
          };
          return (
            <TerminalViewportBox key={tab.tabId} anchor={anchor} onPointerDownCapture={focusPane}>
              <div className="flex h-full min-h-0 flex-col">
                <BrowserPane
                  tab={tab}
                  visible={anchor !== null && positionedViewports.get(tab.tabId) === viewport}
                  api={api}
                  onTabState={receive}
                  onClose={viewport?.close}
                  onFocusPane={focusPane}
                />
              </div>
            </TerminalViewportBox>
          );
        })}
    </>
  );
}
