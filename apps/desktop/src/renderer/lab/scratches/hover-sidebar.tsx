/**
 * The sidebar as an ephemeral overlay: no icon strip, a hover zone at the
 * panel's edge, ⌘B to pin. The workspace switcher is not part of it.
 *
 * The argument is not "Arc does it". It is that the collapsed strip charged 57px
 * of viewport width forever to show a list of *pages*, while the thing you came
 * back for — which sessions are running — was only ever inside the expanded
 * pane. A strip that is neither the content nor free is the worst of the three
 * options, so it is deleted and collapsed becomes genuinely zero.
 *
 * THE WORKSPACE RAIL IS CHROME, NOT SIDEBAR
 *
 * Round one had the rail riding inside the popover. That was wrong, and wrong in
 * a specific way worth naming: it made one toggle secretly govern two things.
 * `WorkspaceRailToggle` said "show the switcher" but the switcher then only
 * *stood* when the inner sidebar happened to be pinned, so turning it on while
 * unpinned appeared to do nothing. Two controls, four states, and only two of
 * them coherent.
 *
 * They are orthogonal now. The rail is a permanent flow element in the content
 * row, owned solely by `workspaceRailHidden`; the panel floats or docks, owned
 * solely by the pin. All four combinations mean exactly what they say:
 *
 *   rail on  + pinned    rail 0–60, panel docked 60–318, content from 318
 *   rail on  + unpinned  rail 0–60, panel floating, content from 68
 *   rail off + pinned    panel docked 0–258, content from 258
 *   rail off + unpinned  panel floating, content from 8
 *
 * The panel is 258px wide in all four — `sidebarWidth` (318) is the two-tier
 * width and the rail's 60 comes off it, exactly as `app-shell.tsx` already
 * computes. Hiding the rail returns its width to the canvas rather than widening
 * the panel, which is the shipped behaviour and stays.
 *
 * WHAT IS REAL AND WHAT IS RECOMPOSED
 *
 * Everything inside the panel is the app: `ProjectRail`, `PrimarySidebar` (and
 * therefore `ActiveSessions`, `NavList`, `FileTree`), `ChromeBar` with its real
 * `SidebarTrigger` and its real `WorkspaceRailToggle`, `SidebarInset` +
 * `MainContent`, and the real `SidebarResizeHandle`. The seam geometry when
 * pinned is the shipped one — this file sets `data-volli-shell="framed"` and
 * globals.css does the rest, untouched.
 *
 * What is mine is the OUTER layout, because the proposal is a change to exactly
 * that. `app-shell.tsx` collapses by animating shadcn's width tokens; an overlay
 * needs the pane to leave the flow entirely while staying mounted, and neither
 * `collapsible="icon"` nor `collapsible="offcanvas"` has that state (offcanvas
 * slides the pane out but its gap still pushes content when open). So the
 * sidebar here is one absolutely-positioned panel plus a flow spacer, and the
 * rail is a plain sibling of both.
 *
 * Recomposed away and deliberately not modelled: terminal focus (the lab has no
 * terminals) and the zoom/boot/CLI-notice hooks (module-private to `app-shell`).
 *
 * THE TWO RECTANGLES THAT COINCIDE
 *
 * Pinned and floating put the visible card in the *same place*, which is what
 * makes pinning a content animation rather than a sidebar one. Docked, the panel
 * box is full-bleed and globals.css insets `[data-volli-sidebar]` by 8px to draw
 * the seam. Floating, the panel box is itself inset by 8px and the inner is
 * flush inside it. Both land the card at `panelLeft + 8`, top 8, bottom 8, right
 * edge `panelLeft + panelWidth`. Nothing visible moves on ⌘B except the content
 * sliding out from under it.
 *
 * THE ⌘B TRICK, AND WHY IT IS TEMPORARY
 *
 * `SidebarProvider` is held permanently `open` and its `onOpenChange` is wired
 * to pin/unpin, which keeps the real ⌘B path and the unmodified chrome-band
 * trigger driving the new meaning. It is a lie in the small: `open` no longer
 * means open. The honest version lands when the icon strip actually goes,
 * because `primary-sidebar.tsx`'s collapsed presentation layer and `NavList
 * collapsed` are then dead code — with them deleted nothing reads the collapsed
 * state and `open` can be renamed to what it now is.
 *
 * POINTER INTENT
 *
 * Arc's model, not Linear's: a visible sliver you can aim at, dwell to open, a
 * grace corridor to leave by. Four rules, each answering a specific way an edge
 * zone becomes a trap:
 *
 *   • Dwell. 100ms of continuous residence in an 8px strip. A pointer crossing
 *     8px spends ~10ms in it at speed and ~80ms at a crawl, so dwell alone
 *     rejects travel without needing a velocity gate.
 *   • The chrome band suppresses it. Travelling UP the left edge to ⌘B or the
 *     traffic lights is slow and stays inside the strip the whole way — the one
 *     path dwell cannot tell from intent. So the strip is dead for the first
 *     24px below the band, and any sample inside the band disarms it and starts
 *     a 250ms cooldown, which also covers the return trip downward.
 *   • Pointer-down means never. There is no global "a drag is happening" signal
 *     in this renderer — dnd-kit's board and rail contexts each keep a local
 *     `useState`, the hand-rolled pointer-capture drags keep refs — but none is
 *     needed, because a drag IS a pointer-down interval. One window listener
 *     covers board cards, rail reorder, both resize grips, the split divider,
 *     the canvas pan, and text selection.
 *   • Leaving is forgiven. The close timer starts only when the pointer leaves
 *     the panel plus a 32px corridor to its right, runs for 220ms, and is
 *     cancelled by coming back — so overshooting a nav row does not dismiss the
 *     thing you were reaching into.
 *
 * MOTION
 *
 * Two animations, one family. The panel's reveal is `transform` only, 200ms in
 * and 160ms out on `--ease-swift` (which IS the iOS drawer curve, and this is a
 * drawer). The pin reflow is the flow spacer's width, 200ms on the same curve.
 * Nothing else animates: the panel's box, the card's radius and the border it
 * grows on its seam side all snap, because the two rectangles coincide and there
 * is nothing there to see.
 *
 * A hover-summoned panel is interrupted constantly, and a plain transition
 * handles the *direction* change correctly (it retargets from the live value)
 * but not the *speed*: reversing at 40% out would still spend the full 160ms
 * covering 40% of the distance, which is the mush that reads as jank. So the
 * duration is scaled by the distance actually left to travel, measured in the
 * handler that decides the change — before React writes the new class, because
 * after it the only thing left to measure is the destination.
 *
 * No spring, deliberately. Springs earn their keep by carrying gesture velocity
 * through an interruption; there is no gesture here and no velocity to carry, so
 * a spring would cost a dependency and buy an overshoot nobody asked for. What
 * interruption needs here is retargeting from the current value, which CSS
 * transitions do natively and for free.
 */
