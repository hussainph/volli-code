import { beginPaneResize } from "@renderer/lib/pane-resize";
import * as React from "react";
import { GLASS_MOTION, springSamples } from "@renderer/lib/glass-motion";

const pushOwners = new WeakMap<HTMLElement, Map<string, { owner: object; stop(): void }>>();

export type PaneMode = "closed" | "peeking" | "pinned";
/** Both sides share semantic endpoints, transaction ownership and clocks.
 * One registered width value pushes both divider edges on every frame. Heavy
 * renderers defer their resize under a shared fence; live content never squashes. */
export function usePaneMotion({
  side,
  enabled = true,
  mode,
  instant,
  panelRef,
  contentElement,
  geometryKey,
}: {
  mode: PaneMode;
  side: "left" | "right";
  enabled?: boolean;
  instant: boolean;
  panelRef: React.RefObject<HTMLDivElement | null>;
  contentElement?: HTMLElement | null;
  geometryKey?: number;
}) {
  const pinned = mode === "pinned";
  const contentRef = React.useRef<HTMLElement | null>(null);
  if (contentElement !== undefined) contentRef.current = contentElement;
  const layoutPinned = pinned;
  const [moving, setMoving] = React.useState(false);
  const driver = React.useRef<{
    element: HTMLElement;
    property: string;
    animation: Animation;
    from: number;
    to: number;
    started: number;
  } | null>(null);
  const releaseResize = React.useRef<(() => void) | null>(null);
  const resizeOwner = React.useRef({});
  const previousMode = React.useRef(mode);
  const initialized = React.useRef(false);
  const lastElement = React.useRef<HTMLElement | null>(null);
  const stopPush = React.useCallback(() => {
    const record = driver.current;
    driver.current = null;
    if (record) {
      record.element.style.setProperty(record.property, `${record.to}px`);
      record.animation.cancel();
      record.element.removeAttribute(`data-${side}-pane-push-active`);
    }
    releaseResize.current?.();
    releaseResize.current = null;
    setMoving(false);
  }, [side]);
  // A portal can mount the panel only after its paper/host ref arrives.
  // contentElement therefore participates in the first real push commit even
  // when pin state and width did not change: pinned glass must reserve paper.
  React.useLayoutEffect(() => {
    const panel = panelRef.current;
    const element = panel?.closest<HTMLElement>("[data-volli-shell]") ?? panel?.parentElement;
    if (!panel || !element) return;
    lastElement.current = element;
    const owners = pushOwners.get(element) ?? new Map();
    if (!enabled) {
      if (owners.get(side)?.owner === resizeOwner.current) {
        stopPush();
        owners.delete(side);
      }
      initialized.current = false;
      return;
    }
    if (owners.get(side)?.owner !== resizeOwner.current) {
      owners.get(side)?.stop();
      owners.set(side, { owner: resizeOwner.current, stop: stopPush });
      pushOwners.set(element, owners);
      initialized.current = false;
    }
    const property = side === "left" ? "--left-pane-push" : "--right-pane-push";
    const width =
      panel.offsetWidth || Number.parseFloat(getComputedStyle(panel).width) || geometryKey || 0;
    const target = pinned ? width : 0;
    const direction = side === "left" ? 1 : -1;
    const resetMap = () => {
      panel.style.setProperty("--pane-push-factor", String(direction));
      panel.style.setProperty("--pane-push-offset", `${-direction * width}px`);
    };
    panel.style.setProperty("--pane-full-width", `${width}px`);
    if (!initialized.current) {
      initialized.current = true;
      resetMap();
      element.style.setProperty(property, `${target}px`);
      element.toggleAttribute(`data-${side}-pane-push-active`, pinned);
      return;
    }
    const old = driver.current;
    const from = Number.parseFloat(getComputedStyle(element).getPropertyValue(property)) || 0;
    let paneFrom = direction * (from - width);
    if (previousMode.current === "peeking" || old) {
      // A peek is already on screen. Sample its own presentation before taking
      // the transition owner, including a reversal of that peek-to-pin push.
      const parent = panel.offsetParent;
      if (parent instanceof HTMLElement) {
        const box = panel.getBoundingClientRect();
        const zoom = box.width / panel.offsetWidth || 1;
        paneFrom = (box.left - parent.getBoundingClientRect().left) / zoom - panel.offsetLeft;
      } else if (previousMode.current === "peeking") paneFrom = 0;
    }
    // A completed push must not hand its offscreen endpoint to the 12px peek
    // transition: that would slide the withdrawn pane back over paper while
    // fading out. Retain this owner until an actual peek takes over.
    if (mode === "peeking") panel.removeAttribute("data-pane-pin-motion");
    else if (pinned || previousMode.current === "pinned")
      panel.setAttribute("data-pane-pin-motion", "");
    if (
      instant ||
      panel.hasAttribute("data-keyboard-dismiss") ||
      width <= 0 ||
      typeof element.animate !== "function"
    ) {
      resetMap();
      stopPush();
      element.style.setProperty(property, `${target}px`);
      element.toggleAttribute(`data-${side}-pane-push-active`, pinned);
      return;
    }
    if (Math.abs(from - target) < 0.5) {
      resetMap();
      stopPush();
      element.style.setProperty(property, `${target}px`);
      element.toggleAttribute(`data-${side}-pane-push-active`, pinned);
      return;
    }
    if (old?.to === target) return;
    // Both use the same spring value. Usually this is a 1:1 divider; pinning
    // an existing overlay instead keeps the pane in place while paper reserves
    // its width. A reversal maps from that live presentation, never a teleport
    // back to the closed entrance. These coefficients are fixed per journey.
    const paneTo = pinned ? 0 : -direction * width;
    const factor = (paneTo - paneFrom) / (target - from);
    panel.style.setProperty("--pane-push-factor", String(factor));
    panel.style.setProperty("--pane-push-offset", `${paneFrom - from * factor}px`);
    const omega = (2 * Math.PI) / 0.2;
    const elapsed = old
      ? (Math.min(1, (performance.now() - old.started) / GLASS_MOTION.pin) * 8.5) / omega
      : 0;
    const velocity = old
      ? (old.to - old.from) * omega * omega * elapsed * Math.exp(-omega * elapsed)
      : 0;
    // Preserve the presentation and the fence while retargeting; no settled
    // resize notification is emitted between two halves of a reversal.
    element.style.setProperty(property, `${from}px`);
    driver.current = null;
    old?.animation.cancel();
    if (!releaseResize.current) releaseResize.current = beginPaneResize(resizeOwner.current);
    element.setAttribute(`data-${side}-pane-push-active`, "");
    setMoving(true);
    const frames = springSamples("pin").map((progress, index) => {
      const time = ((index / 64) * 8.5) / omega;
      const value =
        index === 64
          ? target
          : Math.max(
              0,
              Math.min(
                width,
                from + (target - from) * progress + velocity * time * Math.exp(-omega * time),
              ),
            );
      return { offset: index / 64, [property]: `${value}px` };
    });
    const animation = element.animate(frames, {
      duration: GLASS_MOTION.pin,
      easing: GLASS_MOTION.linear,
      fill: "both",
    });
    driver.current = { element, property, animation, from, to: target, started: performance.now() };
    animation.onfinish = () => {
      if (driver.current?.animation !== animation) return;
      stopPush();
      element.toggleAttribute(`data-${side}-pane-push-active`, pinned);
    };
  }, [side, enabled, mode, pinned, instant, geometryKey, panelRef, contentElement, stopPush]);

  React.useLayoutEffect(() => {
    previousMode.current = mode;
  }, [mode]);

  React.useEffect(() => {
    const settle = () => {
      stopPush();
    };
    window.addEventListener("resize", settle);
    return () => window.removeEventListener("resize", settle);
  }, [pinned, stopPush]);
  React.useEffect(
    () => () => {
      const active = driver.current;
      driver.current = null;
      active?.animation.cancel();
      releaseResize.current?.();
      releaseResize.current = null;
      const element = lastElement.current;
      const owners = element ? pushOwners.get(element) : undefined;
      if (owners?.get(side)?.owner === resizeOwner.current) owners.delete(side);
    },
    [side],
  );
  // The resident pane is the one animated glass surface. A second empty glass
  // shell would blur its live content and expose an opaque base pose on cancel.
  return { contentRef, layoutPinned, moving };
}
