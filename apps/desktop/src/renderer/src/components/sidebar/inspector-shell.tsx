import * as React from "react";
import { ControlShapeProvider } from "../ui/control-shape";
import { createPortal } from "react-dom";
import { useInspectorHost } from "./inspector-host";

import { RailResizeHandle } from "@renderer/components/ticket/rail-resize-handle";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useUiStore } from "@renderer/stores/ui";
import { armRevealClock, useEdgeReveal, ZONE_TOP_DEAD_BAND, ZONE_WIDTH } from "./edge-reveal";
import { usePaneMotion } from "./pane-motion";

/** The resident right-hand sibling of the primary sidebar. Its spacer and pane
 * share the live push width; peeks overlay the same resident subtree. */
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
  const reveal = useEdgeReveal({
    enabled: enabled && collapsed,
    panelRef,
    zoneRef,
    bandRef,
    triggerRef,
    side: "right",
    closeOnNavigation: false,
  });
  const shown = enabled && (!collapsed || reveal.visible);
  const contentElement = React.useMemo(
    () =>
      host?.parentElement?.querySelector<HTMLElement>(
        '[data-slot="sidebar-inset"][data-volli-surface]',
      ) ?? null,
    [host],
  );
  const pane = usePaneMotion({
    side: "right",
    enabled,
    mode: !shown ? "closed" : pinned ? "pinned" : "peeking",
    instant:
      reduced || !enabled || panelRef.current?.hasAttribute("data-keyboard-dismiss") === true,
    panelRef,
    triggerRef,
    contentElement,
    geometryKey: width,
  });
  const { layoutPinned } = pane;
  const dock = (
    <aside
      data-inspector-dock=""
      data-enabled={enabled || undefined}
      data-pinned={layoutPinned || undefined}
      className="relative shrink-0"
      style={{
        width: enabled ? "var(--right-pane-push, 0px)" : 0,
        display: enabled ? undefined : "none",
      }}
    >
      <div
        ref={panelRef}
        data-inspector-panel=""
        data-pane-side="right"
        data-native-plane-overlay={collapsed && shown ? "" : undefined}
        data-shown={shown || pane.moving || undefined}
        aria-hidden={!shown || undefined}
        inert={!shown}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget)
            event.currentTarget.removeAttribute("data-glass-blur");
        }}
        onTransitionCancel={(event) => {
          if (event.target === event.currentTarget)
            event.currentTarget.removeAttribute("data-glass-blur");
        }}
        onFocus={reveal.onPanelFocus}
        onBlur={reveal.onPanelBlur}
        style={{ width }}
      >
        <RailResizeHandle />
        <ControlShapeProvider context="sidebar">{children}</ControlShapeProvider>
      </div>
      <div
        ref={zoneRef}
        aria-hidden
        className="pointer-events-none absolute"
        style={{ top: ZONE_TOP_DEAD_BAND, bottom: 0, right: -6, width: ZONE_WIDTH + 6 }}
      />
      {pane.decoration}
    </aside>
  );
  return host === undefined ? dock : host === null ? null : createPortal(dock, host);
}