import * as React from "react";

import { NewTicketDialog } from "@renderer/components/board/new-ticket-dialog";
import { ChromeBar } from "@renderer/components/chrome-bar";
import { MainContent } from "@renderer/components/pages/main-content";
import { ProjectRail } from "@renderer/components/rail/project-rail";
import { PrimarySidebar } from "@renderer/components/sidebar/primary-sidebar";
import { SidebarResizeHandle } from "@renderer/components/sidebar/sidebar-resize-handle";
import { Sidebar, SidebarInset, SidebarProvider } from "@renderer/components/ui/sidebar";
import { Toaster } from "@renderer/components/ui/sonner";
import { useNavHistory } from "@renderer/hooks/use-nav-history";
import { useNewTicketShortcut } from "@renderer/hooks/use-new-ticket-shortcut";
import { useProjectShortcuts } from "@renderer/hooks/use-project-shortcuts";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

import type { ApiOverrides } from "../fake-api";
import { appApi, seedApp } from "../seed";

export const title = "Hover sidebar";
export const note = "Edge-reveal overlay; workspace rail decoupled as chrome";
export const viewport = "window" as const;

/* ── the lab's fake fullscreen ─────────────────────────────────────────────
 *
 * Fullscreen is the owner's stated motivation, and `ChromeBar` reads it through
 * the bridge (`useFullScreen`) rather than from anything this file can pass it.
 * A resized browser window is not a substitute: it changes the width but leaves
 * the traffic-light spacer at 78px, so the one place the design has to win is
 * the one place the lab would quietly lie about.
 *
 * Module-scope state, which the scratch contract forbids as a SIDE EFFECT and
 * permits as a value: nothing here touches a store, the DOM or `window` at
 * import time. `seed` puts it back so an earlier visit cannot leave the next
 * scratch believing it is fullscreen. */
const fullScreenListeners = new Set<(value: boolean) => void>();
let fullScreenValue = false;

function setFakeFullScreen(value: boolean): void {
  fullScreenValue = value;
  for (const listener of fullScreenListeners) listener(value);
}

export const api: ApiOverrides = {
  ...appApi,
  window: {
    isFullScreen: (): Promise<boolean> => Promise.resolve(fullScreenValue),
    onFullScreenChange: (listener: (value: boolean) => void): (() => void) => {
      fullScreenListeners.add(listener);
      return () => {
        fullScreenListeners.delete(listener);
      };
    },
  },
};

export function seed(): void {
  // Set, not announced: `seed` runs during the lab shell's render, and calling a
  // subscriber there would set state inside another component's render pass.
  fullScreenValue = false;
  seedApp();
}

/** app-shell.tsx's constant. The rail is fixed-width; only the panel resizes. */
const WORKSPACE_RAIL_WIDTH = 60;
/** globals.css `--shell-inset`, in the one place TS has to agree with it. */
const SHELL_INSET = 8;

/** The arming strip, on the canvas gutter the framed card already leaves bare. */
const ZONE_WIDTH = 8;
/** Dead band under the chrome bar — see the pointer-intent note in the header. */
const ZONE_TOP_DEAD_BAND = 24;
/** The standing hint, in the same gutter. */
const SLIVER_WIDTH = 6;

const DEFAULT_ENTER_DELAY_MS = 100;
const DEFAULT_EXIT_GRACE_MS = 220;
const BAND_COOLDOWN_MS = 250;
/** Long enough for a pressed row to show it took the click, short enough to feel decided. */
const NAV_CLOSE_MS = 140;
/** The grace corridor around an open panel, in viewport px. */
const SAFE_PAD_X = 32;
const SAFE_PAD_Y = 16;

