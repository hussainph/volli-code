/**
 * Pointer intent for the summoned sidebar panel: when a pointer at the window's
 * left edge means "show me the sidebar", and when it means anything else.
 *
 * Arc's model rather than Linear's — a sliver you can aim at, a dwell to open, a
 * grace corridor to leave by. Four rules, each answering a specific way an edge
 * zone becomes a trap:
 *
 *   • Dwell. {@link ENTER_DELAY_MS} of continuous residence in an 8px strip. A
 *     pointer crossing 8px spends ~10ms in it at speed, so dwell alone rejects
 *     travel without needing a velocity gate. It is deliberately short: the
 *     strip is thin and a long dwell makes the panel feel unreachable.
 *   • The chrome band suppresses it. Travelling UP the left edge to ⌘B or the
 *     traffic lights is slow and stays inside the strip the whole way — the one
 *     path dwell cannot tell from intent. So the strip is dead for the first
 *     {@link ZONE_TOP_DEAD_BAND} px below the band, and any sample inside the
 *     band disarms it and starts a cooldown, which also covers the trip back
 *     down.
 *   • Pointer-down means never. There is no global "a drag is happening" signal
 *     in this renderer — the board and rail dnd-kit contexts each keep a local
 *     `useState`, the hand-rolled pointer-capture drags keep refs — but none is
 *     needed, because a drag IS a pointer-down interval. One window listener
 *     covers board cards, rail reorder, both resize grips, the split divider,
 *     the canvas pan, and text selection.
 *   • Leaving is forgiven. The close timer starts only when the pointer leaves
 *     the panel plus a corridor to its right, runs for {@link EXIT_GRACE_MS},
 *     and is cancelled by coming back — so overshooting a nav row does not
 *     dismiss the thing you were reaching into. The grace is long because what
 *     it costs when it is too short (the panel snapping shut as the pointer
 *     clips a corner) is worse than what it costs when it is too long.
 *
 * MOTION. The reveal is transform alone, {@link OPEN_MS} in and {@link CLOSE_MS}
 * out on `--ease-swift`, which IS the iOS drawer curve and this is a drawer.
 *
 * A hover-summoned panel is interrupted constantly, and a plain transition
 * handles the DIRECTION change correctly (it retargets from the live value) but
 * not the SPEED: reversing at 40% out would still spend the full close duration
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

/** Continuous residence in the strip before the panel is summoned. */
export const ENTER_DELAY_MS = 20;
/** How long an exited pointer has to come back before the panel withdraws. */
export const EXIT_GRACE_MS = 375;
/** Dead time after the pointer leaves the chrome band — see the header. */
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

/** The arming strip, on the canvas gutter the framed card already leaves bare. */
export const ZONE_WIDTH = 8;
/** Dead band under the chrome bar — see the pointer-intent note in the header. */
export const ZONE_TOP_DEAD_BAND = 24;

type Phase = "closed" | "arming" | "open" | "closing";

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
 * order, which is not something this module gets to see. One writer, one value.
 */
export function armRevealClock(
  panel: HTMLElement | null,
  toVisible: boolean,
  fullJourney = false,
): void {
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

export interface EdgeReveal {
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
 * across the layout: every rule above is a rule about the SAME question — may
 * this open now, may this close now — and splitting them across `onPointerEnter`
 * handlers is how an edge zone acquires two answers.
 *
 * Hit-testing runs against live `getBoundingClientRect()`s of a real zone
 * element rather than against arithmetic, so it stays correct under the content
 * row's `zoom`, where CSS px and client px diverge.
 */
export function useEdgeReveal({
  enabled,
  panelRef,
  zoneRef,
  bandRef,
}: {
  enabled: boolean;
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
    // Pinned (or the terminal owns the canvas): the hover machinery is not
    // merely ignored, it is reset, so re-enabling always starts from a known
    // phase rather than from whatever the pointer happened to be doing.
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
        // `openNow`, not `enter("open")`: the phase is only half of a pending
        // close. The grace timer is the other half, and a phase put back to
        // "open" while its timer still ran meant the panel withdrew ~375ms after
        // the pointer had already come back to it — a dismissal with no gesture
        // anywhere near it. Coming back has to cancel the clock as well as the
        // intent.
        if (phaseRef.current === "closing") openNow();
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
        timerRef.current = window.setTimeout(openNow, ENTER_DELAY_MS);
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
      timerRef.current = window.setTimeout(closeNow, EXIT_GRACE_MS);
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
  }, [enabled, panelRef, zoneRef, bandRef, clearTimer, closeNow, openNow, enter]);

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
    visible: phase === "open" || phase === "closing",
    arming: phase === "arming",
    onPanelClick,
    onPanelFocus,
    onPanelBlur,
  };
}
