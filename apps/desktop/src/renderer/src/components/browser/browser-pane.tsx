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
import { registerBrowserPaneCommands } from "@renderer/components/browser/browser-app-shortcuts";
import { BrowserChrome } from "@renderer/components/browser/browser-chrome";
import { BrowserPlaneController } from "@renderer/components/browser/browser-plane";
import {
  hasNativePlaneOverlay,
  nativePlaneOverlayCandidates,
  planeVisibility,
  shouldPaintPlanePixels,
  PLANE_CAPTURE_DEADLINE_MS,
  PLANE_OVERLAY_RELEASE_MS,
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

// RAF timestamps are shared by every pane in a frame. Reuse the DOM/style
// scan, but never the plane-specific geometry. Mutations invalidate it below.
let overlayScan: { time: number; elements: Element[] } | undefined;
function overlayCandidatesAtFrame(time: number): Element[] {
  if (overlayScan?.time !== time) {
    overlayScan = { time, elements: nativePlaneOverlayCandidates(document) };
  }
  return overlayScan.elements;
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
function useRendererOverlayActive(
  anchorRef: React.RefObject<HTMLDivElement | null>,
  visible: boolean,
): boolean {
  const [active, setActive] = React.useState(false);
  React.useEffect(() => {
    const anchor = anchorRef.current;
    if (!visible || anchor === null) {
      setActive(false);
      return;
    }
    let queued = 0;
    let release = 0;
    let holding = false;
    const motions = new Map<Element, Set<string>>();
    const read = (candidates?: Element[]): void => {
      if (hasNativePlaneOverlay(document, anchor, candidates)) {
        window.clearTimeout(release);
        release = 0;
        holding = true;
        setActive(true);
      } else if (holding && release === 0) {
        // Entry already has the surface's own hover delay. Delay only release:
        // a second hover reuses the still, rather than show/capture/hide again.
        release = window.setTimeout(() => {
          release = 0;
          // A new hover can mount just before this deadline with its coalesced
          // read still queued. Never restore over it for that intervening frame.
          if (hasNativePlaneOverlay(document, anchor)) return;
          holding = false;
          setActive(false);
        }, PLANE_OVERLAY_RELEASE_MS);
      }
    };
    const queue = (): void => {
      if (queued !== 0) return;
      queued = window.requestAnimationFrame((time) => {
        queued = 0;
        read(overlayCandidatesAtFrame(time));
        for (const element of motions.keys()) {
          if (!element.isConnected) motions.delete(element);
        }
        if (motions.size > 0) queue();
      });
    };
    const schedule = (): void => {
      overlayScan = undefined;
      queue();
    };
    const motion = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const transition = event.type.startsWith("transition");
      const key = transition
        ? `transition:${(event as TransitionEvent).propertyName}`
        : `animation:${(event as AnimationEvent).animationName}`;
      if (event.type.endsWith("end") || event.type.endsWith("cancel")) {
        const running = motions.get(target);
        running?.delete(key);
        if (running?.size === 0) motions.delete(target);
        schedule();
        return;
      }
      // A compositor-only translate writes no DOM attributes or layout sizes.
      // Follow relevant entry/exit motion until it ends, including when its
      // first rectangle is outside the plane. Unrelated transcript animations
      // and perpetual spinners must not create a document-wide frame loop.
      if (!transition && getComputedStyle(target).animationIterationCount === "infinite") return;
      if (
        !nativePlaneOverlayCandidates(document).some(
          (element) => element.contains(target) || target.contains(element),
        )
      )
        return;
      const running = motions.get(target) ?? new Set<string>();
      running.add(key);
      motions.set(target, running);
      schedule();
    };
    const motionEvents = [
      "transitionrun",
      "transitionstart",
      "transitionend",
      "transitioncancel",
      "animationstart",
      "animationend",
      "animationcancel",
    ];
    read();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(anchor);
    resize.observe(document.body);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    for (const event of motionEvents) document.addEventListener(event, motion, true);
    return () => {
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      for (const event of motionEvents) document.removeEventListener(event, motion, true);
      window.clearTimeout(release);
      if (queued !== 0) window.cancelAnimationFrame(queued);
    };
  }, [anchorRef, visible]);
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
  onClose,
}: {
  tab: BrowserTabState;
  visible: boolean;
  api: BrowserApi;
  onTabState(tab: BrowserTabState): void;
  /**
   * Closes this tab the way its surface's close control does — what ⌘W pressed
   * inside the page runs (VC-301). Absent, ⌘W in the page does nothing.
   */
  onClose?: () => void;
}) {
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const addressRef = React.useRef<HTMLInputElement>(null);
  const controllerRef = React.useRef<BrowserPlaneController | null>(null);
  const previousUrlRef = React.useRef(addressOf(tab.url));
  const [address, setAddress] = React.useState(() => addressOf(tab.url));
  const [error, setError] = React.useState<string | null>(null);
  const [frames, setFrames] = React.useState<readonly BrowserTabCaptureFrame[]>([]);
  const [captureSettled, setCaptureSettled] = React.useState(false);
  const overlayActive = useRendererOverlayActive(anchorRef, visible);
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

  // ⌘W and ⌘L pressed inside THIS page come back from main named by tab
  // (VC-301), so the pane drawing the tab is the one that answers — never the
  // split view's focused pane. Only while shown: a hidden plane holds no focus
  // to press them from. The close is read through a ref so a surface's fresh
  // callback each render does not re-register.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => {
    if (!visible) return;
    return registerBrowserPaneCommands(tab.tabId, {
      close: () => onCloseRef.current?.(),
      focusAddress: () => {
        addressRef.current?.focus();
        addressRef.current?.select();
      },
    });
  }, [tab.tabId, visible]);

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
      // After the overlay subscription's close grace, the plane takes the
      // tier back. Old frames stay painted until it has actually reattached.
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
    const controller = new BrowserPlaneController(
      tab.tabId,
      api,
      (message) => {
        setError(message);
        toastError(message);
      },
      {
        request: (callback) => window.requestAnimationFrame(callback),
        cancel: (handle) => window.cancelAnimationFrame(handle),
      },
    );
    controllerRef.current = controller;
    // The controller invokes this lazy read only for the latest observation in
    // a frame, avoiding a synchronous layout read for notifications it drops.
    const readBounds = () => anchor.getBoundingClientRect();
    const measure = () => controller.reportBounds(readBounds);
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
        // The person's hold controls (VC-239). Explicit presses, never
        // inferred from input into the page; the holding Session is told by
        // main, so nothing here has to reach it.
        holder={tab.heldBy}
        onTakeOver={() => void runTabCommand(api.takeOver({ tabId: tab.tabId }), "take over")}
        onAskToLeave={() =>
          void runCommand(api.askToLeave({ tabId: tab.tabId }), "ask the Session to leave")
        }
        onHandBack={() => void runTabCommand(api.handBack({ tabId: tab.tabId }), "hand back")}
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