/** Drawer tier, fast end — this opens far more often than a modal does. */
const OPEN_MS = 200;
/** Exits are the system answering, not the user deciding. Mirror the path, not the clock. */
const CLOSE_MS = 160;
/** Below this a scaled-down reversal stops reading as motion and starts reading as a glitch. */
const MIN_REVEAL_MS = 90;
/** Reduced motion keeps a cross-fade, and keeps it short. */
const REDUCED_REVEAL_MS = 120;
/** How far past its own width the panel travels, so `--shadow-overlay` clears the edge too. */
const SHADOW_ALLOWANCE = 32;

type Phase = "closed" | "arming" | "open" | "closing";
type EdgeHint = "sliver" | "none";

interface Point {
  x: number;
  y: number;
}

function within(rect: DOMRect | null, point: Point, padX = 0, padY = 0): boolean {
  if (rect === null) return false;
  return (
    point.x >= rect.left - padX &&
    point.x <= rect.right + padX &&
    point.y >= rect.top - padY &&
    point.y <= rect.bottom + padY
  );
}

/**
 * Whether `node` is inside a portalled overlay rather than the page under it.
 *
 * Radix menus (the session-band filter, every context menu) render into a portal
 * on `document.body`, so a click on one is geometrically "outside the panel"
 * while being, in every sense the user has, inside it. Without this the sidebar
 * dismisses itself the instant you open one of its own menus.
 */
function inPortalledOverlay(node: EventTarget | null): boolean {
  if (!(node instanceof Element)) return false;
  return (
    node.closest(
      '[data-radix-popper-content-wrapper],[role="menu"],[role="dialog"],[role="listbox"],[data-sonner-toaster]',
    ) !== null
  );
}

/**
 * How much of the reveal is already done, read off the live style: 0 fully
 * withdrawn, 1 fully out. Measured rather than tracked, because the value that
 * matters is where the compositor actually has the element right now, not which
 * state React last asked for.
 *
 * Geometry, not style, and both of the obvious style reads are wrong here.
 * Tailwind v4 compiles `translate-x-*` to the standalone `translate` PROPERTY,
 * so the `transform` matrix is the identity and reports the panel fully open at
 * every instant. Reading `translate` instead is no better: percentages in it
 * resolve at USED-value time, so the computed value comes back as the literal
 * string `calc(-100% - 40px)` and parses to nothing. Two plausible readings,
 * both of which silently turn the retargeting into a constant.
 *
 * The rect knows. `offsetLeft` is where layout put the panel and is blind to
 * transforms; `getBoundingClientRect()` is where it currently IS and is not. The
 * distance between them is the answer, in pixels, mid-transition, whatever
 * property the framework decided to animate it with.
 */
function revealProgress(panel: HTMLElement): number {
  const parent = panel.offsetParent;
  if (!(parent instanceof HTMLElement)) return 1;
  // The same number the withdrawn transform is built from, read back off the
  // element rather than recomputed — one source, so the clock and the distance
  // can never describe different journeys.
  const travel =
    panel.offsetWidth +
    (Number.parseFloat(getComputedStyle(panel).getPropertyValue("--panel-hidden-shift")) || 0);
  if (travel <= 0) return 1;
  const resting = parent.getBoundingClientRect().left + panel.offsetLeft;
  const shifted = panel.getBoundingClientRect().left - resting;
  return Math.min(1, Math.max(0, 1 + shifted / travel));
}

/**
 * Sets the clock for the journey the panel is ABOUT to make, from where it
 * actually is right now.
 *
 * The timing is the whole point and it is easy to get wrong — the first version
 * of this ran in a layout effect, which is after React has already written the
 * new class. `getComputedStyle` there returns the DESTINATION, so every
 * measurement said "already arrived", every duration collapsed to the floor, and
 * the retargeting was a constant wearing a measurement's clothes. Called from
 * the handler that decides the change instead, before `setState`, the DOM is
 * still showing the frame the user is looking at.
 *
 * `prefers-reduced-motion` is resolved here too rather than as a
 * `motion-reduce:` utility on the same property: two arbitrary-property
 * utilities for `transition-duration` would be settled by Tailwind's output
 * order, which is not something this file gets to see. One writer, one value.
 */
function armRevealClock(panel: HTMLElement | null, toVisible: boolean, fullJourney = false): void {
  if (panel === null) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    panel.style.setProperty("--reveal-duration", `${REDUCED_REVEAL_MS}ms`);
    return;
  }
  const base = toVisible ? OPEN_MS : CLOSE_MS;
  const progress = fullJourney ? (toVisible ? 0 : 1) : revealProgress(panel);
  const remaining = toVisible ? 1 - progress : progress;
  panel.style.setProperty(
    "--reveal-duration",
    `${Math.max(MIN_REVEAL_MS, Math.round(base * remaining))}ms`,
  );
}

interface EdgeReveal {
  phase: Phase;
  /** The panel is on screen — open, or open and counting down to close. */
  visible: boolean;
  /** The strip has the pointer and is counting toward open. Drives the sliver's highlight. */
  arming: boolean;
  onPanelClick(event: React.MouseEvent): void;
  onPanelFocus(): void;
  onPanelBlur(): void;
}

/**
 * The whole interaction. Deliberately one hook rather than handlers scattered
 * across the layout: every rule below is a rule about the SAME question — may
 * this open now, may this close now — and splitting them across `onPointerEnter`
 * handlers is how an edge zone acquires two answers.
 *
 * Hit-testing runs against live `getBoundingClientRect()`s of a real zone
 * element rather than against arithmetic, so it stays correct under the content
 * row's `zoom` (where CSS px and client px diverge) and so the visualiser draws
 * exactly the rectangle the code tests.
 */
