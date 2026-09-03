import * as React from "react";
import { errorMessage } from "@volli/shared";

import { isBrowserStartUrl } from "../../../../browser-start-page";
import type {
  BrowserTabCaptureFrame,
  BrowserTabResult,
  BrowserTabState,
  Result,
} from "../../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { BrowserChrome } from "@renderer/components/browser/browser-chrome";
import { BrowserPlaneController } from "@renderer/components/browser/browser-plane";
import {
  hasNativePlaneOverlay,
  planeVisibility,
  shouldRefreshPlanePixels,
} from "@renderer/components/browser/browser-plane-freeze";
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

/**
 * Native child views always composite above renderer portals, so the pane has
 * to know when app chrome needs the tier. The rule itself lives in
 * `browser-plane-freeze.ts`; this hook is only the subscription to it.
 */
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
 * The live remote page stays in that sandboxed native view. The only page body
 * data this tree receives is an inert PNG captured for the brief interval when
 * an app overlay must replace the always-on-top native plane.
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
  const controllerRef = React.useRef<BrowserPlaneController | null>(null);
  const previousUrlRef = React.useRef(addressOf(tab.url));
  const [address, setAddress] = React.useState(() => addressOf(tab.url));
  const [error, setError] = React.useState<string | null>(null);
  const [frames, setFrames] = React.useState<readonly BrowserTabCaptureFrame[]>([]);
  const overlayActive = useRendererOverlayActive();
  // Synchronous. The stand-in pixels were captured before this moment, so
  // yielding the tier costs nothing and the swap has no visible seam.
  const planeVisible = planeVisibility({ visible, overlayActive });

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

  // Keep a recent photograph of the plane in hand, so an overlay never has to
  // wait for one. It rides on the gestures that PRECEDE an overlay — a press
  // or a key — which is why the pixels are always already there when a menu
  // mounts a frame or two later.
  //
  // No toast on failure. Nobody asked for this capture, no person is waiting
  // on it, and the previous frames stay usable — the exception AGENTS.md
  // documents. A toast is also itself an overlay, so failing loudly here would
  // yield the plane for the life of the toast.
  const capturedAtRef = React.useRef<number | null>(null);
  const inFlightRef = React.useRef(false);
  const overlayActiveRef = React.useRef(overlayActive);
  overlayActiveRef.current = overlayActive;

  const refreshPlanePixels = React.useCallback(() => {
    const last = capturedAtRef.current;
    const ready = shouldRefreshPlanePixels({
      visible,
      overlayActive: overlayActiveRef.current,
      captureInFlight: inFlightRef.current,
      sinceLastMs: last === null ? null : Date.now() - last,
    });
    if (!ready) return;
    inFlightRef.current = true;
    void api
      .capture({ tabId: tab.tabId })
      .then((result) => {
        inFlightRef.current = false;
        if (!result.ok) return;
        capturedAtRef.current = Date.now();
        setFrames(result.frames);
      })
      .catch(() => {
        inFlightRef.current = false;
      });
  }, [api, tab.tabId, visible]);

  React.useEffect(() => {
    if (!visible) {
      setFrames([]);
      capturedAtRef.current = null;
      return;
    }
    refreshPlanePixels();
    // Capture phase: these must land before the handler that opens the overlay.
    const prime = (): void => refreshPlanePixels();
    document.addEventListener("pointerdown", prime, true);
    document.addEventListener("keydown", prime, true);
    return () => {
      document.removeEventListener("pointerdown", prime, true);
      document.removeEventListener("keydown", prime, true);
    };
  }, [refreshPlanePixels, visible]);

  // A navigation replaces what the plane shows, so the held pixels are wrong.
  React.useEffect(() => {
    capturedAtRef.current = null;
    refreshPlanePixels();
  }, [refreshPlanePixels, tab.generation]);

  React.useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    const controller = new BrowserPlaneController(tab.tabId, api, (message) => {
      setError(message);
      toastError(message);
    });
    controllerRef.current = controller;
    const measure = () => controller.reportBounds(anchor.getBoundingClientRect());
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [api, tab.tabId]);

  // Deliberately re-runs when the controller is replaced as well as when the
  // decision changes: `api`/`tab.tabId` are the identity of the controller the
  // effect above installs, and a fresh controller starts at "unknown"
  // visibility. `setVisible` is idempotent, so the extra passes are free.
  React.useLayoutEffect(() => {
    void controllerRef.current?.setVisible(planeVisible);
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
      <div
        ref={anchorRef}
        data-browser-plane={tab.tabId}
        className="relative min-h-0 flex-1 overflow-hidden bg-background"
      >
        {frames.map((frame) => (
          <img
            key={frame.kind}
            aria-hidden
            alt=""
            src={frame.dataUrl}
            draggable={false}
            data-browser-plane-snapshot={frame.kind}
            className="pointer-events-none absolute max-w-none select-none"
            style={{
              left: frame.bounds.x,
              top: frame.bounds.y,
              width: frame.bounds.width,
              height: frame.bounds.height,
            }}
          />
        ))}
      </div>
    </div>
  );
}
