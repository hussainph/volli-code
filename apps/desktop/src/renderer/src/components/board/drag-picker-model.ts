/**
 * The Option-drag picker, as a state machine (VC-132).
 *
 * Holding ⌥ over a column grows it into large landing targets — its Offered
 * list plus a **Move only** target — so suppressing an armed Automation is a
 * place you aim at rather than a chord you remember. This module is that
 * gesture's whole decision surface, kept pure so every rule below is a test
 * rather than a hand on a mouse. `board.tsx` owns the listeners and dnd-kit;
 * `column-offered-panel.tsx` draws what this decides.
 *
 * Four rules survived the Lab drag rig (`lab/automation/use-drag-sim.ts`), and
 * each is a function or a branch here rather than a comment:
 *
 *  1. **⌥ is a STATE, not an edge.** "Holding ⌥ over a column" must mean the
 *     column is expanded — always, not only when the keydown happened to arrive
 *     while a column was hovered. The rig's two holes were ⌥ pressed over the
 *     gutter (nothing opened, and nothing ever would) and a drag STARTED with ⌥
 *     already down (no keydown ever arrives). Both are the rejected
 *     Option-alone design's failure exactly: a held modifier with nothing on
 *     screen honouring it reads as a bug. So the picker opens from whichever
 *     half becomes true last, and a keyup that never arrived — ⌥ released while
 *     the window lacked focus — collapses it on the next pointer move, because
 *     that event carries the live truth.
 *  2. **Every release under ⌥ lands on a named target.** While the picker is
 *     open the picker, not the pointer, is what a release obeys
 *     ({@link dragPickerRelease}), so a slipped pointer cannot land anywhere
 *     unnamed.
 *  3. **Opening preselects what a plain release would already do.** Never
 *     "Move only": ⌥ is there to let you SEE the choice, never to change it out
 *     from under you. With the armed Automation pinned to digit 1
 *     (`@volli/shared`'s `offeredAutomationsInDigitOrder`) that preselection is
 *     index 0 by arithmetic, not by a second statement of the pin.
 *  4. **Nothing dwells.** Every transition here is a pure function of the event
 *     that caused it; there is no timer, no debounce and no hysteresis anywhere
 *     between the pointer and its target.
 *
 * Escape is deliberately absent: it cancels the whole DRAG, which is what
 * dnd-kit's own pointer sensor already makes it mean on the board, and the
 * cancel arrives here as {@link DragPickerEvent} `drag-end`. ⌥-up is how a
 * picker closes without ending the drag; Escape is how a drag ends.
 */
import { type TicketStatus } from "@volli/shared";

/**
 * One column plus one row of its digit list.
 *
 * `index: null` is **Move only**, explicitly chosen — never the absence of a
 * choice. Absence is the outer `| null` on whichever field holds one of these.
 */
export interface DragPickerLanding {
  status: TicketStatus;
  index: number | null;
}

export interface DragPickerState {
  /** Live only between `drag-start` and `drag-end`; every other event is inert at rest. */
  dragging: boolean;
  /** Raw ⌥ state, independent of whether a picker actually opened for it. */
  modifierHeld: boolean;
  /** The column under the pointer, hit-tested on every move. */
  hovered: TicketStatus | null;
  /** The open picker's live highlight, or `null` when no picker is open. */
  picker: DragPickerLanding | null;
  /**
   * The bare-digit layer's choice, bound to the column it was made in.
   *
   * Digits work without ⌥ too, because the rows are on screen either way: a
   * column the pointer is merely over shows its Offered list compactly, with
   * the digit that picks each. The binding is to the SELECTION's own column and
   * not to "the previously hovered one" — right after a picker closes the
   * pointer's board position is usually stale, and comparing against the last
   * hover would wipe the choice on the very next move.
   */
  selection: DragPickerLanding | null;
}

/** At rest: no drag, no picker, nothing chosen. */
export const IDLE_DRAG_PICKER: DragPickerState = {
  dragging: false,
  modifierHeld: false,
  hovered: null,
  picker: null,
  selection: null,
};

/**
 * What the picker needs to know about a column, supplied by the board so this
 * module never has to know what an Automation is.
 */
export interface DragPickerColumns {
  /** How many Automations `status` offers a digit to — excluding Move only. */
  offeredCount(status: TicketStatus): number;
  /**
   * Where a column's DEFAULT sits in that list, or `null` when it has none.
   *
   * "Default" is what a PLAIN release would run: the effective armed
   * Automation, which the digit order pins to index 0. `null` is also Move
   * only, and correctly so — with no default, a plain release and an
   * immediately-released picker both start nothing.
   */
  defaultIndex(status: TicketStatus): number | null;
}

