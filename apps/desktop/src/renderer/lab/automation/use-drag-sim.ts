/**
 * A minimal pointer-drag just good enough to judge the automation drag picker.
 *
 * Deliberately NOT dnd-kit. The board's real drag is sortable, keyboard
 * accessible and writes through a store; none of that is what the open question
 * asks about, and wiring it here would mean the picker shapes differ in their
 * plumbing as well as their design. What the question needs is exactly three
 * live facts — where the pointer is, which column it is over, and whether the
 * modifier is down — reported continuously with no dwell and no debounce
 * anywhere on the path, which is a constraint the plan states outright.
 *
 * The one thing worth stating about fidelity: this cannot tell you how the
 * picker feels against dnd-kit's own drag-overlay transform or its collision
 * detection. It can tell you whether a shape is readable, reachable, and
 * whether holding (or having held) a modifier mid-drag is something a hand can
 * actually do.
 *
 * ── TWO LAYERS, NOT FIVE VARIANTS ───────────────────────────────────────────
 * The owner rejected the earlier five-way comparison outright: the dragged
 * card's ghost sat on top of the very palette it asked you to read, and the
 * thin palette rows were "a needle in a haystack" to aim at holding a card. So
 * there is now exactly one baseline (always on, no modifier) and exactly one
 * modifier-gated layer:
 *
 * Baseline — bare digits, scoped to the hovered column. A plain drop arms
 * whatever the target COLUMN is already armed with (an `arming` value this
 * hook does not itself hold — see `automation-trigger.tsx`'s `resolveAutomation`
 * — this hook only ever deals in indices and counts). `digitSelection` is the
 * one override that baseline layer can produce: it carries the column it was
 * chosen for, and a pointer move onto a DIFFERENT real column clears it back to
 * that column's own default. The clear compares against the selection's own
 * bound column, not against whatever the previously-hovered column was — that
 * distinction matters right after a picker closes, where the pointer's real
 * board position is usually stale (or off every column entirely) relative to
 * wherever the picker just let the choice happen; comparing to "the last
 * hovered value" would wipe the choice on the very next mousemove, comparing to
 * "the selection's own column" does not.
 *
 * ⌥ picker — the hovered column GROWS in place, its `pickerCell` being the
 * live highlight. It resolves to the SAME shape of value the baseline layer
 * produces — a column + an index that is `null` for the explicit "Move only"
 * choice — which is why closing it (Escape, or ⌥ coming back up) simply folds
 * `pickerCell` into `digitSelection` and lets the baseline layer's own
 * column-bound persistence and clearing take over from there.
 *
 * ⌥ is HELD, not sticky: holding costs nothing here because the pointer never
 * leaves the column that grew, so there is nothing to steer to — and a column
 * left conspicuously enlarged with no modifier down would have nothing on
 * screen explaining why. Opening preselects what a plain release would already
 * have done (`defaultIndexFor`), never "Move only" — see that option's own doc
 * for why that is a correctness rule and not a nicety. A release while it is
 * open commits `pickerCell` directly, bypassing `digitSelection` — see `onUp`.
 *
 * Two other shapes (a centred `t9` dialpad and a `radial` wedge fan) were built
 * and compared here; the owner picked this one after using all three, and they
 * were deleted rather than left to rot as dead variants.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";
import { type TicketStatus } from "@volli/shared";

/** The modifier that opens a picker. Alt/Option: Shift and Meta are already taken by the board. */
const MODIFIER = "Alt";

/**
 * One column + automation pairing. Used both for the picker's live highlight
 * (`pickerCell`) and the baseline layer's committed override (`digitSelection`)
 * — they used to be two differently-shaped types, but now that a picker's own
 * "Move only" row has to fold into the exact same override a bare digit
 * produces, there is only one shape worth naming.
 *
 * `index: null` means "Move only", explicitly chosen — never the absence of a
 * choice. Absence is instead the OUTER `| null` on whichever field holds one of
 * these (`digitSelection`, `pickerCell`).
 */
export interface AutomationTarget {
  status: TicketStatus;
  index: number | null;
}

