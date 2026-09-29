/**
 * VC-30 — the peek's controller: timers, pointer and keyboard wiring, focus in
 * and out, the simulated send, and geometry.
 *
 * Lifted out of the v2 wireframe so the sidebar-integration scratch can drive
 * the SAME controller over a different set of rows. The rules still live in the
 * pure reducer (`session-peek-wireframe-model.ts`); this hook owns only what a
 * reducer cannot: clocks, the DOM, and where the card goes.
 *
 * HOW A ROW IS FOUND. Rows are not wrapped: a row is whatever element carries
 * `data-peek-row` (its id) and `data-peek-surface` (which sidebar). A session
 * row puts them on its `<li>`; a ticket folder puts them on its disclosure
 * BUTTON, because the folder's `<li>` also holds the nested list of its
 * children, and a pointer over a child must resolve to the child. The
 * activatable element is the row itself when it is a button, else the first
 * button inside it — see {@link peekRowButton}.
 *
 * EVERY EXTENSION IS OPT-IN and defaults to the v2 behaviour, so the wireframe
 * that this came out of runs unchanged on top of it:
 *
 *   • `canPeek` — a row that has no peek (a folder, with folder peeks off)
 *     behaves like empty space: moving onto it starts the grace window.
 *   • `canPin` — a row with nothing to answer or send (a folder, a closed
 *     terminal) is never pinned, by pointer, R, Space-twice or ⌘. .
 *   • `warmDwell` — once a peek is open, a neighbour opens after this shorter
 *     rest (the tooltip "skip delay"), so scanning siblings does not pay the
 *     full dwell per row. `null` keeps v2's full dwell.
 *   • `onRowKey` — surface-specific keys (a folder's ← / →), offered first.
 *   • `layoutKey` — changes when the card's CONTENT is swapped without the
 *     target changing (drilling into a folder's session), so the card is
 *     re-measured and the new element observed.
 *
 * THIS IS A PROTOTYPE'S CONTROLLER. The send is a timer; Undo deletes a local
 * entry; "open session" records intent. See the model's module comment.
 */
import * as React from "react";

import { clamp, positionPeek, type PeekPosition } from "./session-peek-wireframe-geometry";
import {
  CONFIRMATION_MS,
  GRACE_MS,
  initialPeekState,
  peekReducer,
  UNDO_MS,
  type PeekEvent,
  type PeekState,
  type PeekSurface,
  type PeekTarget,
  type SendOutcome,
} from "./session-peek-wireframe-model";

/** Keyboard focus arriving on a row opens its peek after this, not the pointer dwell. */
export const FOCUS_DWELL_MS = 250;

/** How long the lab's "would open …" notice stays up. */
const OPENED_NOTICE_MS = 2400;

/** A plausible round trip, so "Sending…" is visible. */
const SEND_ROUND_TRIP_MS = 450;

export interface PeekReceipt {
  readonly rowId: string;
  readonly answer: string;
  readonly at: number;
}

export interface PeekControllerOptions {
  readonly dwell: number;
  readonly hoverEnabled: boolean;
  readonly outcome: SendOutcome;
  readonly cardWidth: number;
  readonly canPeek?: (target: PeekTarget) => boolean;
  readonly canPin?: (target: PeekTarget) => boolean;
  readonly warmDwell?: number | null;
  /**
   * Offered every keydown on a row before the controller's own keys. Return
   * `true` when the key was handled; the controller then does nothing more.
   */
  readonly onRowKey?: (event: React.KeyboardEvent<HTMLElement>, target: PeekTarget) => boolean;
  readonly layoutKey?: string;
}

const ALWAYS = (): boolean => true;

function sameTarget(a: PeekTarget | null, b: PeekTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.rowId === b.rowId && a.surface === b.surface;
}