export type DragPickerEvent =
  /** A board drag began. `modifierHeld` because ⌥ may already be down. */
  | { kind: "drag-start"; modifierHeld: boolean }
  /** The drag ended — dropped or cancelled. Both end the picker. */
  | { kind: "drag-end" }
  /**
   * A pointer move during the drag. `hovered` is the column under the pointer;
   * `target` is the panel row under it, when the pointer is on an EXPANDED
   * panel — the two are read from the same event so the picker can never
   * highlight a row the pointer has already left.
   */
  | {
      kind: "pointer-move";
      hovered: TicketStatus | null;
      modifierHeld: boolean;
      target?: DragPickerLanding | null;
    }
  /** ⌥ went down or came up. */
  | { kind: "modifier"; held: boolean }
  /** A digit row was accelerated. `0` is Move only; `1`–`9` are Automation rows. */
  | { kind: "digit"; digit: number };

/**
 * Whether `index` names a row `status` actually offers. `null` — Move only —
 * always does: every column has the move itself to offer, including one whose
 * Offered list is empty.
 *
 * Only the upper bound is checked, because there is no lower one to check: an
 * index reaches this module as a digit (`1`–`9`, mapped to `0`–`8`) or as the
 * row the pointer is standing on, and neither can be negative.
 */
function offersIndex(
  columns: DragPickerColumns,
  status: TicketStatus,
  index: number | null,
): boolean {
  return index === null || index < columns.offeredCount(status);
}

/** Opens the picker on `status`, preselecting what a plain release would already do. */
function opened(
  state: DragPickerState,
  columns: DragPickerColumns,
  status: TicketStatus,
): DragPickerLanding {
  const selection = state.selection;
  // A choice already made for THIS column survives the picker opening over it;
  // anything else preselects the column's own default (rule 3).
  if (selection !== null && selection.status === status) return { status, index: selection.index };
  return { status, index: columns.defaultIndex(status) };
}

/**
 * Closes the picker, folding its highlight into the bare-digit layer so the
 * choice survives ⌥ coming up and the column shrinking back.
 */
function closed(state: DragPickerState): DragPickerState {
  return { ...state, picker: null, selection: state.picker };
}

/** One event, one state. No timers, no side effects, no dwell. */
export function dragPickerReducer(
  state: DragPickerState,
  event: DragPickerEvent,
  columns: DragPickerColumns,
): DragPickerState {
  if (event.kind === "drag-start") {
    // Everything a previous drag decided is void, including its hover: nothing
    // recomputes that until the first pointer move, and replaying it would
    // grow a panel on whatever column the last drag happened to end over.
    return { ...IDLE_DRAG_PICKER, dragging: true, modifierHeld: event.modifierHeld };
  }
  if (event.kind === "drag-end") return IDLE_DRAG_PICKER;
  // At rest nothing is being aimed: a digit typed on the board, or ⌥ held while
  // reading it, decides nothing until a card is actually in the air.
  if (!state.dragging) return state;

  if (event.kind === "pointer-move") {
    const moved: DragPickerState = {
      ...state,
      hovered: event.hovered,
      modifierHeld: event.modifierHeld,
    };
    if (state.picker === null) {
      // The bare-digit layer's column-bound reset, run BEFORE the open below so
      // a choice bound to some other column cannot seed this picker.
      const stale =
        moved.selection !== null &&
        event.hovered !== null &&
        event.hovered !== moved.selection.status;
      const cleared: DragPickerState = stale ? { ...moved, selection: null } : moved;
      // ⌥ already held and a column newly underfoot: "⌥ over a column" has just
      // become true, so the column grows now (rule 1).
      if (event.modifierHeld && event.hovered !== null) {
        return { ...cleared, picker: opened(cleared, columns, event.hovered) };
      }
      return cleared;
    }
    // A keyup that never arrived must not leave a column enlarged under a
    // modifier nobody is holding — the move event carries the live truth.
    if (!event.modifierHeld) return closed(moved);
    // The pointer is on a row of the expanded panel: that row is the choice.
    const target = event.target ?? null;
    if (target !== null && offersIndex(columns, target.status, target.index)) {
      return { ...moved, picker: target };
    }
    // Otherwise the open picker simply follows the hover, carrying the chosen
    // row's index where the new column is long enough to have one.
    if (event.hovered === null || event.hovered === state.picker.status) return moved;
    const carried = offersIndex(columns, event.hovered, state.picker.index)
      ? state.picker.index
      : null;
    return { ...moved, picker: { status: event.hovered, index: carried } };
  }

  if (event.kind === "modifier") {
    const held: DragPickerState = { ...state, modifierHeld: event.held };
    if (event.held) {
      if (state.picker !== null || state.hovered === null) return held;
      return { ...held, picker: opened(held, columns, state.hovered) };
    }
    // ⌥ is HELD, never sticky: the pointer never leaves the column that grew,
    // so there is nothing to steer to — and a column left conspicuously
    // enlarged with no modifier down would have nothing on screen saying why.
    return state.picker === null ? held : closed(held);
  }

  // A digit inside the picker sets the highlight directly; outside it, the
  // bare-digit layer's choice for the hovered column. `0` is Move only in both.
  const index = event.digit === 0 ? null : event.digit - 1;
  if (state.picker !== null) {
    if (!offersIndex(columns, state.picker.status, index)) return state;
    return { ...state, picker: { status: state.picker.status, index } };
  }
  if (state.hovered === null || !offersIndex(columns, state.hovered, index)) return state;
  const hovered = state.hovered;
  // The same digit again clears back to the column's own default, so a
  // mis-keyed choice is recoverable without aborting the drag.
  const repeat =
    state.selection !== null &&
    state.selection.status === hovered &&
    state.selection.index === index;
  return { ...state, selection: repeat ? null : { status: hovered, index } };
}

