/**
 * VC-30 — the peek's state machine: when a card opens, what holds it, and how
 * it goes away.
 *
 * Ported from the lab's approved reducer
 * (`lab/scratches/session-peek-wireframe-model.ts`) with every fixture concern
 * removed. The rules are the ones the v2 wireframe argued about, and each is a
 * statement about state over time — which is exactly the part a screenshot
 * cannot check and a pointer cannot be trusted to demonstrate twice:
 *
 *   • Hover READS and never acts. Arriving on a row records the row; only a
 *     dwell that completes on the row still under the pointer opens anything.
 *   • A pin owns the surface. It survives the pointer walking away, ignores a
 *     click-away and a list scroll, and keeps the recipient the label names.
 *   • A dismissal suppresses the next accidental open, because Escape undone by
 *     a pointer still resting on the row reads as Escape not working.
 *   • Escape is a LADDER — field, then the dialog, then the pin, then the card
 *     — so a person answering a question never loses the form in one press.
 *
 * WHAT IS DELIBERATELY NOT HERE. No clocks and no timers: the reducer is told
 * `now` by the caller and told when a dwell or a grace window ELAPSED, which
 * keeps the timings named constants a view arms rather than behaviour baked
 * into the rules, and keeps the tests free of fake timers.
 *
 * WHAT THE LAB HAD AND PRODUCTION DOES NOT. The fixture's `delivered` map,
 * `SendOutcome`/`SendState`, the answer draft, the question pager and the
 * simulated `opened` are all gone: a delivered answer is the shipped
 * `InteractionCard`'s submission latch (`components/chat/interaction-ui.tsx`),
 * a sent message is the session client's, and opening a Session is navigation.
 * There is no Undo, in the lab's sense or any other — nothing in production can
 * retract a delivered answer (plan §3.2, amendment A4).
 */

/** Which sidebar a row was pointed at in. The peek opens INWARD from either. */
export type PeekSurface = "nav" | "rail";

/** One row, identified by the row it stands for and the list it is in. */
export interface PeekTarget {
  readonly rowId: string;
  readonly surface: PeekSurface;
}

/**
 * Who owns keyboard focus.
 *
 * `"none"` is the hover path and the whole point of it: a peek that appears
 * under the pointer must leave focus exactly where the person put it. Focus
 * only ever moves on an explicit pin, which is what makes the Escape ladder a
 * ladder rather than a single step.
 */
export type PeekFocusOwner = "none" | "row" | "dialog" | "field";

/**
 * Why a peek was dismissed.
 *
 * `pointer-down` is the one that does NOT suppress the next open: a
 * `pointerdown` on a row is a click or the start of a drag (rows are drag
 * sources), the card must go either way, and suppressing after it would refuse
 * the peek of whatever the pointer comes to rest on next.
 */
export type PeekDismissReason = "click-away" | "list-scroll" | "escape" | "pointer-down";

export interface PeekState {
  /** The peek on screen, or none. */
  readonly shown: PeekTarget | null;
  /** The peek held open for answering. Survives pointer travel and focus moving away. */
  readonly pinned: PeekTarget | null;
  /** The row under the pointer (or the stepped-to row). Not enough to open anything. */
  readonly hovered: PeekTarget | null;
  /** Whether the pointer is inside the card — the other half of the bridge. */
  readonly overCard: boolean;
  readonly focus: PeekFocusOwner;
  /** Hover is refused until this timestamp. Set by dismissal only. */
  readonly suppressedUntil: number;
}

export type PeekEvent =
  /** The pointer (or keyboard focus) arrived on a row. Starts the dwell; opens nothing. */
  | { readonly type: "hover-row"; readonly target: PeekTarget }
  | { readonly type: "hover-leave-row" }
  /** The dwell for `target` completed with the pointer still on it. */
  | { readonly type: "dwell-elapsed"; readonly target: PeekTarget; readonly now: number }
  /** The keyboard path: Space opens at once rather than waiting out a dwell. */
  | { readonly type: "open-now"; readonly target: PeekTarget; readonly now: number }
  | { readonly type: "card-enter" }
  | { readonly type: "card-leave" }
  | { readonly type: "grace-elapsed" }
  | { readonly type: "pin"; readonly target: PeekTarget }
  | { readonly type: "unpin" }
  | { readonly type: "focus-field" }
  | { readonly type: "blur-field" }
  | { readonly type: "escape"; readonly now: number }
  /**
   * The row the peek stands for is no longer in the listing — it ended, its
   * ticket moved, the folder emptied. Not a dismissal: nobody chose it, so the
   * next row's peek must not be suppressed, and a PIN cannot outlive the row it
   * names (a pin that did would hold `shown` forever and freeze both sidebars'
   * order with it — D7's hold is `shown !== null`).
   */
  | { readonly type: "subject-gone" }
  | {
      readonly type: "dismiss";
      readonly reason: PeekDismissReason;
      readonly now: number;
    };

