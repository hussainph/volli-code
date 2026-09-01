import * as React from "react";
import { errorMessage } from "@volli/shared";

import { isBrowserStartUrl } from "../../../../browser-start-page";
import type { BrowserTabResult, BrowserTabState, Result } from "../../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { BrowserChrome } from "@renderer/components/browser/browser-chrome";
import { BrowserPlaneController } from "@renderer/components/browser/browser-plane";
import { toastError } from "@renderer/lib/toast";

/**
 * What the address bar shows for a tab's current URL.
 *
 * A blank tab's URL is real policy but not a destination anyone typed, so it is
 * never the field's text — the field stays empty and the placeholder does the
 * talking. Otherwise the first thing a new tab would ask you to do is delete
 * the text it came with.
 */
function addressOf(url: string): string {
  return isBrowserStartUrl(url) ? "" : url;
}

const NATIVE_PLANE_OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-sonner-toast], [data-native-plane-overlay]';

/** Whether renderer chrome currently needs to paint above every native child view. */
export function hasNativePlaneOverlay(root: ParentNode): boolean {
  return root.querySelector(NATIVE_PLANE_OVERLAY_SELECTOR) !== null;
}

/** Native child views always composite above renderer portals, so overlays hide the plane. */
function useRendererOverlayActive(): boolean {
  const [active, setActive] = React.useState(false);
  React.useEffect(() => {
    const read = (): void => setActive(hasNativePlaneOverlay(document));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return active;
}

/**
 * Renderer chrome plus the measured hole occupied by main's WebContentsView.
 * Remote page bytes never enter this tree; the native view is attached over the
 * plane rectangle and only bounded chrome state crosses the preload bridge.
 */
export function BrowserPane({
  tab,
  visible,
  api,
  onTabState,
}: {
  tab: BrowserTabState;
  visible: boolean;
  api: BrowserApi;
  onTabState(tab: BrowserTabState): void;
}) {
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const addressRef = React.useRef<HTMLInputElement>(null);
  const previousUrlRef = React.useRef(addressOf(tab.url));
  const [address, setAddress] = React.useState(() => addressOf(tab.url));
  const [error, setError] = React.useState<string | null>(null);
  const rendererOverlayActive = useRendererOverlayActive();
  const planeVisible = visible && !rendererOverlayActive;

  // A state push should move an untouched address bar but must not erase an
  // address the person is midway through typing because a title/loading push
  // arrived from the page in the meantime.
  React.useEffect(() => {
    const next = addressOf(tab.url);
    const previousUrl = previousUrlRef.current;
    previousUrlRef.current = next;
    setAddress((current) => (current === previousUrl ? next : current));
  }, [tab.url]);

  // A tab that has been sent nowhere yet is a question, so the caret starts in
  // the address bar — the bargain ⌘T makes in every other browser.
  //
  // Through a frame rather than on mount because this pane is usually mounted
  // by a menu, and the caret is only ours once that menu has finished tearing
  // down. The menu gives it up deliberately (`new-session-control.tsx` declines
  // to restore focus after its Browser row); this frame is what lets the
  // handover land rather than a delay long enough to win a race.
  const blank = visible && isBrowserStartUrl(tab.url);
  React.useEffect(() => {
    if (!blank) return;
    const frame = window.requestAnimationFrame(() => {
      addressRef.current?.focus();
      addressRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [blank, tab.tabId]);

  React.useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    const controller = new BrowserPlaneController(tab.tabId, api, (message) => {
      setError(message);
      toastError(message);
    });
    const measure = () => controller.reportBounds(anchor.getBoundingClientRect());
    measure();
    controller.setVisible(planeVisible);
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      controller.dispose();
    };
  }, [api, planeVisible, tab.tabId]);

  const runTabCommand = React.useCallback(
    async (operation: Promise<BrowserTabResult>, label: string) => {
      try {
        const result = await operation;
        if (!result.ok) {
          const message = `Could not ${label}: ${result.error}`;
          setError(message);
          toastError(message);
          return;
        }
        setError(null);
        onTabState(result.tab);
      } catch (reason) {
        const message = `Could not ${label}: ${errorMessage(reason)}`;
        setError(message);
        toastError(message);
      }
    },
    [onTabState],
  );

  const runCommand = React.useCallback(async (operation: Promise<Result>, label: string) => {
    try {
      const result = await operation;
      if (!result.ok) {
        const message = `Could not ${label}: ${result.error}`;
        setError(message);
        toastError(message);
        return;
      }
      setError(null);
    } catch (reason) {
      const message = `Could not ${label}: ${errorMessage(reason)}`;
      setError(message);
      toastError(message);
    }
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <BrowserChrome
        tab={tab}
        address={address}
        addressRef={addressRef}
        error={error ?? tab.error}
        onAddressChange={setAddress}
        onNavigate={(url) => {
          void runTabCommand(api.navigate({ tabId: tab.tabId, url }), "navigate Browser Tab");
        }}
        onBack={() => void runTabCommand(api.back({ tabId: tab.tabId }), "go back")}
        onForward={() => void runTabCommand(api.forward({ tabId: tab.tabId }), "go forward")}
        onReload={() => void runTabCommand(api.reload({ tabId: tab.tabId }), "reload Browser Tab")}
        onToggleDevTools={() =>
          void runCommand(api.toggleDevTools({ tabId: tab.tabId }), "toggle DevTools")
        }
      />
      <div ref={anchorRef} data-browser-plane={tab.tabId} className="relative min-h-0 flex-1" />
    </div>
  );
}
