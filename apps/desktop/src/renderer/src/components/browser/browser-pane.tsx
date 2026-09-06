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
  shouldPaintPlanePixels,
  PLANE_CAPTURE_DEADLINE_MS,
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
 *
 * Coalesced to one read per frame. The observer watches the whole document for
 * attribute and child changes, and an overlay's own entry animation produces a
 * burst of them — answering each one with a document-wide query is work done
 * exactly when the app is busiest.
 */
function useRendererOverlayActive(): boolean {
  const [active, setActive] = React.useState(false);
  React.useEffect(() => {
    let queued = 0;
    const read = (): void => setActive(hasNativePlaneOverlay(document));
    const schedule = (): void => {
      if (queued !== 0) return;
      queued = window.requestAnimationFrame(() => {
        queued = 0;
        read();
      });
    };
    read();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (queued !== 0) window.cancelAnimationFrame(queued);
    };
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
  const [captureSettled, setCaptureSettled] = React.useState(false);
  const overlayActive = useRendererOverlayActive();
  const planeVisible = planeVisibility({ visible, overlayActive, captureSettled });
  const paintPixels = shouldPaintPlanePixels({ visible, frameCount: frames.length });

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

  // Photograph the plane WHEN an overlay opens, so the stand-in is the frame
  // the person was actually looking at. Capturing ahead of time was cheaper but
  // dishonest: a pre-taken frame is stale by however long ago it was taken, and
  // a hover-opened overlay never even had a gesture to ride on.
  //
  // No toast on failure. Nobody asked for this capture, no person is waiting on
  // it, and the previous frames stay usable — the exception AGENTS.md
  // documents. A toast is also itself an overlay, so failing loudly here would
  // yield the plane for the life of the toast.
  React.useEffect(() => {
    if (!visible) {
      setFrames([]);
      setCaptureSettled(false);
      return;
    }
    if (!overlayActive) {
      // The plane takes the tier back at once. The old frames stay painted
      // underneath until it has actually reattached.
      setCaptureSettled(false);
      return;
    }

    let live = true;
    const settle = (): void => {
      if (live) setCaptureSettled(true);
    };
    // Only so a pathological page cannot hide a menu. Normally the pixels win.
    const deadline = window.setTimeout(settle, PLANE_CAPTURE_DEADLINE_MS);
    void api
      .capture({ tabId: tab.tabId })
      .then((result) => {
        if (!live) return;
        if (result.ok) setFrames(result.frames);
        settle();
      })
      .catch(settle);

    return () => {
      live = false;
      window.clearTimeout(deadline);
    };
  }, [api, overlayActive, tab.tabId, visible]);

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
        {(paintPixels ? frames : []).map((frame) => (
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
