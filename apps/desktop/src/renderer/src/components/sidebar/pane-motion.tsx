import { beginPaneResize } from "@renderer/lib/pane-resize";
import * as React from "react";
import { createPortal } from "react-dom";
import { GLASS_MOTION, springSamples } from "@renderer/lib/glass-motion";
import { GlassSurface } from "@renderer/components/ui/surface";
import { overlayLayer } from "@renderer/components/ui/overlay-layer";

const pushOwners = new WeakMap<HTMLElement, Map<string, { owner: object; stop(): void }>>();

export type PaneMode = "closed" | "peeking" | "pinned";
interface PourGeometry {
  box: DOMRect;
  target: DOMRect;
  opening: boolean;
  background: string;
  radius: string;
  generation: number;
  start?: { transform: string; opacity: number };
}

/** Both sides share semantic endpoints, transaction ownership and clocks.
 * One registered width value pushes both divider edges on every frame. Heavy
 * renderers defer their resize under a shared fence; live content never squashes. */
export function usePaneMotion({
  side,
  enabled = true,
  mode,
  instant,
  panelRef,
  triggerRef,
  bandRef,
  contentElement,
  geometryKey,
}: {
  mode: PaneMode;
  side: "left" | "right";
  enabled?: boolean;
  instant: boolean;
  panelRef: React.RefObject<HTMLDivElement | null>;
  triggerRef?: React.RefObject<HTMLElement | null>;
  bandRef?: React.RefObject<HTMLDivElement | null>;
  contentElement?: HTMLElement | null;
  geometryKey?: number;
}) {
  const pinned = mode === "pinned";
  const shown = mode !== "closed";
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
  const generation = React.useRef(0);
  const [pour, setPour] = React.useState<PourGeometry | null>(null);
  const shellAnimation = React.useRef<Animation | null>(null);
  const shellRef = React.useRef<HTMLDivElement | null>(null);
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
  const stopPour = React.useCallback(() => {
    shellAnimation.current?.cancel();
    shellAnimation.current = null;
    setPour(null);
  }, []);

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
    panel.style.setProperty("--pane-full-width", `${width}px`);
    if (!initialized.current) {
      initialized.current = true;
      element.style.setProperty(property, `${target}px`);
      element.toggleAttribute(`data-${side}-pane-push-active`, pinned);
      return;
    }
    const old = driver.current;
    const from = Number.parseFloat(getComputedStyle(element).getPropertyValue(property)) || 0;
    if (
      instant ||
      panel.hasAttribute("data-keyboard-dismiss") ||
      width <= 0 ||
      typeof element.animate !== "function"
    ) {
      stopPush();
      element.style.setProperty(property, `${target}px`);
      element.toggleAttribute(`data-${side}-pane-push-active`, pinned);
      return;
    }
    if (Math.abs(from - target) < 0.5) {
      stopPush();
      element.style.setProperty(property, `${target}px`);
      element.toggleAttribute(`data-${side}-pane-push-active`, pinned);
      return;
    }
    if (old?.to === target) return;
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
  }, [side, enabled, pinned, instant, geometryKey, panelRef, stopPush]);

  React.useLayoutEffect(() => {
    const previous = previousMode.current;
    previousMode.current = mode;
    if (instant) {
      stopPour();
      return;
    }
    if (previous === mode || previous === "peeking" || mode === "peeking") return;
    // Pinning an existing peek must not re-enter an already visible pane.
    if (previous !== "closed" && shown) return;
    const panel = panelRef.current;
    const trigger =
      triggerRef?.current ??
      bandRef?.current?.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');
    if (!panel || !trigger || panel.hasAttribute("data-keyboard-dismiss")) {
      stopPour();
      return;
    }
    const material = panel.querySelector<HTMLElement>(".glass") ?? panel;
    const box = material.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const currentShell = shellRef.current;
    const currentBox = currentShell?.getBoundingClientRect();
    const start =
      currentBox && currentBox.width > 0
        ? {
            transform: `translate3d(${currentBox.left - box.left}px, ${currentBox.top - box.top}px, 0px) scale(${currentBox.width / box.width}, ${currentBox.height / box.height})`,
            opacity: Number(getComputedStyle(currentShell!).opacity),
          }
        : undefined;
    stopPour();
    const style = getComputedStyle(material);
    setPour({
      start,
      box,
      target: trigger.getBoundingClientRect(),
      opening: shown,
      background: style.background,
      radius: style.borderRadius,
      generation: ++generation.current,
    });
  }, [mode, shown, instant, panelRef, triggerRef, bandRef, stopPour]);

  const bindShell = React.useCallback(
    (node: HTMLDivElement | null) => {
      shellRef.current = node;
      if (!node || !pour || typeof node.animate !== "function") return;
      const { box, target, opening } = pour;
      const folded = `translate3d(${target.left - box.left}px, ${target.top - box.top}px, 0px) scale(${target.width / box.width}, ${target.height / box.height})`;
      const whole = "translate3d(0px, 0px, 0px) scale(1, 1)";
      node.style.willChange = "transform, opacity";
      const animation = node.animate(
        opening
          ? [pour.start ?? { transform: folded, opacity: 1 }, { transform: whole, opacity: 0 }]
          : [pour.start ?? { transform: whole, opacity: 1 }, { transform: folded, opacity: 0 }],
        {
          duration: opening ? GLASS_MOTION.sheet : GLASS_MOTION.menuOut,
          easing: GLASS_MOTION.easeOutCss,
          fill: "both",
        },
      );
      shellAnimation.current = animation;
      animation.onfinish = () => {
        if (shellAnimation.current === animation) stopPour();
      };
      return () => {
        animation.cancel();
        node.style.removeProperty("will-change");
        if (shellRef.current === node) shellRef.current = null;
      };
    },
    [pour, stopPour],
  );

  React.useEffect(() => {
    const settle = () => {
      ++generation.current;
      stopPush();
      stopPour();
    };
    window.addEventListener("resize", settle);
    return () => window.removeEventListener("resize", settle);
  }, [pinned, stopPush, stopPour]);
  React.useEffect(
    () => () => {
      ++generation.current;
      const active = driver.current;
      driver.current = null;
      active?.animation.cancel();
      releaseResize.current?.();
      releaseResize.current = null;
      const element = lastElement.current;
      const owners = element ? pushOwners.get(element) : undefined;
      if (owners?.get(side)?.owner === resizeOwner.current) owners.delete(side);
      shellAnimation.current?.cancel();
    },
    [side],
  );
  const layer = pour ? overlayLayer() : undefined;
  const decoration =
    pour && layer
      ? createPortal(
          <GlassSurface
            ref={bindShell}
            aria-hidden
            data-pane-pour-shell=""
            data-pane-side-decoration={side}
            className="pointer-events-none fixed z-40"
            style={{
              left: pour.box.left,
              top: pour.box.top,
              width: pour.box.width,
              height: pour.box.height,
              borderRadius: pour.radius,
              background: pour.background,
              transformOrigin: "0 0",
            }}
          />,
          layer,
        )
      : null;
  return { contentRef, layoutPinned, moving, pouring: pour !== null, decoration };
}
