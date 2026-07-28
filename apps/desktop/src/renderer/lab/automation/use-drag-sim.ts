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
 *
 * ── THE HYBRID VARIANT'S TWO TIERS ──────────────────────────────────────────
 * The `held`/`always`/`card`/`column` variants all read `chosenIndex` /
 * `modifierHeld`, and that code path below is untouched — literally the same
 * lines as before. The `hybrid` variant is a second, parallel state machine
 * (`digitSelection` for bare digits, `overlayOpen`/`overlayCell` for the ⌥
 * overlay) that only ever turns on when the caller passes `hybrid: true`, i.e.
 * only while that variant is the one on screen. The two machines never read
 * each other's state, so there is no risk of the new tiers changing what the
 * original three variants do with a keypress.
 *
 * Tier 1 (bare digits, no modifier): `digitSelection` is column-bound — it
 * carries the status it was chosen for, and a pointer move that lands on a
 * DIFFERENT real column clears it back to "move only" (the default). The
 * clear compares against the selection's own bound column, not against
 * whatever the previously-hovered column was — that distinction matters right
 * after the ⌥ overlay closes, where the pointer's real board position is
 * usually stale (or off every column entirely) relative to the far-away
 * column the overlay just let you reach; comparing to "the last hovered
 * value" would wipe that selection on the very next mousemove, comparing to
 * "the selection's own column" does not.
 *
 * Tier 2 (⌥ overlay): opens sticky on Alt keydown and stays open — release or
 * Escape close it, not Alt keyup, because the user is already holding the
 * mouse button and must not lose a highlighted cell by lifting the wrong
 * finger. While open, `overlayCell` (not the board hit-test) is the thing a
 * release commits, which is the overlay's entire reason to exist: it reaches
 * columns the pointer never has to visit. Escape closes it and folds the
 * highlighted cell into `digitSelection` — "the selection intact" — so tier 1
 * picks up exactly where the overlay left off; a second Escape (now with the
 * overlay already closed) falls through to the same whole-drag cancel every
 * other variant already has.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";
import { TICKET_STATUSES, type TicketStatus } from "@volli/shared";

/** The modifier that reveals the palette (legacy variants) / opens the overlay (hybrid). Alt/Option: Shift and Meta are already taken by the board. */
const MODIFIER = "Alt";

/** Tier 2's highlighted target. `index: null` is the explicit "move only, arm nothing" cell — reachable because the overlay's whole point is that the pointer's real position stops mattering. */
export interface OverlayCell {
  status: TicketStatus;
  index: number | null;
}

/** Tier 1's column-bound digit choice. The "move only" default is represented by the field being `null`, not by a member of this shape. */
export interface DigitSelection {
  status: TicketStatus;
  index: number;
}

export interface DragSim {
  /** The ticket id being dragged, or `null` when at rest. */
  ticketId: string | null;
  /** Viewport coordinates of the pointer, for positioning the floating card. */
  point: { x: number; y: number };
  /** Column currently under the pointer, hit-tested every move. */
  hovered: TicketStatus | null;
  /** Whether {@link MODIFIER} is held right now. */
  modifierHeld: boolean;
  /** Index into the offered automations, driven by the digit accelerator. Legacy variants only — always `0` while `hybrid` is active. */
  chosenIndex: number;
  setChosenIndex: (index: number) => void;
  /** Attach to a card: begins a drag on pointer-down. */
  start: (ticketId: string) => (event: React.PointerEvent) => void;
  /** What the last completed drop resolved to — the scratch shows it as a toast line. */
  lastDrop: { ticketId: string; status: TicketStatus; automationIndex: number } | null;

  /** Hybrid tier 1: see the module doc. Always `null` outside the hybrid variant. */
  digitSelection: DigitSelection | null;
  /** Hybrid tier 2: true from ⌥ keydown until release/Escape. Always `false` outside the hybrid variant. */
  overlayOpen: boolean;
  /** The overlay's highlighted cell while {@link DragSim.overlayOpen}. `null` only when the overlay has never been opened this drag. */
  overlayCell: OverlayCell | null;
  /** Wired to each overlay cell's pointer-enter, so hover highlights without a click — the same mouse button is already down for the drag. */
  setOverlayCell: (cell: OverlayCell) => void;
}

