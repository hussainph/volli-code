import * as React from "react";
import { createPortal } from "react-dom";
import { useInspectorHost } from "./inspector-host";

import { hasVisibleNativePlane } from "@renderer/components/browser/browser-plane-freeze";
import { RailResizeHandle } from "@renderer/components/ticket/rail-resize-handle";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useUiStore } from "@renderer/stores/ui";
import { armRevealClock, useEdgeReveal, ZONE_TOP_DEAD_BAND, ZONE_WIDTH } from "./edge-reveal";
import { useSidebarPour } from "./sidebar-pour";
import { GLASS_MOTION } from "@renderer/lib/glass-motion";

/** The resident right-hand sibling of the primary sidebar. Only its spacer
 * changes layout, once per pin; hover and dismissal move the same live subtree. */
export function InspectorShell({
  enabled,
  owner,
  children,
}: {
  enabled: boolean;
  owner: "home" | "ticket";
  children: React.ReactNode;
}) {
  const host = useInspectorHost();
  const collapsed = useUiStore((state) => state.railCollapsed);
  const width = useUiStore((state) => state.railWidth);
  const reduced = useReducedMotion();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const zoneRef = React.useRef<HTMLDivElement>(null);
  const bandRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLElement>(null);
  // Unknown/programmatic changes (including the global shortcut) are instant.
  // Only a click on THIS control opts this one activation into pointer motion.
  const pointerActivation = React.useRef(false);
  const pinned = enabled && !collapsed;
  const [layoutPinned, setLayoutPinned] = React.useState(pinned);
  const previousPin = React.useRef(pinned);
  const previousWidth = React.useRef(width);
  const contentMotion = React.useRef<{
    animation: Animation;
    landed: boolean;
    content: HTMLElement;
  } | null>(null);
  React.useLayoutEffect(() => {
    bandRef.current = document.querySelector('[data-slot="chrome-bar"]');
    const trigger = document.querySelector<HTMLElement>(
      `[data-inspector-trigger="shell"], [data-inspector-trigger="${owner}"]`,
    );
    triggerRef.current = trigger;
    if (trigger === null) return;
    const activate = (event: MouseEvent) => {
      pointerActivation.current = event.detail > 0;
      panelRef.current?.toggleAttribute("data-keyboard-dismiss", event.detail === 0);
      armRevealClock(panelRef.current, collapsed, true, "right");
      if (event.detail > 0 && !reduced) panelRef.current?.setAttribute("data-glass-blur", "off");
      if (event.detail === 0) {
        panelRef.current?.style.setProperty("--reveal-duration", "0ms");
        panelRef.current?.removeAttribute("data-glass-blur");
      }
    };
    trigger.addEventListener("click", activate, true);
    return () => trigger.removeEventListener("click", activate, true);
  }, [owner, enabled, collapsed, reduced]);
  React.useLayoutEffect(() => {
    if (!pointerActivation.current) {
      panelRef.current?.style.setProperty("--reveal-duration", "0ms");
      panelRef.current?.setAttribute("data-keyboard-dismiss", "true");
    }
    pointerActivation.current = false;
  }, [collapsed]);
  // Clip the reading plane while its layout stays at one endpoint. Unlike
  // the left push, the right edge is a reveal, not a translation of live text.
  React.useLayoutEffect(() => {
    const changed = previousPin.current !== pinned;
    const resized = previousWidth.current !== width;
    previousPin.current = pinned;
    previousWidth.current = width;
    const record = contentMotion.current;
    const content =
      host?.parentElement?.querySelector('[data-slot="sidebar-inset"][data-volli-surface]') ??
      panelRef.current?.parentElement?.previousElementSibling;
    const settle = () => {
      record?.animation.cancel();
      record?.content.removeAttribute("data-glass-blur");
      contentMotion.current = null;
      setLayoutPinned(pinned);
    };
    if (
      resized ||
      reduced ||
      !enabled ||
      panelRef.current?.hasAttribute("data-keyboard-dismiss") ||
      hasVisibleNativePlane(document)
    ) {
      settle();
      return;
    }
    if (record?.landed) {
      settle();
      return;
    }
    if (!changed) return;
    if (!(content instanceof HTMLElement) || typeof content.animate !== "function") {
      settle();
      return;
    }
    const from =
      record === null
        ? `inset(0px ${layoutPinned ? width : 0}px 0px 0px)`
        : getComputedStyle(content).clipPath;
    record?.animation.cancel();
    if (!pinned) setLayoutPinned(false);
    content.dataset.glassBlur = "off";
    const animation = content.animate(
      [{ clipPath: from }, { clipPath: `inset(0px ${pinned ? width : 0}px 0px 0px)` }],
      {
        duration: pinned ? 200 : GLASS_MOTION.menuOut,
        easing: pinned
          ? getComputedStyle(content).getPropertyValue("--ease-swift").trim() ||
            GLASS_MOTION.easeOutCss
          : GLASS_MOTION.easeOutCss,
        fill: "both",
      },
    );
    const journey = { animation, landed: false, content };
    contentMotion.current = journey;
    animation.onfinish = () => {
      if (contentMotion.current !== journey) return;
      journey.landed = true;
      setLayoutPinned(pinned);
      // A close already released its layout at the start, so no state change
      // remains to schedule cleanup. An opening clears after the endpoint commit.
      if (!pinned) {
        animation.cancel();
        content.removeAttribute("data-glass-blur");
        contentMotion.current = null;
      }
    };
  }, [pinned, enabled, reduced, layoutPinned, width, host]);
  React.useEffect(
    () => () => {
      contentMotion.current?.animation.cancel();
      contentMotion.current?.content.removeAttribute("data-glass-blur");
    },
    [],
  );
  const reveal = useEdgeReveal({
    enabled: enabled && collapsed,
    panelRef,
    zoneRef,
    bandRef,
    triggerRef,
    side: "right",
    // Inspector controls change its page/value, not the navigation destination.
    closeOnNavigation: false,
  });
  const shown = enabled && (!collapsed || reveal.visible);
  const pouring = useSidebarPour({
    shown,
    instant: reduced || !enabled || hasVisibleNativePlane(document),
    panelRef,
    triggerRef,
  });
  const dock = (
    <aside
      data-inspector-dock=""
      data-enabled={enabled || undefined}
      data-pinned={layoutPinned || undefined}
      className="relative shrink-0"
      style={{ width: layoutPinned && enabled ? width : 0, display: enabled ? undefined : "none" }}
    >
      <div
        ref={panelRef}
        data-inspector-panel=""
        data-native-plane-overlay={collapsed && (shown || pouring) ? "" : undefined}
        data-shown={shown || undefined}
        data-glass-blur={pouring ? "off" : undefined}
        aria-hidden={!shown || undefined}
        inert={!shown || pouring}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget)
            event.currentTarget.removeAttribute("data-glass-blur");
        }}
        onTransitionCancel={(event) => {
          if (event.target === event.currentTarget && !pouring)
            event.currentTarget.removeAttribute("data-glass-blur");
        }}
        onFocus={reveal.onPanelFocus}
        onBlur={reveal.onPanelBlur}
        style={{ width }}
      >
        <RailResizeHandle />
        {children}
      </div>
      <div
        ref={zoneRef}
        aria-hidden
        className="pointer-events-none absolute"
        style={{ top: ZONE_TOP_DEAD_BAND, bottom: 0, right: -6, width: ZONE_WIDTH + 6 }}
      />
    </aside>
  );
  return host === undefined ? dock : host === null ? null : createPortal(dock, host);
}
