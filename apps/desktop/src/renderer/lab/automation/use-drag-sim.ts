/**
 * A minimal pointer-drag just good enough to judge the automation drag picker.
 *
 * Deliberately NOT dnd-kit. The board's real drag is sortable, keyboard
 * accessible and writes through a store; none of that is what the open question
 * asks about, and wiring it here would mean the four variants differ in their
 * plumbing as well as their design. What the question needs is exactly three
 * live facts — where the pointer is, which column it is over, and whether the
 * modifier is down — reported continuously with no dwell and no debounce
 * anywhere on the path, which is a constraint the plan states outright.
 *
 * The one thing worth stating about fidelity: this cannot tell you how the
 * picker feels against dnd-kit's own drag-overlay transform or its collision
 * detection. It can tell you whether the palette is readable, reachable, and
 * whether holding a modifier mid-drag is something a hand can actually do.
 */
import * as React from "react";
import type { TicketStatus } from "@volli/shared";

/** The modifier that reveals the palette. Alt/Option: Shift and Meta are already taken by the board. */
const MODIFIER = "Alt";

export interface DragSim {
  /** The ticket id being dragged, or `null` when at rest. */
  ticketId: string | null;
  /** Viewport coordinates of the pointer, for positioning the floating card. */
  point: { x: number; y: number };
  /** Column currently under the pointer, hit-tested every move. */
  hovered: TicketStatus | null;
  /** Whether {@link MODIFIER} is held right now. */
  modifierHeld: boolean;
  /** Index into the offered automations, driven by the digit accelerator. */
  chosenIndex: number;
  setChosenIndex: (index: number) => void;
  /** Attach to a card: begins a drag on pointer-down. */
  start: (ticketId: string) => (event: React.PointerEvent) => void;
  /** What the last completed drop resolved to — the scratch shows it as a toast line. */
  lastDrop: { ticketId: string; status: TicketStatus; automationIndex: number } | null;
}

/**
 * @param columnCount how many automations the digit accelerator may reach.
 *   Capped by the caller at what one hand can cover — the plan's constraint.
 */
export function useDragSim(optionCount: number): DragSim {
  const [ticketId, setTicketId] = React.useState<string | null>(null);
  const [point, setPoint] = React.useState({ x: 0, y: 0 });
  const [hovered, setHovered] = React.useState<TicketStatus | null>(null);
  const [modifierHeld, setModifierHeld] = React.useState(false);
  const [chosenIndex, setChosenIndex] = React.useState(0);
  const [lastDrop, setLastDrop] = React.useState<DragSim["lastDrop"]>(null);

  // Read through a ref inside the listeners so they can stay mounted for the
  // whole drag without re-subscribing on every pointer move.
  const state = React.useRef({ hovered, chosenIndex, ticketId });
  state.current = { hovered, chosenIndex, ticketId };

  React.useEffect(() => {
    if (ticketId === null) return;

    function hitTest(x: number, y: number): TicketStatus | null {
      // elementFromPoint rather than cached rects: a column list scrolls during
      // a drag, and a stale rect is the classic source of a drop landing one
      // column over from where it was aimed.
      const element = document.elementFromPoint(x, y);
      const column = element?.closest<HTMLElement>("[data-lab-column]");
      return (column?.dataset.labColumn as TicketStatus | undefined) ?? null;
    }

    function onMove(event: PointerEvent) {
      setPoint({ x: event.clientX, y: event.clientY });
      setHovered(hitTest(event.clientX, event.clientY));
      // Tracked on move as well as on key events: a drag that begins with the
      // modifier ALREADY down would otherwise never see a keydown.
      setModifierHeld(event.altKey);
    }

    function onUp(event: PointerEvent) {
      const status = hitTest(event.clientX, event.clientY);
      if (status !== null && state.current.ticketId !== null) {
        setLastDrop({
          ticketId: state.current.ticketId,
          status,
          automationIndex: state.current.chosenIndex,
        });
      }
      setTicketId(null);
      setHovered(null);
      setModifierHeld(false);
      setChosenIndex(0);
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === MODIFIER) setModifierHeld(event.type === "keydown");
      if (event.type !== "keydown") return;

      // `code`, NOT `key`. This is the whole reason the accelerator is worth
      // prototyping rather than assuming: on macOS, Option is a dead-key layer,
      // so ⌥2 arrives as key "€" and ⌥3 as "£" — the digits are simply not
      // there to read. Any palette gated behind ⌥ that parses `key` is silently
      // inert on the platform this app ships on first. `code` is the physical
      // key and is unaffected by the layer.
      //
      // Worth knowing if you re-test this: Playwright does NOT apply the Option
      // layer, so a synthetic ⌥2 reports key "2" and the bug looks fixed when
      // it is not. Trust your own hand over the automation here.
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit !== undefined && Number(digit) <= optionCount) {
        event.preventDefault();
        setChosenIndex(Number(digit) - 1);
      }
      if (event.key === "Escape") {
        setTicketId(null);
        setHovered(null);
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [ticketId, optionCount]);

  const start = React.useCallback(
    (id: string) => (event: React.PointerEvent) => {
      // Left button only, and preventDefault so the browser's own text/image
      // drag never starts underneath ours.
      if (event.button !== 0) return;
      event.preventDefault();
      setTicketId(id);
      setPoint({ x: event.clientX, y: event.clientY });
      setModifierHeld(event.altKey);
      setChosenIndex(0);
      setLastDrop(null);
    },
    [],
  );

  return {
    ticketId,
    point,
    hovered,
    modifierHeld,
    chosenIndex,
    setChosenIndex,
    start,
    lastDrop,
  };
}