function useEdgeReveal({
  enabled,
  enterDelayMs,
  exitGraceMs,
  panelRef,
  zoneRef,
  bandRef,
}: {
  enabled: boolean;
  enterDelayMs: number;
  exitGraceMs: number;
  panelRef: React.RefObject<HTMLDivElement | null>;
  zoneRef: React.RefObject<HTMLDivElement | null>;
  bandRef: React.RefObject<HTMLDivElement | null>;
}): EdgeReveal {
  const [phase, setPhase] = React.useState<Phase>("closed");
  const phaseRef = React.useRef<Phase>("closed");
  const timerRef = React.useRef<number | null>(null);
  const pointerDownRef = React.useRef(false);
  const focusWithinRef = React.useRef(false);
  const insideRef = React.useRef(false);
  const bandLeftAtRef = React.useRef(0);

  const clearTimer = React.useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const enter = React.useCallback(
    (next: Phase) => {
      if (phaseRef.current === next) return;
      const wasVisible = phaseRef.current === "open" || phaseRef.current === "closing";
      const willBeVisible = next === "open" || next === "closing";
      // Only a change in VISIBILITY moves the panel. `open → closing` starts a
      // timer and nothing else, so re-arming the clock there would overwrite a
      // live journey's duration with a measurement of a journey that is over.
      if (wasVisible !== willBeVisible) armRevealClock(panelRef.current, willBeVisible);
      phaseRef.current = next;
      setPhase(next);
    },
    [panelRef],
  );

  const closeNow = React.useCallback(() => {
    clearTimer();
    enter("closed");
  }, [clearTimer, enter]);

  const openNow = React.useCallback(() => {
    clearTimer();
    enter("open");
  }, [clearTimer, enter]);

  React.useEffect(() => {
    if (enabled) return;
    // Pinned: the hover machinery is not merely ignored, it is reset, so
    // unpinning always starts from a known phase rather than from whatever the
    // pointer happened to be doing when ⌘B landed.
    clearTimer();
    phaseRef.current = "closed";
    setPhase("closed");
  }, [enabled, clearTimer]);

  React.useEffect(() => {
    if (!enabled) return;

    function evaluate(point: Point): void {
      // A drag is a pointer-down interval. Nothing arms, nothing closes, and the
      // pane cannot appear under a card you are carrying or a grip you are
      // pulling — including this sidebar's own, whose pointer travels far
      // outside the safe corridor while captured.
      if (pointerDownRef.current) return;

      const visible = phaseRef.current === "open" || phaseRef.current === "closing";
      const bandRect = bandRef.current?.getBoundingClientRect() ?? null;

      if (within(bandRect, point)) {
        bandLeftAtRef.current = performance.now();
        insideRef.current = false;
        if (phaseRef.current === "arming") closeNow();
        else if (visible) beginClose();
        return;
      }

      const inZone = within(zoneRef.current?.getBoundingClientRect() ?? null, point);
      const inSafe =
        visible &&
        within(panelRef.current?.getBoundingClientRect() ?? null, point, SAFE_PAD_X, SAFE_PAD_Y);
      insideRef.current = inZone || inSafe;

      if (inSafe) {
        if (phaseRef.current === "closing") enter("open");
        return;
      }

      if (inZone) {
        if (visible) return;
        // Coming down off the chrome band along the left edge is a departure,
        // not an arrival. Give it a beat before the strip is live again.
        if (performance.now() - bandLeftAtRef.current < BAND_COOLDOWN_MS) return;
        if (phaseRef.current === "arming") return;
        enter("arming");
        clearTimer();
        timerRef.current = window.setTimeout(openNow, enterDelayMs);
        return;
      }

      if (phaseRef.current === "arming") closeNow();
      else if (visible) beginClose();
    }

    function beginClose(): void {
      // Keyboard users are not hovering. If focus is in the pane, the pointer's
      // opinion about where it is does not get to dismiss it.
      if (focusWithinRef.current) return;
      if (phaseRef.current === "closing") return;
      enter("closing");
      clearTimer();
      timerRef.current = window.setTimeout(closeNow, exitGraceMs);
    }

    function handleMove(event: PointerEvent): void {
      // The hover gate, per event rather than per media query: a touch or a pen
      // tap synthesises a pointermove at the point it landed, and an edge zone
      // that opens on a tap is an edge zone that opens by accident.
      if (event.pointerType !== "mouse") return;
      evaluate({ x: event.clientX, y: event.clientY });
    }

    function handleDown(event: PointerEvent): void {
      pointerDownRef.current = true;
      const visible = phaseRef.current === "open" || phaseRef.current === "closing";
      if (!visible) return;
      if (inPortalledOverlay(event.target)) return;
      const insidePanel =
        event.target instanceof Node && panelRef.current?.contains(event.target) === true;
      // Pressing anywhere else is the start of doing something else. No grace
      // period for that — the pane is in the way by definition.
      if (!insidePanel) closeNow();
    }

    function handleUp(event: PointerEvent): void {
      pointerDownRef.current = false;
      if (event.pointerType !== "mouse") return;
      evaluate({ x: event.clientX, y: event.clientY });
    }

    function handleLeaveWindow(): void {
      if (pointerDownRef.current) return;
      insideRef.current = false;
      if (phaseRef.current === "arming") closeNow();
    }

    function handleKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      // No preventDefault: Escape belongs to whatever else is listening (an
      // active session's interrupt, a dialog). Dismissing the overlay is
      // additive to that, never instead of it.
      if (phaseRef.current !== "closed") closeNow();
    }

    window.addEventListener("pointermove", handleMove, { passive: true });
    window.addEventListener("pointerdown", handleDown, { capture: true });
    window.addEventListener("pointerup", handleUp, { capture: true });
    window.addEventListener("pointercancel", handleUp, { capture: true });
    document.addEventListener("pointerleave", handleLeaveWindow);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerdown", handleDown, { capture: true });
      window.removeEventListener("pointerup", handleUp, { capture: true });
      window.removeEventListener("pointercancel", handleUp, { capture: true });
      document.removeEventListener("pointerleave", handleLeaveWindow);
      window.removeEventListener("keydown", handleKey);
    };
  }, [
    enabled,
    enterDelayMs,
    exitGraceMs,
    panelRef,
    zoneRef,
    bandRef,
    clearTimer,
    closeNow,
    openNow,
    enter,
  ]);

  React.useEffect(() => clearTimer, [clearTimer]);

  const onPanelClick = React.useCallback(
    (event: React.MouseEvent) => {
      if (!enabled) return;
      if (phaseRef.current === "closed") return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // A menu trigger is not a destination. Closing on it would dismiss the
      // pane and the menu it just opened in the same frame.
      if (target.closest("[aria-haspopup]") !== null) return;
      if (target.closest('button,a,[role="button"],[role="menuitem"]') === null) return;
      clearTimer();
      timerRef.current = window.setTimeout(closeNow, NAV_CLOSE_MS);
    },
    [enabled, clearTimer, closeNow],
  );

  const onPanelFocus = React.useCallback(() => {
    focusWithinRef.current = true;
    if (enabled && phaseRef.current !== "open") openNow();
  }, [enabled, openNow]);

  const onPanelBlur = React.useCallback(() => {
    // Deferred, because focusout fires before the next element takes focus —
    // read synchronously, every Tab between two rows looks like leaving.
    queueMicrotask(() => {
      if (panelRef.current?.contains(document.activeElement) === true) return;
      focusWithinRef.current = false;
      if (enabled && !insideRef.current && phaseRef.current !== "closed") closeNow();
    });
  }, [enabled, panelRef, closeNow]);

  return {
    phase,
    visible: phase === "open" || phase === "closing",
    arming: phase === "arming",
    onPanelClick,
    onPanelFocus,
    onPanelBlur,
  };
}