export interface UseDragSimOptions {
  /**
   * How many automations the LEGACY digit accelerator may reach. Capped by
   * the caller at what one hand can cover — the plan's constraint. Unused
   * while `hybrid` is true.
   */
  legacyOptionCount: number;
  /**
   * True only while the hybrid variant is the one on screen. Gates the two
   * hybrid state machines on and the legacy `chosenIndex`/Escape-cancels-
   * immediately path off, so the two designs never contaminate each other —
   * see the module doc.
   */
  hybrid: boolean;
  /**
   * How many automations column `status` offers (excluding "move only").
   * Hybrid-only: validates a bare digit, and clamps ⌥-overlay arrow-key
   * navigation. Ignored while `hybrid` is false.
   */
  automationCountFor: (status: TicketStatus) => number;
}

export function useDragSim({
  legacyOptionCount,
  hybrid,
  automationCountFor,
}: UseDragSimOptions): DragSim {
  const [ticketId, setTicketId] = React.useState<string | null>(null);
  const [point, setPoint] = React.useState({ x: 0, y: 0 });
  const [hovered, setHovered] = React.useState<TicketStatus | null>(null);
  const [modifierHeld, setModifierHeld] = React.useState(false);
  const [chosenIndex, setChosenIndex] = React.useState(0);
  const [lastDrop, setLastDrop] = React.useState<DragSim["lastDrop"]>(null);
  const [digitSelection, setDigitSelection] = React.useState<DigitSelection | null>(null);
  const [overlayOpen, setOverlayOpen] = React.useState(false);
  const [overlayCell, setOverlayCell] = React.useState<OverlayCell | null>(null);

  // Read through a ref inside the listeners so they can stay mounted for the
  // whole drag without re-subscribing on every pointer move.
  const state = React.useRef({
    hovered,
    chosenIndex,
    ticketId,
    digitSelection,
    overlayOpen,
    overlayCell,
  });
  state.current = { hovered, chosenIndex, ticketId, digitSelection, overlayOpen, overlayCell };

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

    /** Tier 2: move the overlay's highlighted column, carrying the automation index across if the destination still offers it. */
    function moveOverlayColumn(delta: number) {
      const cell = state.current.overlayCell;
      if (cell === null) return;
      const currentIndex = TICKET_STATUSES.indexOf(cell.status);
      const nextIndex = (currentIndex + delta + TICKET_STATUSES.length) % TICKET_STATUSES.length;
      const nextStatus = TICKET_STATUSES[nextIndex];
      const count = automationCountFor(nextStatus);
      const carried = cell.index !== null && cell.index < count ? cell.index : null;
      setOverlayCell({ status: nextStatus, index: carried });
    }

    /** Tier 2: move within one column's targets — "move only" then 0..count-1, wrapping. */
    function moveOverlayIndex(delta: number) {
      const cell = state.current.overlayCell;
      if (cell === null) return;
      const count = automationCountFor(cell.status);
      const total = count + 1; // +1 for the "move only" slot.
      const current = cell.index === null ? 0 : cell.index + 1;
      const next = (current + delta + total) % total;
      setOverlayCell({ status: cell.status, index: next === 0 ? null : next - 1 });
    }

    function onMove(event: PointerEvent) {
      setPoint({ x: event.clientX, y: event.clientY });
      const next = hitTest(event.clientX, event.clientY);
      setHovered(next);
      // Tracked on move as well as on key events: a drag that begins with the
      // modifier ALREADY down would otherwise never see a keydown.
      setModifierHeld(event.altKey);

      // Tier 1's column-bound reset. Compared against the SELECTION's own
      // column, not the previous `hovered` value — see the module doc for why
      // that distinction matters right after the ⌥ overlay closes.
      if (hybrid && !state.current.overlayOpen) {
        const selection = state.current.digitSelection;
        if (selection !== null && next !== null && next !== selection.status) {
          setDigitSelection(null);
        }
      }
    }

    function onUp(event: PointerEvent) {
      const boardStatus = hitTest(event.clientX, event.clientY);
      const ticket = state.current.ticketId;

      if (ticket !== null) {
        if (hybrid) {
          // Tier 2 wins if the overlay is open: the committed target is the
          // highlighted CELL, not whatever the pointer happens to be over.
          const cell = state.current.overlayCell;
          if (state.current.overlayOpen && cell !== null) {
            setLastDrop({
              ticketId: ticket,
              status: cell.status,
              automationIndex: cell.index === null ? 0 : cell.index + 1,
            });
          } else if (boardStatus !== null) {
            // Tier 1: the bare-digit selection, only if it's still bound to
            // the column the pointer is actually releasing over.
            const selection = state.current.digitSelection;
            const automationIndex =
              selection !== null && selection.status === boardStatus ? selection.index + 1 : 0;
            setLastDrop({ ticketId: ticket, status: boardStatus, automationIndex });
          }
        } else if (boardStatus !== null) {
          setLastDrop({
            ticketId: ticket,
            status: boardStatus,
            automationIndex: state.current.chosenIndex,
          });
        }
      }

      setTicketId(null);
      setHovered(null);
      setModifierHeld(false);
      setChosenIndex(0);
      setDigitSelection(null);
      setOverlayOpen(false);
      setOverlayCell(null);
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === MODIFIER) {
        setModifierHeld(event.type === "keydown");
        // Tier 2: Alt keydown opens the overlay STICKY — it does not close on
        // keyup, because the user is already holding the mouse button down
        // and releasing Alt must never discard a highlighted cell.
        if (hybrid && event.type === "keydown" && !state.current.overlayOpen) {
          const selection = state.current.digitSelection;
          const initialStatus = selection?.status ?? state.current.hovered ?? TICKET_STATUSES[0];
          const initialIndex =
            selection !== null && selection.status === initialStatus ? selection.index : null;
          setOverlayCell({ status: initialStatus, index: initialIndex });
          setOverlayOpen(true);
        }
      }
      if (event.type !== "keydown") return;

      if (hybrid) {
        if (state.current.overlayOpen) {
          // Tier 2: digits pick an automation within the highlighted column;
          // arrows move the highlight; Escape closes the overlay (not the
          // drag) and carries the highlight into tier 1.
          const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
          if (digit !== undefined) {
            const index = Number(digit) - 1;
            const cell = state.current.overlayCell;
            if (cell !== null && index < automationCountFor(cell.status)) {
              event.preventDefault();
              setOverlayCell({ status: cell.status, index });
            }
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            moveOverlayColumn(event.key === "ArrowRight" ? 1 : -1);
          }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            moveOverlayIndex(event.key === "ArrowDown" ? 1 : -1);
          }
          if (event.key === "Escape") {
            const cell = state.current.overlayCell;
            setOverlayOpen(false);
            setDigitSelection(
              cell !== null && cell.index !== null
                ? { status: cell.status, index: cell.index }
                : null,
            );
            return;
          }
          return;
        }

        // Tier 1: bare `code`-based digit — see why `code` and not `key`
        // below. Same digit again clears back to "move only", so a
        // mis-keyed choice is recoverable without aborting the drag.
        //
        // `code`, NOT `key`. The original reason this mattered was macOS's
        // Option dead-key layer (⌥2 arrives as key "€", not "2"). Tier 1 has
        // no modifier at all, so that reason is gone — but `code` still
        // matters, for a different reason: it's the PHYSICAL key, unaffected
        // by keyboard layout. On AZERTY the unshifted top row reads
        // `& é " ' ( - è _ ç à`, not digits, so `event.key` for the physically
        // "1" key is `&`. Reading `code` keeps 1–9 meaning "the same physical
        // row" everywhere, which is what an accelerator has to be to be
        // learnable at all.
        const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
        if (digit !== undefined) {
          const index = Number(digit) - 1;
          const hoveredStatus = state.current.hovered;
          if (hoveredStatus !== null && index < automationCountFor(hoveredStatus)) {
            event.preventDefault();
            setDigitSelection((current) =>
              current !== null && current.status === hoveredStatus && current.index === index
                ? null
                : { status: hoveredStatus, index },
            );
          }
        }
        if (event.key === "Escape") {
          // No overlay open: this Escape cancels the whole drag, same as
          // every other variant.
          setTicketId(null);
          setHovered(null);
          setDigitSelection(null);
        }
        return;
      }

      // ---- legacy path, unchanged: held / always / card / column variants ----
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit !== undefined && Number(digit) <= legacyOptionCount) {
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
  }, [ticketId, legacyOptionCount, hybrid, automationCountFor]);

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
      setDigitSelection(null);
      setOverlayOpen(false);
      setOverlayCell(null);
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
    digitSelection,
    overlayOpen,
    overlayCell,
    setOverlayCell,
  };
}