export interface DragSim {
  /** The ticket id being dragged, or `null` when at rest. */
  ticketId: string | null;
  /**
   * The column the drag STARTED in — captured once at pointer-down, never
   * re-derived from anything live. Every picker shape has to keep saying
   * where a ticket came from even after its card stops tracking the cursor
   * (parked in `t9`, shrunk in `radial`/`expand`) or the pointer has crossed
   * several columns since — position was the only thing carrying that fact,
   * and this is what replaces it once position no longer can. `null` only
   * when at rest.
   */
  origin: TicketStatus | null;
  /** Viewport coordinates of the pointer, for positioning the floating card. */
  point: { x: number; y: number };
  /** Column currently under the pointer, hit-tested every move. */
  hovered: TicketStatus | null;
  /**
   * Pointer is on the hovered column's automation panel itself, not merely
   * somewhere inside the column. Strictly narrower than {@link hovered}, and
   * the two are not interchangeable: the dragged card gives up its full size on
   * THIS, because over the column's own cards there is nothing to obscure.
   */
  overList: boolean;
  /** Whether {@link MODIFIER} is down right now — raw key state, independent of whether a picker actually opened for it (it needs a hovered column to open at all). */
  modifierHeld: boolean;
  /** Attach to a card: begins a drag on pointer-down, remembering `origin` for the whole drag. */
  start: (ticketId: string, origin: TicketStatus) => (event: React.PointerEvent) => void;
  /**
   * What the last completed drop resolved to. `overrideIndex` is `undefined`
   * when nothing overrode the column's own armed default, `null` for an
   * explicit "Move only", and a number indexing that column's offered
   * automations otherwise — the caller (which alone knows what `arming` is)
   * resolves this into an `Automation | null`.
   */
  lastDrop: {
    ticketId: string;
    status: TicketStatus;
    overrideIndex: number | null | undefined;
  } | null;

  /** The baseline layer's current override — see the module doc. `null` means no column has one right now. */
  digitSelection: AutomationTarget | null;

  /** True while the ⌥ picker is open. */
  pickerOpen: boolean;
  /** The open picker's live highlight. `null` only when no picker has been opened this drag. */
  pickerCell: AutomationTarget | null;
  /** Wired to a picker target's pointer-enter, so hover highlights without a click — the mouse button that would click is already held down driving the drag. */
  setPickerCell: (cell: AutomationTarget) => void;
}

export interface UseDragSimOptions {
  /** How many automations column `status` offers (excluding "Move only"). Validates a digit and clamps navigation, without this hook ever needing to know what an `Automation` actually is. */
  automationCountFor: (status: TicketStatus) => number;
  /**
   * The index of a column's DEFAULT Automation, or null when it has none.
   *
   * Opening a picker must preselect the same thing a plain release would run.
   * Without this the picker opened on "Move only" while releasing without the
   * modifier ran the column's default — one gesture, two outcomes, with ⌥
   * silently deciding which. The modifier is there to let you SEE the choice,
   * never to change it out from under you.
   */
  defaultIndexFor: (status: TicketStatus) => number | null;
}