export default function HoverSidebarScratch() {
  useProjectShortcuts();
  useNewTicketShortcut();
  useNavHistory();

  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const workspaceRailHidden = useUiStore((state) => state.workspaceRailHidden);
  const uiScale = useUiStore((state) => state.uiScale);

  const [pinned, setPinned] = React.useState(false);
  const [resizing, setResizing] = React.useState(false);
  const [edgeHint, setEdgeHint] = React.useState<EdgeHint>("sliver");
  const [showZone, setShowZone] = React.useState(false);
  const [fullScreen, setFullScreen] = React.useState(fullScreenValue);
  const [enterDelayMs, setEnterDelayMs] = React.useState(DEFAULT_ENTER_DELAY_MS);
  const [exitGraceMs, setExitGraceMs] = React.useState(DEFAULT_EXIT_GRACE_MS);
  const [geometryInstant, setGeometryInstant] = React.useState(false);

  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const zoneRef = React.useRef<HTMLDivElement | null>(null);
  const bandRef = React.useRef<HTMLDivElement | null>(null);

  const reveal = useEdgeReveal({
    enabled: !pinned,
    enterDelayMs,
    exitGraceMs,
    panelRef,
    zoneRef,
    bandRef,
  });

  /**
   * The one bit the deleted icon strip never carried and the sliver exists to:
   * is anything waiting on you. Derived here from the board's Needs Review
   * column because that is real seeded data and needs no fetch; the shipped
   * version reads the "Needs you" tier `buildActiveSessionListing` already
   * computes for the pane's top band, so the sliver and the band agree by
   * construction rather than by coincidence.
   */
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const needsYou = useBoardStore((state) =>
    selectedProjectId === null
      ? false
      : (state.ticketsByProject[selectedProjectId] ?? []).some(
          (ticket) => ticket.status === "needs_review",
        ),
  );

  /* Fullscreen infers the pin state in ONE direction and remembers rather than
   * overwrites. Entering fullscreen is an explicit "give me the content", so
   * unpinning is reading the room. Leaving it is not a request for chrome, so
   * the pre-fullscreen value comes back — unless a deliberate ⌘B inside
   * fullscreen already answered the question, in which case that answer wins. */
  const pinBeforeFullScreen = React.useRef<boolean | null>(null);
  const pinTouchedInFullScreen = React.useRef(false);
  const fullScreenRef = React.useRef(fullScreen);
  const previousFullScreen = React.useRef(fullScreen);
  fullScreenRef.current = fullScreen;

  React.useEffect(() => {
    if (previousFullScreen.current === fullScreen) return;
    previousFullScreen.current = fullScreen;
    if (fullScreen) {
      pinBeforeFullScreen.current = pinned;
      pinTouchedInFullScreen.current = false;
      setPinned(false);
      return;
    }
    const remembered = pinBeforeFullScreen.current;
    pinBeforeFullScreen.current = null;
    if (!pinTouchedInFullScreen.current && remembered !== null) setPinned(remembered);
    pinTouchedInFullScreen.current = false;
  }, [fullScreen, pinned]);

  const togglePinned = React.useCallback(() => {
    if (fullScreenRef.current) pinTouchedInFullScreen.current = true;
    // Unpinning is the one journey that is never an interruption: the panel is
    // parked at rest and either stays (pointer inside) or leaves in full. Told
    // rather than measured, because `useEdgeReveal`'s reset runs in an effect,
    // by which time the DOM already shows the answer instead of the question.
    armRevealClock(panelRef.current, false, true);
    setPinned((value) => !value);
  }, []);

  const railWidth = workspaceRailHidden ? 0 : WORKSPACE_RAIL_WIDTH;

  /* Showing or hiding the switcher moves the spacer and the panel's box by the
   * same 60px, but only the spacer can transition — the panel's box is inline
   * geometry that snaps, and half of a move animating is worse than none of it.
   * So the rail toggle is instant on both, through the shell's own escape hatch
   * (app-shell.tsx holds it across the first frame of terminal focus for exactly
   * this reason). The pin toggle keeps its animation: nothing else moves there. */
  const previousRailWidth = React.useRef(railWidth);
  React.useLayoutEffect(() => {
    if (previousRailWidth.current === railWidth) return;
    previousRailWidth.current = railWidth;
    setGeometryInstant(true);
    const frame = window.requestAnimationFrame(() => setGeometryInstant(false));
    return () => window.cancelAnimationFrame(frame);
  }, [railWidth]);

  // `sidebarWidth` is the two-tier width; the panel is always what is left after
  // the rail's fixed 60, whether or not the rail is currently on screen. Hiding
  // it returns 60px to the canvas rather than widening the panel — the shipped
  // behaviour, and the reason the panel is one width across all four states.
  const panelWidth = sidebarWidth - WORKSPACE_RAIL_WIDTH;
  const panelLeft = railWidth;
  const floatingInset = pinned ? 0 : SHELL_INSET;
  // The spacer holds ONLY the panel's width. The rail is a flow sibling now and
  // already occupies its own 60px — adding it here too (which the round-one
  // layout had to, because the rail was absolutely positioned then) reserved it
  // twice and left a 60px band of bare canvas between the rail and the card.
  const gapWidth = pinned ? panelWidth : 0;
  // How far the panel must travel to be gone. `-100%` is its own width, which
  // clears the viewport only from left:0 — from left:68 it parks the panel's
  // right edge at +36, which is a strip of sidebar sitting over the rail rather
  // than a hidden sidebar. Its distance from the edge has to come too.
  const hiddenShift = panelLeft + floatingInset + SHADOW_ALLOWANCE;

  return (
    <SidebarProvider
      // Permanently open, pin/unpin on toggle — see the header. This is what
      // routes the real ⌘B and the real chrome-band trigger into the new model
      // without editing a single app file.
      open
      onOpenChange={togglePinned}
      className="relative h-svh flex-col"
      data-volli-shell={pinned ? "framed" : "ephemeral"}
      // Overrides the primitive's own `data-motion` — which app-shell.tsx also
      // overrides, unconditionally, so the primitive's keyboard-instant mode is
      // already dead in the shipped app and ⌘B already animates today. Worth
      // naming here because it settles the open question about whether ⌘B and
      // the chrome-band button should agree: they already do.
      data-motion={geometryInstant ? "instant" : undefined}
      data-resizing={resizing || undefined}
      style={
        {
          // The panel's own box. Floating, it insets itself by the shell's 8px,
          // so the pane inside has that much less to fill.
          "--sidebar-width": `${panelWidth - floatingInset}px`,
          // No icon presentation any more. Kept defined so primary-sidebar.tsx's
          // collapsed layer resolves to a width rather than to nothing.
          "--sidebar-width-icon": "0px",
          // Zero at THIS level, and that is the decoupling in one line: the rail
          // is no longer inside the pane's box, so the pane's calc must stop
          // subtracting it. The rail re-declares the real value on itself below,
          // purely so globals.css's rail-padding rule keeps reading 60.
          "--rail-width": "0px",
          // What the pane has to give back to whatever draws an edge around it.
          // Docked, the seam draws one border (globals.css uses --shell-edge
          // directly and ignores this). Floating, the card draws two, one on
          // each side, plus its own 8px inset which is already off the width
          // above.
          "--sidebar-edge": pinned ? "var(--shell-edge)" : "calc(2 * var(--shell-edge))",
        } as React.CSSProperties
      }
    >
      {/* The band owns its own 40px and the hover strip stops short of it. */}
      <div ref={bandRef} className="shrink-0">
        <ChromeBar />
      </div>

      <div
        className="relative flex min-h-0 flex-1 contain-layout"
        style={{ zoom: uiScale } as React.CSSProperties}
      >
        {/* Permanent chrome. A flow sibling of the panel, not a tier inside it —
            it stands or it is gone, and only WorkspaceRailToggle decides which.
            Its own `--rail-width` is what globals.css's centering correction
            reads; capping the padding by it is how a rail asked for 0 does not
            get floored at 8 by its own padding (that rule's note explains why).

            `opacity-0` is NOT belt-and-braces on top of a zero width, and
            dropping it as redundant is what broke pinned + switcher-off. A zero
            box does not hide anything on its own here, because `ProjectRail`
            centres a 36px tile inside it and centring in nothing puts half the
            tile at negative x. `overflow-hidden` is the obvious answer and it is
            REVOKED in this shell: globals.css turns `overflow` back to `visible`
            for every `[data-slot="sidebar"].overflow-hidden` under
            `data-volli-shell="framed"`, so the collapsible wrapper stops
            clipping the seam's shadow — and this rail matches that selector too.
            So the tiles paint outside a 0px box, and only opacity takes them
            away. `app-shell.tsx` has carried this line all along, which is
            exactly why the combination works in the app today. */}
        <Sidebar
          collapsible="none"
          data-workspace-rail
          aria-hidden={workspaceRailHidden || undefined}
          inert={workspaceRailHidden}
          className={cn(
            "w-(--rail-width) shrink-0 overflow-hidden bg-transparent pl-[min(var(--shell-inset),var(--rail-width))]",
            workspaceRailHidden && "opacity-0",
          )}
          style={{ "--rail-width": `${railWidth}px` } as React.CSSProperties}
        >
          <ProjectRail />
        </Sidebar>

        {/* The entire docked-vs-floating difference, expressed as one width.
            Nothing else in the row knows which mode it is in.

            Animated from BOTH inputs. `data-motion=instant` still suspends it,
            but it now means only what this file sets it to (one frame across a
            rail toggle) — the primitive's keyboard-instant mode never reaches
            here, because the attribute is overridden above. That is the answer
            to whether ⌘B and the chrome-band button should agree: they perform
            the same operation and what moves is layout rather than decoration,
            so both slide. `data-resizing` also suspends it, and that one is a
            real 1:1 tracking requirement rather than a taste. */}
        <div
          aria-hidden
          className="shrink-0 transition-[width] duration-200 ease-swift group-data-[motion=instant]/sidebar-wrapper:transition-none group-data-[resizing]/sidebar-wrapper:transition-none motion-reduce:transition-none"
          style={{ width: gapWidth }}
        />

        <SidebarInset
          data-volli-surface=""
          className={cn(
            "overflow-hidden border border-border",
            // Docked, globals.css owns this element's margin, radius and clip
            // (the framed seam). Floating, the seam's selector does not match
            // and the card becomes a whole card again — four corners, its own
            // left border, standing free on the canvas.
            !pinned && "m-2 rounded-xl shadow-card",
          )}
        >
          <MainContent />
        </SidebarInset>

        {/* The panel. Its BOX is set per pin state and never transitions: docked
            it is full-bleed with the seam inset drawn inside it, floating it is
            itself inset and the inner sits flush. Both put the visible card on
            the same rectangle, so the only thing left to animate is the reveal —
            and that is transform alone. */}
        <div
          ref={panelRef}
          data-slot="sidebar"
          aria-hidden={(!pinned && !reveal.visible) || undefined}
          inert={!pinned && !reveal.visible}
          onClick={reveal.onPanelClick}
          onFocus={reveal.onPanelFocus}
          onBlur={reveal.onPanelBlur}
          className={cn(
            "absolute z-20 flex transform-gpu text-sidebar-foreground",
            // `translate` FIRST, and it is the one that does the work. Tailwind
            // v4 compiles `translate-x-*` to the standalone `translate`
            // property, not into `transform` — so a transition list naming only
            // `transform` covers a property nothing is changing, and the panel
            // teleports at full opacity instead of sliding. `transform` stays
            // because `transform-gpu` writes it, and neither costs anything.
            "transition-[translate,transform,opacity] ease-swift [transition-duration:var(--reveal-duration,200ms)]",
            // Promoted a beat before it moves rather than for the whole time it
            // sits idle: `arming` leads the open by the dwell delay, which is
            // exactly the lead time the hint is worth.
            !pinned && (reveal.arming || reveal.visible) && "will-change-transform",
            pinned
              ? "translate-x-0"
              : cn(
                  // The floating card's own surface. It lives on the WRAPPER, not
                  // on `[data-volli-sidebar]`, because that selector is
                  // unconditional in globals.css and forces `background-color:
                  // transparent` for its lift overlay — a fill declared on the
                  // inner would be overruled in every mode. The lift then
                  // composites over this glass, which is the correct order
                  // anyway: material first, tier on top.
                  "overflow-hidden rounded-xl border border-border bg-sidebar/90 shadow-overlay backdrop-blur-2xl",
                  reveal.visible
                    ? "translate-x-0"
                    : // Reduced motion: the surface arrives where it will rest
                      // instead of travelling 250px across the reader's field of
                      // view. Opacity is the only thing left moving, and briefly.
                      "translate-x-[calc(-100%-var(--panel-hidden-shift))] motion-reduce:translate-x-0 motion-reduce:opacity-0",
                ),
          )}
          style={
            {
              top: floatingInset,
              bottom: floatingInset,
              left: panelLeft + floatingInset,
              width: panelWidth - floatingInset,
              "--panel-hidden-shift": `${hiddenShift}px`,
            } as React.CSSProperties
          }
        >
          <Sidebar collapsible="none" data-volli-sidebar className="min-w-0 flex-1">
            <PrimarySidebar />
          </Sidebar>
          {/* The grip keeps its meaning: it sets the panel's width in both modes,
              and one width serves both, so a panel you sized while it was
              floating is the panel you get when you pin it. Safe mid-drag
              because pointer-down suspends every open/close rule. */}
          <SidebarResizeHandle onResizingChange={setResizing} />
        </div>

        {/* The standing evidence that any of this exists, in the 8px canvas
            gutter the framed card already leaves bare — at the window edge with
            the rail hidden, between rail and card with it standing. It rides the
            panel's left edge in every state because its job is "there is
            something in HERE", which is a different question from the rail's
            "which project", and the answer belongs on the thing that opens. */}
        {!pinned && edgeHint === "sliver" ? (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute z-30 transition-opacity duration-150 ease-swift",
              reveal.visible ? "opacity-0" : "opacity-100",
            )}
            style={{ top: 0, bottom: 0, left: panelLeft, width: SLIVER_WIDTH }}
          >
            <div
              className={cn(
                "absolute inset-y-2 left-[2px] w-[2px] rounded-full transition-colors duration-150",
                reveal.arming ? "bg-foreground/35" : "bg-foreground/12",
              )}
            />
            {needsYou ? (
              <div className="absolute top-[15%] left-[2px] h-6 w-[2px] animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
            ) : null}
          </div>
        ) : null}

        {/* Hit-tested, never hit: the reveal reads this element's rect, so the
            visualiser and the rule can never disagree about where the zone is. */}
        <div
          ref={zoneRef}
          aria-hidden
          className={cn(
            "pointer-events-none absolute z-30",
            showZone && "border border-primary/50 bg-primary/15",
          )}
          style={{ top: ZONE_TOP_DEAD_BAND, bottom: 0, left: panelLeft, width: ZONE_WIDTH }}
        />
      </div>

      <Toaster />
      <NewTicketDialog />

      <LabControls
        pinned={pinned}
        phase={reveal.phase}
        edgeHint={edgeHint}
        onEdgeHint={setEdgeHint}
        showZone={showZone}
        onShowZone={setShowZone}
        fullScreen={fullScreen}
        onFullScreen={(value) => {
          setFullScreen(value);
          setFakeFullScreen(value);
        }}
        enterDelayMs={enterDelayMs}
        onEnterDelayMs={setEnterDelayMs}
        exitGraceMs={exitGraceMs}
        onExitGraceMs={setExitGraceMs}
      />
    </SidebarProvider>
  );
}