/** Whether a picker is open — the column drawn at landing-target size. */
export function isPickerOpen(state: DragPickerState): boolean {
  return state.picker !== null;
}

/** Whether `status` is the column the open picker belongs to. */
export function isPickerColumn(state: DragPickerState, status: TicketStatus): boolean {
  return state.picker?.status === status;
}

/**
 * Which row `status` shows as chosen right now, or `null` for Move only.
 *
 * While the picker is open its highlight owns this. Otherwise it is whatever
 * the digits chose, and failing that the column's own default — because a plain
 * release runs the default, so the default IS what is currently selected
 * whether or not anyone has touched a key.
 */
export function highlightedIndex(
  state: DragPickerState,
  columns: DragPickerColumns,
  status: TicketStatus,
): number | null {
  if (state.picker !== null && state.picker.status === status) return state.picker.index;
  if (state.selection !== null && state.selection.status === status) return state.selection.index;
  return columns.defaultIndex(status);
}

/**
 * Whether the drag should show a column's Offered list at all.
 *
 * The column the picker belongs to, always; otherwise the column under the
 * pointer, compactly. An expanded picker also DIMS its neighbours, which is the
 * view's business — this only answers whether there is a list to draw.
 */
export function showsOfferedList(state: DragPickerState, status: TicketStatus): boolean {
  if (!state.dragging) return false;
  if (state.picker !== null) return state.picker.status === status;
  return state.hovered === status;
}

/**
 * Whether the "⌥ to choose" hint is earned right now.
 *
 * Only while the fact it teaches is actionable: a drag standing over a column
 * that has an Offered list, with no picker open yet. It hides the moment ⌥ goes
 * down — advice to press the key you are pressing is noise — and never appears
 * over a column with nothing to choose, where ⌥ grows a single Move only target
 * nobody needs a hint to find.
 */
export function showsChooseHint(state: DragPickerState, columns: DragPickerColumns): boolean {
  if (!state.dragging || state.picker !== null || state.hovered === null) return false;
  return columns.offeredCount(state.hovered) > 0;
}

/** What a release chose, in the vocabulary the move itself carries. */
export type DragPickerChoice =
  /** A named Offered row — its index in the column's digit order. */
  | { kind: "automation"; index: number }
  /** The named Move only target: land the card, start nothing. */
  | { kind: "move-only" }
  /** No override at all: the plain drop, exactly as it behaved before this existed. */
  | { kind: "default" };

/**
 * Where a release lands and what it chose.
 *
 * `releaseStatus` is what the BOARD would have done with the release — dnd-kit's
 * own answer. It is overruled whenever a picker is open, because the picker,
 * not the pointer, is what a release obeys: that is the whole of "every release
 * under ⌥ lands on a named target", and it is why a pointer that slipped off
 * the panel mid-release cannot land somewhere unnamed.
 *
 * `null` only for a release that names no column at all and has no picker open
 * — the board's ordinary no-target release, which moves nothing and starts
 * nothing, exactly as it did before this existed.
 */
export function dragPickerRelease(
  state: DragPickerState,
  releaseStatus: TicketStatus | null,
): { status: TicketStatus; choice: DragPickerChoice } | null {
  const chosen =
    state.selection !== null && state.selection.status === releaseStatus ? state.selection : null;
  const landing = state.picker ?? chosen;
  if (landing !== null) {
    const choice: DragPickerChoice =
      landing.index === null ? { kind: "move-only" } : { kind: "automation", index: landing.index };
    return { status: landing.status, choice };
  }
  if (releaseStatus === null) return null;
  return { status: releaseStatus, choice: { kind: "default" } };
}