export function useDragSim({ automationCountFor, defaultIndexFor }: UseDragSimOptions): DragSim {
  const [ticketId, setTicketId] = React.useState<string | null>(null);
  const [origin, setOrigin] = React.useState<TicketStatus | null>(null);
  const [point, setPoint] = React.useState({ x: 0, y: 0 });
  const [hovered, setHovered] = React.useState<TicketStatus | null>(null);
  /** Pointer is on the automation panel itself, not just inside its column. */
  const [overList, setOverList] = React.useState(false);
  const [modifierHeld, setModifierHeld] = React.useState(false);
  const [lastDrop, setLastDrop] = React.useState<DragSim["lastDrop"]>(null);
  const [digitSelection, setDigitSelection] = React.useState<AutomationTarget | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerCell, setPickerCell] = React.useState<AutomationTarget | null>(null);

  // Read through a ref inside the listeners so they can stay mounted for the
  // whole drag without re-subscribing on every pointer move.
  const state = React.useRef({
    point,
    hovered,
    ticketId,
    digitSelection,
    pickerOpen,
    pickerCell,
  });
  state.current = {
    point,
    hovered,
    ticketId,
    digitSelection,
    pickerOpen,
    pickerCell,
  };

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

    /**
     * Is the pointer actually ON the automation panel, as opposed to merely
     * somewhere in the column that owns it?
     *
     * The dragged card shrinks out of the way on exactly this, and nothing
     * coarser will do: over the column's cards there is nothing to obscure and
     * the card should stay a card. Same elementFromPoint as {@link hitTest} for
     * the same reason — the panel changes size when ⌥ is held, so a rect cached
     * a frame ago is a rect for the wrong panel.
     */
    function overListTest(x: number, y: number): boolean {
      const element = document.elementFromPoint(x, y);
      return (element?.closest("[data-lab-automation-list]") ?? null) !== null;
    }

    function resetDragState() {
      setTicketId(null);
      setOrigin(null);
      setHovered(null);
      setOverList(false);
      setModifierHeld(false);
      setDigitSelection(null);
      setPickerOpen(false);
      setPickerCell(null);
    }

    /** Ends the drag by committing `cell` directly — the picker-open branch of both a real release and its keyboard stand-in, Enter. */
    function commitDrop(cell: AutomationTarget) {
      const ticket = state.current.ticketId;
      if (ticket !== null) {
        setLastDrop({ ticketId: ticket, status: cell.status, overrideIndex: cell.index });
      }
      resetDragState();
    }

    /** Closes whichever picker is open, folding its highlight into `digitSelection` so the baseline layer picks up exactly where it left off. */
    function closePicker() {
      const cell = state.current.pickerCell;
      setPickerOpen(false);
      setPickerCell(null);
      setDigitSelection(cell !== null ? { status: cell.status, index: cell.index } : null);
    }

    function openPicker() {
      const selection = state.current.digitSelection;
      const hoveredNow = state.current.hovered;

      // Anchored to a column that's already decided — the one under the
      // pointer. There is nothing to open around without one.
      if (hoveredNow === null) return;
      const index =
        selection !== null && selection.status === hoveredNow
          ? selection.index
          : defaultIndexFor(hoveredNow);
      setPickerCell({ status: hoveredNow, index });
      setPickerOpen(true);
    }

    /**
     * Move the highlighted row within the ⌥-expanded column's list, wrapping
     * through the "Move only" slot at index 0.
     *
     * The doc used to say "`t9` only: move the highlighted COLUMN", which is
     * what it did before the t9 and radial variants were deleted — it has
     * navigated the automation index inside one column ever since, and only the
     * comment was left behind.
     */
    function moveIndex(delta: number) {
      const cell = state.current.pickerCell;
      if (cell === null) return;
      const count = automationCountFor(cell.status);
      const total = count + 1; // +1 for the "Move only" slot.
      const current = cell.index === null ? 0 : cell.index + 1;
      const next = (current + delta + total) % total;
      setPickerCell({ status: cell.status, index: next === 0 ? null : next - 1 });
    }

    /** A digit picks a row within the highlighted column directly; `0` picks "Move only". */
    function setDigitInPicker(digit: string) {
      const cell = state.current.pickerCell;
      if (cell === null) return;
      if (digit === "0") {
        setPickerCell({ status: cell.status, index: null });
        return;
      }
      const index = Number(digit) - 1;
      if (index < automationCountFor(cell.status)) setPickerCell({ status: cell.status, index });
    }

    function onMove(event: PointerEvent) {
      setPoint({ x: event.clientX, y: event.clientY });
      const next = hitTest(event.clientX, event.clientY);
      setHovered(next);
      setOverList(overListTest(event.clientX, event.clientY));
      // Tracked on move as well as on key events: a drag that begins with the
      // modifier ALREADY down would otherwise never see a keydown.
      setModifierHeld(event.altKey);

      if (!state.current.pickerOpen) {
        // Baseline layer's column-bound reset — compared against the
        // SELECTION's own column, not the previous `hovered` value; see the
        // module doc for why that distinction matters right after a picker
        // closes.
        const selection = state.current.digitSelection;
        if (selection !== null && next !== null && next !== selection.status) {
          setDigitSelection(null);
        }
        return;
      }

      {
        // Spatially anchored, same as the baseline layer: the expanded
        // column simply follows the hover, carrying the whole tile grid with
        // it instead of a bare digit.
        if (next === null) return;
        const cell = state.current.pickerCell;
        if (cell !== null && cell.status === next) return;
        const count = automationCountFor(next);
        const carried =
          cell !== null && cell.index !== null && cell.index < count ? cell.index : null;
        setPickerCell({ status: next, index: carried });
        return;
      }
    }

    function onUp(event: PointerEvent) {
      const ticket = state.current.ticketId;
      if (ticket !== null) {
        if (state.current.pickerOpen && state.current.pickerCell !== null) {
          commitDrop(state.current.pickerCell);
          return; // commitDrop already reset everything.
        }
        const boardStatus = hitTest(event.clientX, event.clientY);
        if (boardStatus !== null) {
          const selection = state.current.digitSelection;
          const overrideIndex =
            selection !== null && selection.status === boardStatus ? selection.index : undefined;
          setLastDrop({ ticketId: ticket, status: boardStatus, overrideIndex });
        }
      }
      resetDragState();
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === MODIFIER) {
        const down = event.type === "keydown";
        setModifierHeld(down);
        if (down && !state.current.pickerOpen) {
          openPicker();
        } else if (!down && state.current.pickerOpen) {
          // HELD for `radial` and `expand`; sticky only for `t9`.
          //
          // radial — letting go of ⌥ mid-flick IS the commit gesture, folding
          // the wedge under the cursor into `digitSelection` the way Escape
          // does elsewhere.
          //
          // expand — the owner's rule: "if the user lets go of the Option key,
          // it collapses back into a smaller option." It is the only shape
          // where holding costs nothing, because the pointer never has to
          // travel to a separate surface to use it — the column you are already
          // over is the one that grew. Sticky would leave a column
          // conspicuously enlarged with no modifier held to explain why.
          //
          // t9 stays sticky: it is a surface you navigate away from the board,
          // and requiring a sustained second-hand modifier while steering to a
          // tile would throw away the cell you had highlighted.
          closePicker();
        }
      }
      if (event.type !== "keydown") return;

      if (event.key === "Escape") {
        if (state.current.pickerOpen) {
          closePicker();
          return;
        }
        // No picker open: cancel the whole drag. Through `resetDragState`, not
        // by hand — the hand-written version left `origin`, `overList` and
        // `modifierHeld` at their mid-drag values, so a consumer reading those
        // at rest saw a drag that was already over.
        resetDragState();
        return;
      }

      if (event.key === "Enter" && state.current.pickerOpen && state.current.pickerCell !== null) {
        // The keyboard equivalent of releasing the mouse over the highlighted
        // cell right now — `t9`'s "release or Enter commits."
        commitDrop(state.current.pickerCell);
        return;
      }

      if (state.current.pickerOpen) {
        const digit = /^Digit([0-9])$/.exec(event.code)?.[1];
        if (digit !== undefined) {
          event.preventDefault();
          setDigitInPicker(digit);
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          moveIndex(event.key === "ArrowDown" ? 1 : -1);
        }
        return;
      }

      // ---- baseline layer: bare `code`-based digit, scoped to the hovered column ----
      //
      // `code`, NOT `key`. On macOS's Option dead-key layer ⌥2 arrives as key
      // "€", not "2" — irrelevant here since this layer has no modifier at
      // all, but `code` still matters for a different reason: it's the
      // PHYSICAL key, unaffected by keyboard layout. On AZERTY the unshifted
      // top row reads `& é " ' ( - è _ ç à`, not digits, so `event.key` for
      // the physically "1" key is `&`. Reading `code` keeps 1–9 meaning "the
      // same physical row" everywhere, which is what an accelerator has to be
      // to be learnable at all.
      const digit = /^Digit([0-9])$/.exec(event.code)?.[1];
      if (digit === undefined) return;
      const hoveredStatus = state.current.hovered;
      if (hoveredStatus === null) return;

      /**
       * `0` is "Move only" — move the ticket, run nothing.
       *
       * It is here, in the bare-digit layer, and not only inside the ⌥ picker,
       * because moving a ticket WITHOUT starting work is an ordinary thing to
       * want and it was costing the most expensive gesture on the board: open
       * the picker, aim at a row, release. A column with a default made the
       * cheap path the one that spends tokens and the expensive path the one
       * that spends nothing, which is backwards. Zero rows to count, one key,
       * and it reads as "none" to anyone who has ever used a numbered menu.
       */
      const index = digit === "0" ? null : Number(digit) - 1;
      if (index !== null && index >= automationCountFor(hoveredStatus)) return;

      event.preventDefault();
      // Same digit again clears back to the column's own default, so a
      // mis-keyed choice is recoverable without aborting the drag.
      setDigitSelection((current) =>
        current !== null && current.status === hoveredStatus && current.index === index
          ? null
          : { status: hoveredStatus, index },
      );
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
  }, [ticketId, automationCountFor, defaultIndexFor]);

  const start = React.useCallback(
    (id: string, startOrigin: TicketStatus) => (event: React.PointerEvent) => {
      // Left button only, and preventDefault so the browser's own text/image
      // drag never starts underneath ours.
      if (event.button !== 0) return;
      event.preventDefault();
      setTicketId(id);
      setOrigin(startOrigin);
      setPoint({ x: event.clientX, y: event.clientY });
      setModifierHeld(event.altKey);
      setLastDrop(null);
      setDigitSelection(null);
      setPickerOpen(false);
      setPickerCell(null);
      // The previous drag's hover survives a completed drop, and nothing
      // recomputes it until the first `pointermove` — so a press-without-moving
      // used to replay the old drag's highlight ring and automation panel on
      // whatever column the last one ended over.
      setHovered(null);
      setOverList(false);
    },
    [],
  );

  return {
    ticketId,
    origin,
    point,
    hovered,
    overList,
    modifierHeld,
    start,
    lastDrop,
    digitSelection,
    pickerOpen,
    pickerCell,
    setPickerCell,
  };
}