/**
 * Lab-only chrome. Bottom-centre: the left edge is the subject and the
 * bottom-right corner is the shell's own "← Lab" chip. There is no rail control
 * here on purpose — the rail is governed by the real `WorkspaceRailToggle` in
 * the chrome band, and a second one would restate the coupling this round
 * removed.
 */
function LabControls({
  pinned,
  phase,
  edgeHint,
  onEdgeHint,
  showZone,
  onShowZone,
  fullScreen,
  onFullScreen,
  enterDelayMs,
  onEnterDelayMs,
  exitGraceMs,
  onExitGraceMs,
}: {
  pinned: boolean;
  phase: Phase;
  edgeHint: EdgeHint;
  onEdgeHint(value: EdgeHint): void;
  showZone: boolean;
  onShowZone(value: boolean): void;
  fullScreen: boolean;
  onFullScreen(value: boolean): void;
  enterDelayMs: number;
  onEnterDelayMs(value: number): void;
  exitGraceMs: number;
  onExitGraceMs(value: number): void;
}) {
  return (
    <div className="fixed bottom-3 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-background/90 px-3 py-1.5 shadow-overlay backdrop-blur">
      <Segmented
        options={[
          { value: "sliver", label: "Sliver" },
          { value: "none", label: "Nothing" },
        ]}
        value={edgeHint}
        onChange={onEdgeHint}
      />
      <Segmented
        options={[
          { value: "off", label: "Zone" },
          { value: "on", label: "Show" },
        ]}
        value={showZone ? "on" : "off"}
        onChange={(value) => onShowZone(value === "on")}
      />
      <Segmented
        options={[
          { value: "window", label: "Window" },
          { value: "full", label: "Full screen" },
        ]}
        value={fullScreen ? "full" : "window"}
        onChange={(value) => onFullScreen(value === "full")}
      />
      <Stepper
        label="Dwell"
        value={enterDelayMs}
        step={20}
        min={0}
        max={400}
        onChange={onEnterDelayMs}
      />
      <Stepper
        label="Grace"
        value={exitGraceMs}
        step={40}
        min={0}
        max={800}
        onChange={onExitGraceMs}
      />
      <span className="font-mono text-label text-muted-foreground tabular-nums">
        {pinned ? "pinned" : phase}
      </span>
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange(next: T): void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className="rounded-full px-2 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Stepper({
  label,
  value,
  step,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  onChange(next: number): void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-label text-muted-foreground">{label}</span>
      <button
        type="button"
        aria-label={`${label} down`}
        onClick={() => onChange(Math.max(min, value - step))}
        className="rounded-full px-1 text-label text-muted-foreground transition-colors hover:text-foreground"
      >
        −
      </button>
      <span className="w-10 text-center font-mono text-label text-foreground tabular-nums">
        {value}ms
      </span>
      <button
        type="button"
        aria-label={`${label} up`}
        onClick={() => onChange(Math.min(max, value + step))}
        className="rounded-full px-1 text-label text-muted-foreground transition-colors hover:text-foreground"
      >
        +
      </button>
    </div>
  );
}