/** Pointer at rest on a row before its peek opens (D1). */
export const PEEK_DWELL_MS = 350;
/** Once a card is open, a neighbour opens after this shorter rest (D1). */
export const PEEK_WARM_DWELL_MS = 150;
/**
 * The row→card bridge. The pointer has to cross a gap to reach the card, and a
 * card that closes mid-crossing is a card you cannot use (WCAG 1.4.13's
 * "hoverable"), so closing is deferred by this much after the pointer has left
 * BOTH the row and the card.
 */
export const PEEK_GRACE_MS = 300;
/** How long after an explicit dismissal a hover is refused (D1). */
export const PEEK_SUPPRESSION_MS = 1000;
/** Keyboard focus arriving on a row opens its peek after this, not the pointer dwell. */
export const PEEK_FOCUS_DWELL_MS = 250;
/** How long a sent message's confirmation holds the card open before it closes. */
export const PEEK_CONFIRMATION_MS = 2000;

export const initialPeekState: PeekState = {
  shown: null,
  pinned: null,
  hovered: null,
  overCard: false,
  focus: "none",
  suppressedUntil: 0,
};

/**
 * Whether two targets name the same row of the same surface.
 *
 * Exported because the view asks the same question the rules do — "is the row
 * under the pointer the one already shown?" — and two spellings of row identity
 * is how the two halves drift apart.
 */
export function sameTarget(a: PeekTarget | null, b: PeekTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.rowId === b.rowId && a.surface === b.surface;
}

/** A closed peek that refuses to re-open for {@link PEEK_SUPPRESSION_MS}. */
function dismissed(state: PeekState, suppressedUntil: number): PeekState {
  return {
    ...state,
    shown: null,
    pinned: null,
    overCard: false,
    focus: "none",
    suppressedUntil,
  };
}

export function peekReducer(state: PeekState, event: PeekEvent): PeekState {
  switch (event.type) {
    case "hover-row":
      // Recorded, never acted on. Two things follow: passing the pointer across
      // a band opens nothing (the view re-arms the dwell on every new row), and
      // hovering a DIFFERENT row while one is pinned does not steal the pinned
      // recipient — the answer keeps going where the label says.
      return { ...state, hovered: event.target };

    case "hover-leave-row":
      return { ...state, hovered: null };

    case "dwell-elapsed": {
      if (event.now < state.suppressedUntil) return state;
      // A pin owns the surface until it is released.
      if (state.pinned !== null) return state;
      // The dwell that completes must be the row still under the pointer.
      if (!sameTarget(state.hovered, event.target)) return state;
      return { ...state, shown: event.target };
    }

    case "open-now": {
      if (event.now < state.suppressedUntil) return state;
      if (state.pinned !== null) return state;
      return { ...state, hovered: event.target, shown: event.target };
    }

    case "card-enter":
      return { ...state, overCard: true };

    case "card-leave":
      return { ...state, overCard: false };

    case "grace-elapsed": {
      // The bridge: anything still holding the peek keeps it. A pin holds it
      // even with the pointer on the other side of the window.
      if (state.pinned !== null) return state;
      if (state.hovered !== null || state.overCard) return state;
      // Not a dismissal: drifting away must not suppress the next hover.
      return { ...state, shown: null, focus: "none" };
    }

    case "pin":
      return {
        ...state,
        shown: event.target,
        pinned: event.target,
        // Focus moves HERE and nowhere else. The card itself takes it, not a
        // field — options are select-then-send, and a field that grabs focus on
        // a pin is a field that eats the next keystroke.
        focus: "dialog",
      };

    case "unpin":
      // Released, not closed: the card stays as the read-only peek it was
      // before the pin, and focus returns to the row.
      return { ...state, pinned: null, focus: state.shown === null ? "none" : "row" };

    case "focus-field":
      return { ...state, focus: "field" };

    case "blur-field":
      return { ...state, focus: state.pinned === null ? state.focus : "dialog" };

    case "escape": {
      // The ladder, one rung per press.
      if (state.focus === "field") return { ...state, focus: "dialog" };
      if (state.pinned !== null) {
        return { ...state, pinned: null, focus: state.shown === null ? "none" : "row" };
      }
      if (state.shown !== null) return dismissed(state, event.now + PEEK_SUPPRESSION_MS);
      return state;
    }

    case "subject-gone": {
      if (state.shown === null && state.pinned === null) return state;
      // `suppressedUntil` is deliberately untouched: this was not a decision.
      return { ...state, shown: null, pinned: null, overCard: false, focus: "none" };
    }

    case "dismiss": {
      // Click-away and list scroll are ignored while pinned: a person answering
      // a question must not lose the form by clicking the thing they are
      // reading. Escape is the way out, and it has its own ladder.
      if (state.pinned !== null) return state;
      if (state.shown === null) return state;
      return dismissed(
        state,
        event.reason === "pointer-down" ? state.suppressedUntil : event.now + PEEK_SUPPRESSION_MS,
      );
    }
  }
}

/** Whether a row's peek is the one on screen. */
export function isPeekShowing(state: PeekState, target: PeekTarget): boolean {
  return sameTarget(state.shown, target);
}