/** The element standing for a target — the `<li>` of a session, the button of a folder. */
export function peekRowElement(target: PeekTarget): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-peek-row="${target.rowId}"][data-peek-surface="${target.surface}"]`,
  );
}

/** The activatable part of a row element: the row itself if it is a button. */
export function peekRowButton(row: HTMLElement | null): HTMLElement | null {
  if (row === null) return null;
  if (row instanceof HTMLButtonElement) return row;
  return row.querySelector<HTMLElement>("button");
}

function rowIdOf(node: EventTarget | null): string | undefined {
  if (!(node instanceof Element)) return undefined;
  return node.closest<HTMLElement>("[data-peek-row]")?.dataset.peekRow;
}

export function usePeekController(options: PeekControllerOptions) {
  const {
    dwell,
    hoverEnabled,
    outcome,
    cardWidth,
    canPeek = ALWAYS,
    canPin = ALWAYS,
    warmDwell = null,
    onRowKey,
    layoutKey = "",
  } = options;
  const [state, rawDispatch] = React.useReducer(peekReducer, initialPeekState);
  /**
   * The one gate `canPin` needs: every route to a pin — the card's button, R,
   * Space on an open peek, ⌘. — arrives here as a `pin` event.
   */
  const dispatch = React.useCallback(
    (event: PeekEvent) => {
      if (event.type === "pin" && !canPin(event.target)) return;
      rawDispatch(event);
    },
    [canPin],
  );
  const [looking, setLooking] = React.useState<string | null>(null);
  const [position, setPosition] = React.useState<PeekPosition | null>(null);
  const [cardHeight, setCardHeight] = React.useState(0);
  /** The receipt that outlives the peek, so Undo is reachable for its full window. */
  const [receipt, setReceipt] = React.useState<PeekReceipt | null>(null);
  const [undoLeft, setUndoLeft] = React.useState(0);

  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const dwellTimer = React.useRef<number | null>(null);
  const graceTimer = React.useRef<number | null>(null);
  const overlayReturn = React.useRef<HTMLElement | null>(null);

  const shown = state.shown;
  const pinnedRowId = state.pinned?.rowId ?? null;

  /* ---------------------------------------------------------------- timers */

  const clearDwell = React.useCallback(() => {
    if (dwellTimer.current !== null) window.clearTimeout(dwellTimer.current);
    dwellTimer.current = null;
  }, []);

  const clearGrace = React.useCallback(() => {
    if (graceTimer.current !== null) window.clearTimeout(graceTimer.current);
    graceTimer.current = null;
  }, []);

  /**
   * Arm the dwell for one row, cancelling whatever was armed.
   *
   * This is "passing through a row never opens it": the sweep re-arms on every
   * new row, so only the row the pointer comes to rest on ever fires.
   */
  const armDwell = React.useCallback(
    (target: PeekTarget, delay: number = dwell) => {
      clearDwell();
      dwellTimer.current = window.setTimeout(() => {
        dispatch({ type: "dwell-elapsed", target, now: Date.now() });
      }, delay);
    },
    [clearDwell, dispatch, dwell],
  );

  /** The bridge: closing waits out the gap between row and card. */
  const armGrace = React.useCallback(() => {
    clearGrace();
    graceTimer.current = window.setTimeout(() => {
      dispatch({ type: "grace-elapsed" });
    }, GRACE_MS);
  }, [clearGrace, dispatch]);

  React.useEffect(
    () => () => {
      clearDwell();
      clearGrace();
    },
    [clearDwell, clearGrace],
  );

  /* ------------------------------------------------------- pointer handlers */

  const rowPointerMove = React.useCallback(
    (surface: PeekSurface) => (event: React.PointerEvent<HTMLElement>) => {
      if (!hoverEnabled || looking !== null) return;
      const rowId = rowIdOf(event.target);
      const target: PeekTarget | null = rowId === undefined ? null : { rowId, surface };
      if (target === null || !canPeek(target)) {
        // Between rows, over a band's header, or on a row with no peek: to the
        // peek that is empty space, so leaving the last peekable row for it
        // starts the bridge — exactly once, and a dwell armed for the row just
        // left can no longer open a card for a row the pointer is not on.
        if (state.hovered !== null) {
          clearDwell();
          dispatch({ type: "hover-leave-row" });
          armGrace();
        }
        return;
      }
      clearGrace();
      if (!sameTarget(state.hovered, target)) dispatch({ type: "hover-row", target });
      // Dwell means pointer AT REST, not merely time spent inside a tall row.
      if (!sameTarget(state.shown, target)) {
        armDwell(target, state.shown !== null && warmDwell !== null ? warmDwell : dwell);
      }
    },
    [
      armDwell,
      armGrace,
      canPeek,
      clearDwell,
      clearGrace,
      dispatch,
      dwell,
      hoverEnabled,
      looking,
      state.hovered,
      state.shown,
      warmDwell,
    ],
  );

  const rowPointerLeave = React.useCallback(() => {
    if (looking !== null) return;
    clearDwell();
    dispatch({ type: "hover-leave-row" });
    armGrace();
  }, [armGrace, clearDwell, dispatch, looking]);

  /* ------------------------------------------------ dismissal: away & scroll */

  React.useEffect(() => {
    if (shown === null || looking !== null) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as HTMLElement | null;
      if (node === null) return;
      // The lab's own control bar is exempt: fighting the controls that change
      // the thing under review is not a finding about the design.
      if (
        node.closest(
          '[data-peek-card], [data-peek-row], [data-lab-controls], [data-slot="dialog-overlay"], [data-slot="dialog-content"]',
        ) !== null
      )
        return;
      dispatch({ type: "dismiss", reason: "click-away", now: Date.now() });
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [shown, looking, dispatch]);

  const onListScroll = React.useCallback(() => {
    dispatch({ type: "dismiss", reason: "list-scroll", now: Date.now() });
  }, [dispatch]);

  /* ----------------------------------------------------- keyboard: the rules */

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (looking !== null) return;
      if (event.key === "Escape") {
        clearDwell();
        clearGrace();
        // A reducer focus label is not DOM focus. Move out of the field only
        // on Escape; clicking elsewhere must never pull focus back here.
        if (state.focus === "field") {
          cardRef.current?.focus();
          return;
        }
        dispatch({ type: "escape", now: Date.now() });
        return;
      }
      // ⌘. pins whatever the peek is currently showing — the pointer path's
      // way into answering without moving the hand to a button.
      if (event.key === "." && (event.metaKey || event.ctrlKey) && shown !== null) {
        event.preventDefault();
        dispatch({ type: "pin", target: shown });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shown, state.focus, clearDwell, clearGrace, looking, dispatch]);

  /**
   * Row stepping, Space, and R — scoped to the list they happen in.
   *
   * Space is intercepted rather than allowed through: the row is a `<button>`,
   * so an un-prevented Space would ALSO activate it and open the session behind
   * the peek it just asked for.
   */
  const onListKeyDown = React.useCallback(
    (surface: PeekSurface) => (event: React.KeyboardEvent<HTMLElement>) => {
      const list = event.currentTarget;
      const rows = [...list.querySelectorAll<HTMLElement>("[data-peek-row]")];
      const activeRow = (event.target as HTMLElement).closest<HTMLElement>("[data-peek-row]");
      const index = activeRow === null ? -1 : rows.indexOf(activeRow);
      const rowId = activeRow?.dataset.peekRow;

      if (rowId !== undefined && onRowKey?.(event, { rowId, surface }) === true) return;

      const step = (delta: number) => {
        event.preventDefault();
        const next = rows[clamp(index + delta, 0, rows.length - 1)];
        peekRowButton(next ?? null)?.focus();
        // The list's focus handler arms the keyboard dwell for every route
        // into a row — Tab, arrow keys, or J/K.
      };

      if (event.key === "ArrowDown" || event.key === "j") return step(1);
      if (event.key === "ArrowUp" || event.key === "k") return step(-1);
      if (rowId === undefined) return;
      const target: PeekTarget = { rowId, surface };
      if (!canPeek(target)) return;

      if (event.key === " ") {
        event.preventDefault();
        clearDwell();
        // Space opens; Space again on an open peek pins it.
        if (sameTarget(state.shown, target)) {
          dispatch({ type: "pin", target });
        } else {
          dispatch({ type: "hover-row", target });
          dispatch({ type: "open-now", target, now: Date.now() });
        }
        return;
      }
      if ((event.key === "r" || event.key === "R") && canPin(target)) {
        event.preventDefault();
        clearDwell();
        dispatch({ type: "hover-row", target });
        dispatch({ type: "pin", target });
      }
    },
    [canPeek, canPin, clearDwell, dispatch, onRowKey, state.shown],
  );

  /* ------------------------------------------------------ focus, in and out */

  /** The row a pin took focus from, so unpinning can hand it back. */
  const focusReturn = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    const target = state.pinned;
    if (target === null) return;
    // A pointer pin came from a card button, not the row. Resolve the source
    // explicitly so keyboard and pointer pins have the same return path.
    focusReturn.current = peekRowButton(peekRowElement(target));
    cardRef.current?.focus();
  }, [state.pinned]);

  React.useEffect(() => {
    if (pinnedRowId !== null) return;
    const row = focusReturn.current;
    focusReturn.current = null;
    if (row === null) return;
    if (state.focus === "row" || document.activeElement === document.body) {
      row.focus();
      clearDwell();
    }
  }, [pinnedRowId, state.focus, clearDwell]);

  /* -------------------------------------------------------- send simulation */

  React.useEffect(() => {
    if (state.send.kind !== "sending") return;
    // No IPC: the outcome is whatever the lab control says.
    const timer = window.setTimeout(() => {
      dispatch({
        type: "send-settled",
        outcome,
        now: Date.now(),
        reason:
          outcome === "failure" ? "Couldn’t send. Your reply is saved here; try again." : undefined,
      });
    }, SEND_ROUND_TRIP_MS);
    return () => window.clearTimeout(timer);
  }, [state.send.kind, outcome, dispatch]);

  const sentAt = state.send.kind === "sent" ? state.send.at : null;
  const sentAnswer = state.send.kind === "sent" ? state.send.answer : null;

  /** The confirmation holds the peek for ~2s; the receipt then carries Undo. */
  React.useEffect(() => {
    if (sentAt === null || sentAnswer === null || pinnedRowId === null) return;
    setReceipt({ rowId: pinnedRowId, answer: sentAnswer, at: sentAt });
    const timer = window.setTimeout(
      () => dispatch({ type: "confirmation-elapsed" }),
      CONFIRMATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [sentAt, sentAnswer, pinnedRowId, dispatch]);

  React.useEffect(() => {
    if (receipt === null) return;
    const tick = () => {
      const left = Math.ceil((receipt.at + UNDO_MS - Date.now()) / 1000);
      if (left <= 0) {
        setReceipt(null);
        setUndoLeft(0);
        return;
      }
      setUndoLeft(left);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [receipt]);

  const undo = React.useCallback(() => {
    if (receipt === null) return;
    dispatch({ type: "undo", rowId: receipt.rowId });
    setReceipt(null);
  }, [receipt, dispatch]);

  /** "Open session" is a simulation; say so and clear it. */
  React.useEffect(() => {
    if (state.opened === null) return;
    const timer = window.setTimeout(() => dispatch({ type: "clear-opened" }), OPENED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [state.opened, dispatch]);

  /* ------------------------------------------------------------- geometry */

  const measure = React.useCallback(() => {
    if (shown === null) {
      setPosition(null);
      return;
    }
    const row = peekRowElement(shown);
    if (row === null) return;
    setPosition(
      positionPeek(
        row.getBoundingClientRect(),
        shown.surface,
        cardHeight,
        { width: window.innerWidth, height: window.innerHeight },
        cardWidth,
      ),
    );
  }, [shown, cardHeight, cardWidth]);

  React.useLayoutEffect(measure, [measure]);

  React.useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  /** Measure the border box before paint; observing a clipped content box loses 2px. */
  const hasCard = shown !== null && position !== null && looking === null;
  React.useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) {
      setCardHeight(0);
      return;
    }
    // Measured once either way, then observed where an observer exists — jsdom
    // ships none, and `ui/tab-strip.tsx` guards the same call for the same
    // reason: a surface that threw on mount without one would be untestable.
    setCardHeight(card.getBoundingClientRect().height);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      setCardHeight(card.getBoundingClientRect().height);
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, [shown, pinnedRowId, state.send.kind, hasCard, layoutKey]);

  /* ------------------------------------------------------------------ view */

  const pin = React.useCallback(
    (target: PeekTarget) => dispatch({ type: "pin", target }),
    [dispatch],
  );

  /** Opens the conversation overlay over a row's peek, remembering where focus returns. */
  const look = React.useCallback(
    (rowId: string) => {
      overlayReturn.current = peekRowButton(
        peekRowElement({ rowId, surface: shown?.surface ?? "nav" }),
      );
      clearDwell();
      clearGrace();
      setLooking(rowId);
    },
    [clearDwell, clearGrace, shown],
  );

  /** Where the overlay hands focus back: the card's own button, else the row. */
  const lookReturn = React.useCallback((): HTMLElement | null => {
    queueMicrotask(clearDwell);
    return (
      cardRef.current?.querySelector<HTMLButtonElement>("[data-view-conversation]") ??
      overlayReturn.current
    );
  }, [clearDwell]);

  const rowProps = (surface: PeekSurface) => ({
    onPointerMove: rowPointerMove(surface),
    onPointerLeave: rowPointerLeave,
    onKeyDown: onListKeyDown(surface),
    onFocusCapture: (event: React.FocusEvent<HTMLElement>) => {
      const rowId = rowIdOf(event.target);
      if (rowId === undefined || looking !== null) return;
      const target: PeekTarget = { rowId, surface };
      if (!canPeek(target)) return;
      clearGrace();
      dispatch({ type: "hover-row", target });
      armDwell(target, FOCUS_DWELL_MS);
    },
    onBlurCapture: (event: React.FocusEvent<HTMLElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
        return;
      clearDwell();
      dispatch({ type: "hover-leave-row" });
      armGrace();
    },
  });

  /** The card's half of the bridge. */
  const cardProps = {
    onPointerEnter: () => {
      clearGrace();
      dispatch({ type: "card-enter" });
    },
    onPointerLeave: () => {
      dispatch({ type: "card-leave" });
      armGrace();
    },
  };

  /** The Hover switch: turning it off drops whatever the pointer had started. */
  const disableHover = React.useCallback(() => {
    clearDwell();
    dispatch({ type: "hover-leave-row" });
    dispatch({ type: "dismiss", reason: "click-away", now: Date.now() });
  }, [clearDwell, dispatch]);

  return {
    state: state satisfies PeekState,
    dispatch,
    cardRef,
    position,
    hasCard,
    looking,
    look,
    lookReturn,
    closeLook: () => setLooking(null),
    receipt,
    undoLeft,
    undo,
    pin,
    rowProps,
    cardProps,
    onListScroll,
    clearDwell,
    disableHover,
  };
}
