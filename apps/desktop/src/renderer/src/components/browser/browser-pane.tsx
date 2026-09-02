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

interface RendererOverlayState {
  active: boolean;
  /** Distinguishes two openings so pixels from the first can never freeze the second. */
  epoch: number;
}

/**
 * Native child views always composite above renderer portals. Each overlay
 * opening gets an epoch so an asynchronous capture from an older opening can
 * never hide the live plane under a newer one.
 */
function useRendererOverlay(): RendererOverlayState {
  const [state, setState] = React.useState<RendererOverlayState>({ active: false, epoch: 0 });
  React.useEffect(() => {
    const read = (): void => {
      const active = hasNativePlaneOverlay(document);
      setState((current) => {
        if (active === current.active) return current;
        return { active, epoch: active ? current.epoch + 1 : current.epoch };
      });
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return state;
}

interface OverlaySnapshot {
  epoch: number;
  frames: BrowserTabCaptureFrame[];
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
  const [overlaySnapshot, setOverlaySnapshot] = React.useState<OverlaySnapshot | null>(null);
  const rendererOverlay = useRendererOverlay();
  const snapshotReady = rendererOverlay.active && overlaySnapshot?.epoch === rendererOverlay.epoch;
  // Capture first, then detach. The snapshot is already in this render when
  // the layout effect hides the native child, so no black frame is exposed.
  const planeVisible = visible && !snapshotReady;

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

  React.useEffect(() => {
    if (!rendererOverlay.active) {
      setOverlaySnapshot(null);
      return;
    }
    if (!visible) return;

    let current = true;
    const epoch = rendererOverlay.epoch;
    const fail = (detail: string): void => {
      if (!current) return;
      toastError(`Could not freeze Browser Tab for overlay: ${detail}`);
      // The overlay must remain operable even when capture fails. An empty
      // frame list falls back to the plane's themed renderer background.
      setOverlaySnapshot({ epoch, frames: [] });
    };
    void api
      .capture({ tabId: tab.tabId })
      .then((result) => {
        if (!current) return;
        if (!result.ok) {
          fail(result.error);
          return;
        }
        setOverlaySnapshot({ epoch, frames: result.frames });
      })
      .catch((reason: unknown) => fail(errorMessage(reason)));

    return () => {
      current = false;
    };
  }, [api, rendererOverlay.active, rendererOverlay.epoch, tab.tabId, visible]);

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

  React.useLayoutEffect(() => {
    controllerRef.current?.setVisible(planeVisible);
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
        {snapshotReady
          ? overlaySnapshot.frames.map((frame) => (
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
            ))
          : null}
      </div>
    </div>
  );
}
