/**
 * VC-30 — the peek's controller: the one hook both sidebars mount.
 *
 * The RULES live in the pure modules beside it (`peek-machine.ts`,
 * `peek-geometry.ts`, `peek-subject.ts`); this owns only what a reducer cannot —
 * clocks, the DOM, and which card is on screen. Ported from the lab's
 * `session-peek/use-peek-controller.ts`, which drove the same reducer over the
 * same two surfaces.
 *
 * HOW A ROW IS FOUND. Rows are not wrapped: a row is whatever element carries
 * `data-peek-row` (its id) and `data-peek-surface` (which sidebar). A Session
 * row puts them on its `<li>`; a ticket folder puts them on its disclosure
 * BUTTON, because the folder's `<li>` also holds the nested list of its
 * children and a pointer over a child must resolve to the child.
 *
 * HOW THE SCROLLER IS FOUND. The hook looks for it rather than being handed it.
 * A surface that spread `scrollProps` on a wrapper that does not scroll got
 * neither dismissal nor clamp: React's `onScroll` is not a bubbling delegate,
 * and the wrapper's rect is not the box the rows move inside. So
 * {@link peekScrollerOf} walks up from the rows container to the nearest
 * ancestor that actually scrolls (`overflow-y: auto | scroll`), an explicit
 * `[data-peek-container]` overrides the walk, that element's rect is the clamp,
 * and a scroll of it dismisses through a NATIVE capture listener (scroll events
 * do not bubble, and a capture listener on the scroller also hears its inner
 * scrollers). `scrollProps` remains on the binding and remains harmless: a
 * surface that still spreads it asks for the same dismissal twice, which is
 * idempotent, and a surface that drops it loses nothing.
 *
 * TWO THINGS A PEEK MUST NEVER DO, both of them recorded on the ticket:
 *
 *   • **Consume `pointerdown`.** Rows are drag sources (`splitDragSourceProps`),
 *     so the card listens on the CAPTURE phase and neither prevents the default
 *     nor stops propagation. A press is a click or a drag; either way the card
 *     goes, and neither gesture is swallowed.
 *   • **Steal focus on hover.** Focus moves on an explicit pin and nowhere else,
 *     which is what makes the Escape ladder a ladder.
 *
 * A PEEK NEVER READS (D6). There is no `setRead` on any path a pointer can take
 * through this file: unread is cleared by opening, replying, viewing the
 * conversation, `U`, or the row's own menu.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import {
  displayTicketId,
  peekSummaryOf,
  SESSION_PEEK_REFRESH_MS,
  type ModelSelection,
  type SessionPeekContent,
  type SessionProvenance,
  type Ticket,
} from "@volli/shared";
import type { InteractionSubmission } from "@volli/session-presentation";

import { SessionGlyph } from "@renderer/components/sessions/session-glyph";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { compactAge } from "@renderer/lib/relative-time";

import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

import { clamp, PEEK_CARD_WIDTH, positionPeek, type PeekPosition } from "./peek-geometry";
import {
  initialPeekState,
  peekReducer,
  sameTarget,
  PEEK_DWELL_MS,
  PEEK_FOCUS_DWELL_MS,
  PEEK_GRACE_MS,
  PEEK_WARM_DWELL_MS,
  type PeekEvent,
  type PeekSurface,
  type PeekTarget,
} from "./peek-machine";
import {
  canPeekRow,
  canPinRow,
  FOLDER_PEEK_START,
  folderTicketId,
  peekSessionId,
  peekSubjectOf,
  type FolderPeekView,
} from "./peek-subject";
import { SessionPeekCard } from "./session-peek-card";
import { TicketPeekCard, type TicketPeekSession } from "./ticket-peek-card";
import { usePeekContent } from "./use-peek-content";

/** Everything the peek needs about one row, from whichever sidebar drew it. */
export interface SessionPeekRow {
  readonly rowId: string;
  /** `null` for a folder row: it stands for a ticket, not a Session. */
  readonly sessionId: string | null;
  readonly title: string;
  readonly ticket: Ticket | null;
  readonly kind: "chat" | "terminal";
  /** From `sessionActivityDotState(...)`; `null` where the row carries no state. */
  readonly state: StatusDotState | null;
  readonly providerId: string | null;
  readonly providerLabel: string;
  /** The row's own stamp — its `lastActivityAt`, or when it ended. */
  readonly at: number | null;
  readonly unread: boolean;
  readonly model: ModelSelection | null;
  readonly provenance: SessionProvenance;
}

export interface SessionPeekPorts {
  /** One pull per shown Session; the hook caches and refreshes on activity. */
  readContent(sessionId: string): Promise<SessionPeekContent | null>;
  /** Adopts the Session and resolves its question. `false` = not delivered (§3.3). */
  answer(
    sessionId: string,
    interactionId: string,
    submission: InteractionSubmission,
  ): Promise<boolean>;
  sendMessage(sessionId: string, text: string): Promise<boolean>;
  /** Opens the Session (navigates) and reads it. */
  openSession(rowId: string): void;
  openTicket(ticketId: string): void;
  /** Opens the shared conversation overlay and reads it. */
  viewConversation(sessionId: string): void;
  setRead(sessionId: string, unread: boolean): void;
}

export interface SessionPeekOptions {
  ticketPrefix: string;
  now: number;
  rowOf(rowId: string): SessionPeekRow | undefined;
  ticketOf(ticketId: string): Ticket | undefined;
  /** folderRowId's ticket id → its Session row ids, newest first. */
  folders: ReadonlyMap<string, readonly string[]>;
  /** A folder just expanded: its peek closes (D2). */
  onFolderToggle?(ticketId: string): void;
  ports: SessionPeekPorts;
}

export type SessionPeekRowKeyHandler = (
  event: React.KeyboardEvent<HTMLElement>,
  target: PeekTarget,
) => boolean;

export interface SessionPeekBinding {
  /** Spread onto the list container of each surface. Never consumes pointerdown's default. */
  rowProps(
    surface: PeekSurface,
  ): Pick<
    React.HTMLAttributes<HTMLElement>,
    | "onPointerMove"
    | "onPointerLeave"
    | "onPointerDownCapture"
    | "onKeyDown"
    | "onFocusCapture"
    | "onBlurCapture"
  >;
  /** Spread onto the scroll container: a scroll dismisses. */
  scrollProps: Pick<React.HTMLAttributes<HTMLElement>, "onScroll">;
  /** The fixed-position card, or null. Render it once per surface host. */
  card: React.ReactNode;
  /** True while the pointer is inside this surface or a card is open — S4's hold (D7). */
  holding: boolean;
  shownRowId: string | null;
  /** The surface's own keys (folder ←/→, U); returns true when it handled the event (D8). */
  registerRowKeys(handler: SessionPeekRowKeyHandler): void;
}

/** The element standing for a target — the `<li>` of a Session, the button of a folder. */
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

/**
 * Whether focus landed in something a person TYPES into rather than on the row.
 *
 * The rail's rows carry an inline rename `<input>` inside the same
 * `<li data-peek-row>`, so a rename arming a peek would put a card over the
 * field being edited. Focus inside a control like that is not focus on the row.
 */
function isEditableTarget(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Whether an element scrolls its own overflow vertically. */
function scrollsVertically(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll";
}

/**
 * The element the rows actually scroll inside: an explicit `[data-peek-container]`,
 * else the nearest scrolling ancestor of the rows container (the container
 * itself counts), else `null` for a list that does not scroll at all.
 */
function peekScrollerOf(list: HTMLElement | null, row: HTMLElement): HTMLElement | null {
  const explicit = row.closest<HTMLElement>("[data-peek-container]");
  if (explicit !== null) return explicit;
  for (let node: HTMLElement | null = list ?? row; node !== null; node = node.parentElement) {
    if (scrollsVertically(node)) return node;
  }
  return null;
}

/**
 * The one line each Session in a folder's card shows.
 *
 * A folder card is the one surface that needs several folds at once, and it is
 * also the one where a row's own title says least ("Chat", three times). Each is
 * one pull, cached until the summary cooldown, and started only once a folder's
 * card is actually on screen. A later hover may retry, never a timer.
 */
function useFolderSummaries(
  rowIds: readonly string[],
  read: (sessionId: string) => Promise<SessionPeekContent | null>,
  summarise: (content: SessionPeekContent) => string | null,
): ReadonlyMap<string, string | null> {
  const [summaries, setSummaries] = React.useState<ReadonlyMap<string, string | null>>(new Map());
  const cache = React.useRef(new Map<string, { line: string | null; readAt: number }>());
  const key = rowIds.join("|");
  React.useEffect(() => {
    let live = true;
    for (const rowId of key === "" ? [] : key.split("|")) {
      const sessionId = peekSessionId(rowId);
      if (sessionId === null) continue;
      const cached = cache.current.get(rowId);
      if (cached !== undefined && Date.now() - cached.readAt < SESSION_PEEK_REFRESH_MS) {
        setSummaries((previous) => new Map(previous).set(rowId, cached.line));
        continue;
      }
      void read(sessionId).then(
        (content) => {
          const line = content === null ? null : summarise(content);
          cache.current.set(rowId, { line, readAt: Date.now() });
          if (!live) return;
          setSummaries((previous) => new Map(previous).set(rowId, line));
        },
        () => {
          if (!live) return;
          setSummaries((previous) => new Map(previous).set(rowId, null));
        },
      );
    }
    return () => {
      live = false;
    };
  }, [key, read, summarise]);
  return summaries;
}

export function useSessionPeek(options: SessionPeekOptions): SessionPeekBinding {
  const { ticketPrefix, now, rowOf, ticketOf, folders, onFolderToggle, ports } = options;
  const [state, rawDispatch] = React.useReducer(peekReducer, initialPeekState);
  const [position, setPosition] = React.useState<PeekPosition | null>(null);
  const [cardHeight, setCardHeight] = React.useState(0);
  const [pointerInside, setPointerInside] = React.useState(false);
  const [folderView, setFolderView] = React.useState<FolderPeekView>(FOLDER_PEEK_START);

  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const listRef = React.useRef<HTMLElement | null>(null);
  const dwellTimer = React.useRef<number | null>(null);
  const graceTimer = React.useRef<number | null>(null);
  const focusReturn = React.useRef<HTMLElement | null>(null);
  const pendingFocus = React.useRef<string | null>(null);
  const rowKeys = React.useRef<SessionPeekRowKeyHandler | null>(null);

  const kindOf = React.useCallback((rowId: string) => rowOf(rowId)?.kind, [rowOf]);

  /**
   * The one gate `canPinRow` needs: every route to a pin — the card's button,
   * Space on an open peek, ⌘. — arrives here as a `pin` event.
   */
  const dispatch = React.useCallback(
    (event: PeekEvent) => {
      if (event.type === "pin" && !canPinRow(event.target.rowId, kindOf)) return;
      rawDispatch(event);
    },
    [kindOf],
  );

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
    (target: PeekTarget, delay: number) => {
      clearDwell();
      dwellTimer.current = window.setTimeout(() => {
        dispatch({ type: "dwell-elapsed", target, now: Date.now() });
      }, delay);
    },
    [clearDwell, dispatch],
  );

  /** The bridge: closing waits out the gap between row and card. */
  const armGrace = React.useCallback(() => {
    clearGrace();
    graceTimer.current = window.setTimeout(() => {
      dispatch({ type: "grace-elapsed" });
    }, PEEK_GRACE_MS);
  }, [clearGrace, dispatch]);

  React.useEffect(
    () => () => {
      clearDwell();
      clearGrace();
    },
    [clearDwell, clearGrace],
  );

  /* ------------------------------------------------------------- the subject */

  const subject = React.useMemo(
    () => (shown === null ? null : peekSubjectOf(shown.rowId, folders, folderView)),
    [folderView, folders, shown],
  );
  const subjectRowId = subject?.kind === "session" ? subject.rowId : null;
  const subjectRow = subjectRowId === null ? undefined : rowOf(subjectRowId);
  const sessionId = subjectRow?.sessionId ?? null;
  const content = usePeekContent(sessionId, ports.readContent, subjectRow?.at ?? 0);

  /**
   * A peek's subject can leave the listing under it: the Session ends and moves
   * band, its ticket's folder empties, the rail switches ticket. The card then
   * renders nothing while `shown` stays set — and `shown !== null` is the hold
   * (D7), so an unresolvable subject froze the order of BOTH sidebars with no
   * pointer anywhere and no way back. A peek about nothing closes itself.
   */
  const subjectResolved =
    shown === null ||
    (subject !== null &&
      (subject.kind === "session"
        ? rowOf(subject.rowId) !== undefined
        : ticketOf(subject.ticketId) !== undefined));

  React.useEffect(() => {
    if (subjectResolved) return;
    // A drilled card whose Session is gone must leave the folder peekable again.
    setFolderView(FOLDER_PEEK_START);
    dispatch({ type: "subject-gone" });
  }, [dispatch, subjectResolved]);

  /**
   * §3.3 — a PIN adopts the Session, and the form is the resident projection's.
   *
   * The pulled `content.question` is one fold, taken once; it is the unpinned
   * preview line and nothing more. Once pinned, the question the card offers is
   * the live one the chat plane would show (`interactions.active`), so a question
   * answered in its own tab or cancelled by the runtime leaves the card at the
   * same instant it leaves the chat rather than presenting a form for a decision
   * nobody is waiting on. `ports.answer` still refuses the race it cannot see
   * coming, and the card keeps the words for it.
   */
  const adoptChatSession = useChatSessionsStore((store) => store.adoptChatSession);
  const pinnedSessionId = state.pinned === null ? null : sessionId;
  React.useEffect(() => {
    if (pinnedSessionId === null) return;
    adoptChatSession(pinnedSessionId);
  }, [adoptChatSession, pinnedSessionId]);
  const residentQuestion = useChatSessionsStore((store) =>
    pinnedSessionId === null
      ? null
      : (store.sessions[pinnedSessionId]?.projection?.interactions.active[0] ?? null),
  );

  /* ----------------------------------------------------- dismissal & scroll */

  const dismiss = React.useCallback(
    (reason: "click-away" | "list-scroll" | "pointer-down") => {
      dispatch({ type: "dismiss", reason, now: Date.now() });
    },
    [dispatch],
  );

  /** The scroller the shown row lives in — the clamp, and what a scroll dismisses. */
  const scrollerOf = React.useCallback((): HTMLElement | null => {
    if (shown === null) return null;
    const row = peekRowElement(shown);
    return row === null ? null : peekScrollerOf(listRef.current, row);
  }, [shown]);

  /**
   * A scroll of the real scroller dismisses (D1).
   *
   * Native and capturing, for two reasons React's `onScroll` cannot satisfy:
   * scroll events do not bubble, so a handler spread on a wrapper never hears
   * the element below it, and capture on the scroller also hears a scroller
   * nested inside it.
   */
  React.useEffect(() => {
    if (shown === null) return;
    const scroller = scrollerOf();
    if (scroller === null) return;
    const onScroll = () => dismiss("list-scroll");
    scroller.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => scroller.removeEventListener("scroll", onScroll, { capture: true });
  }, [dismiss, scrollerOf, shown]);

  React.useEffect(() => {
    if (shown === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target;
      if (!(node instanceof Element)) return;
      // A press inside the card or on a row is handled where it happened.
      if (node.closest("[data-peek-card], [data-peek-row]") !== null) return;
      dismiss("click-away");
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [dismiss, shown]);

  /** The drilled card's first rung of the Escape ladder is the ticket it came from. */
  const back = React.useCallback(() => {
    pendingFocus.current = `[data-peek-drill="${folderView.drill ?? ""}"]`;
    setFolderView(FOLDER_PEEK_START);
  }, [folderView.drill]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearDwell();
        clearGrace();
        if (folderView.drill !== null) {
          back();
          return;
        }
        // A reducer focus label is not DOM focus. Move out of the field only on
        // Escape; clicking elsewhere must never pull focus back here.
        if (state.focus === "field") {
          cardRef.current?.focus();
          return;
        }
        dispatch({ type: "escape", now: Date.now() });
        return;
      }
      // ⌘. pins whatever the peek is showing — the pointer path's way into
      // answering without moving the hand to a button.
      if (event.key === "." && (event.metaKey || event.ctrlKey) && shown !== null) {
        event.preventDefault();
        dispatch({ type: "pin", target: shown });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [back, clearDwell, clearGrace, dispatch, folderView.drill, shown, state.focus]);

  /* ------------------------------------------------------------- pointer in */

  const rowPointerMove = React.useCallback(
    (surface: PeekSurface) => (event: React.PointerEvent<HTMLElement>) => {
      listRef.current = event.currentTarget;
      setPointerInside(true);
      const rowId = rowIdOf(event.target);
      const target: PeekTarget | null = rowId === undefined ? null : { rowId, surface };
      if (target === null || !canPeekRow(target.rowId)) {
        // Between rows, over a band's header, or on a row with no peek (a Chat
        // Draft): to the peek that is empty space, so leaving the last peekable
        // row for it starts the bridge exactly once.
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
        armDwell(target, state.shown === null ? PEEK_DWELL_MS : PEEK_WARM_DWELL_MS);
      }
    },
    [armDwell, armGrace, clearDwell, clearGrace, dispatch, state.hovered, state.shown],
  );

  const rowPointerLeave = React.useCallback(() => {
    setPointerInside(false);
    clearDwell();
    dispatch({ type: "hover-leave-row" });
    armGrace();
  }, [armGrace, clearDwell, dispatch]);

  /* ------------------------------------------------------------- keyboard */

  const step = React.useCallback((event: React.KeyboardEvent<HTMLElement>, delta: number) => {
    const list = event.currentTarget;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-peek-row]")];
    const from = (event.target as HTMLElement).closest<HTMLElement>("[data-peek-row]");
    const index = from === null ? -1 : rows.indexOf(from);
    event.preventDefault();
    const next = rows[clamp(index + delta, 0, rows.length - 1)];
    // The list's focus handler arms the keyboard dwell for every route into a
    // row — Tab, arrow keys, or J/K.
    peekRowButton(next ?? null)?.focus();
  }, []);

  const onListKeyDown = React.useCallback(
    (surface: PeekSurface) => (event: React.KeyboardEvent<HTMLElement>) => {
      const activeRow = (event.target as HTMLElement).closest<HTMLElement>("[data-peek-row]");
      const rowId = activeRow?.dataset.peekRow;
      // The surface's own keys first: a folder's ← / → are its disclosure, not
      // the peek's business.
      if (rowId !== undefined && rowKeys.current?.(event, { rowId, surface }) === true) return;

      // J/K step whatever the Shift key is doing, exactly as the left band's own
      // `session-band-keys.ts` reads them: a capital is the same request.
      if (event.key === "ArrowDown" || event.key === "j" || event.key === "J") {
        return step(event, 1);
      }
      if (event.key === "ArrowUp" || event.key === "k" || event.key === "K") {
        return step(event, -1);
      }
      if (rowId === undefined) return;
      const target: PeekTarget = { rowId, surface };
      const row = rowOf(rowId);
      const ticketId = folderTicketId(rowId);

      // A folder's caret, from the keyboard (D8). Pressing it asks for the rows
      // inline, and a card describing them beside the rows themselves would be
      // the same list twice — so the folder's peek goes (D2). The surface's own
      // handler above knows whether the folder is open and answers first where
      // it does; this is the fallback for a surface that registered none.
      if (ticketId !== null && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
        event.preventDefault();
        onFolderToggle?.(ticketId);
        dismiss("click-away");
        return;
      }

      // U toggles read wherever a Session row has focus (D6). Not a peek: a
      // deliberate key, and the only read this hook ever asks for.
      if ((event.key === "u" || event.key === "U") && row?.sessionId != null) {
        event.preventDefault();
        ports.setRead(row.sessionId, !row.unread);
        return;
      }
      if (!canPeekRow(rowId)) return;

      if (event.key === " ") {
        event.preventDefault();
        clearDwell();
        // Space opens; Space again on an open peek pins it (or, for a folder,
        // moves into its card).
        if (sameTarget(state.shown, target)) {
          if (canPinRow(rowId, kindOf)) dispatch({ type: "pin", target });
          else cardRef.current?.focus();
        } else {
          dispatch({ type: "hover-row", target });
          dispatch({ type: "open-now", target, now: Date.now() });
        }
      }
    },
    [clearDwell, dismiss, dispatch, kindOf, onFolderToggle, ports, rowOf, state.shown, step],
  );

  /* -------------------------------------------------------- focus, in & out */

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
  }, [clearDwell, pinnedRowId, state.focus]);

  /**
   * A drill swaps the card's element out from under the pointer, and neither
   * pointerenter nor focus follows it there. Put focus where the reader's next
   * press belongs, which also re-enters the card's half of the bridge.
   */
  React.useLayoutEffect(() => {
    const selector = pendingFocus.current;
    if (selector === null) return;
    pendingFocus.current = null;
    const card = cardRef.current;
    (card?.querySelector<HTMLElement>(selector) ?? card)?.focus();
  });

  /* ------------------------------------------------------------- geometry */

  const measure = React.useCallback(() => {
    if (shown === null) {
      setPosition(null);
      return;
    }
    const row = peekRowElement(shown);
    if (row === null) return;
    // The clamp is the box the rows move inside, so a row scrolled half out of
    // the list does not take its card past the list's edge. A list that does not
    // scroll clamps to itself, and a row with neither clamps to the row.
    const container = scrollerOf() ?? listRef.current ?? row;
    setPosition(
      positionPeek({
        row: row.getBoundingClientRect(),
        container: container.getBoundingClientRect(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        surface: shown.surface,
        cardHeight,
        cardWidth: PEEK_CARD_WIDTH,
      }),
    );
  }, [cardHeight, scrollerOf, shown]);

  React.useLayoutEffect(measure, [measure]);

  React.useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  /** Measure the border box before paint; observing a clipped content box loses 2px. */
  const hasCard = shown !== null && position !== null;
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
  }, [hasCard, pinnedRowId, subjectRowId]);

  /* ----------------------------------------------------------- the folder card */

  const folderRowIds = subject?.kind === "ticket" ? subject.sessionRowIds : EMPTY_ROWS;
  const summaries = useFolderSummaries(folderRowIds, ports.readContent, peekSummaryLine);

  /* ------------------------------------------------------------------ card */

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

  let card: React.ReactNode = null;
  if (shown !== null && subject !== null && position !== null) {
    if (subject.kind === "ticket") {
      const ticket = ticketOf(subject.ticketId);
      if (ticket !== undefined) {
        const sessions: TicketPeekSession[] = subject.sessionRowIds.flatMap((rowId) => {
          const row = rowOf(rowId);
          if (row === undefined) return [];
          return [
            {
              rowId,
              title: row.title,
              age: row.at === null ? "" : compactAge(row.at, now),
              summary: summaries.get(rowId) ?? null,
              glyph: (
                <SessionGlyph
                  providerId={row.providerId}
                  providerLabel={row.providerLabel}
                  state={row.state}
                  kind={row.kind}
                  name={row.providerLabel}
                  size="card"
                  surface="popover"
                />
              ),
            },
          ];
        });
        card = (
          <TicketPeekCard
            ref={cardRef}
            ticket={ticket}
            ticketPrefix={ticketPrefix}
            sessions={sessions}
            position={position}
            cardWidth={PEEK_CARD_WIDTH}
            onDrill={(rowId) => {
              pendingFocus.current = "[data-peek-strip] button";
              setFolderView({ drill: rowId });
            }}
            onOpenTicket={() => {
              ports.openTicket(subject.ticketId);
              dismiss("click-away");
            }}
            {...cardProps}
          />
        );
      }
    } else if (subjectRow !== undefined) {
      const via = subject.via;
      const folderTicket = via.kind === "row" ? undefined : ticketOf(via.ticketId);
      const rowId = subject.rowId;
      const answerTo = subjectRow.sessionId;
      card = (
        <SessionPeekCard
          ref={cardRef}
          row={subjectRow}
          ticketPrefix={ticketPrefix}
          now={now}
          content={content.content}
          loading={content.loading}
          failed={content.failed}
          position={position}
          cardWidth={PEEK_CARD_WIDTH}
          pinned={state.pinned !== null}
          // The live question once pinned (§3.3); the pull's own is the preview.
          activeQuestion={residentQuestion}
          back={
            folderTicket === undefined
              ? undefined
              : {
                  ticketLabel: displayTicketId(ticketPrefix, folderTicket.ticketNumber),
                  onBack: back,
                }
          }
          // A folder's card is read-only, and a terminal companion has nobody to
          // answer: one rule, in `canPinRow`.
          canReply={via.kind === "row" && canPinRow(rowId, kindOf)}
          onPin={() => dispatch({ type: "pin", target: { rowId, surface: shown.surface } })}
          onClose={() => dispatch({ type: "escape", now: Date.now() })}
          onOpen={() => {
            ports.openSession(rowId);
            dismiss("click-away");
          }}
          onViewConversation={() => {
            if (answerTo === null) return;
            ports.viewConversation(answerTo);
            dismiss("click-away");
          }}
          onAnswer={(interactionId, submission) =>
            answerTo === null
              ? Promise.resolve(false)
              : ports.answer(answerTo, interactionId, submission)
          }
          onSend={(text) =>
            answerTo === null ? Promise.resolve(false) : ports.sendMessage(answerTo, text)
          }
          {...cardProps}
        />
      );
    }
  }

  /* ------------------------------------------------------------- the binding */

  const rowProps = React.useCallback(
    (surface: PeekSurface) => ({
      onPointerMove: rowPointerMove(surface),
      onPointerLeave: rowPointerLeave,
      // CAPTURE, and never prevented: a row is a drag source.
      onPointerDownCapture: () => dismiss("pointer-down"),
      onKeyDown: onListKeyDown(surface),
      onFocusCapture: (event: React.FocusEvent<HTMLElement>) => {
        listRef.current = event.currentTarget;
        // A field inside a row is not the row: an inline rename must not open a
        // card over the name being typed.
        if (isEditableTarget(event.target)) return;
        const rowId = rowIdOf(event.target);
        if (rowId === undefined || !canPeekRow(rowId)) return;
        clearGrace();
        dispatch({ type: "hover-row", target: { rowId, surface } });
        armDwell({ rowId, surface }, PEEK_FOCUS_DWELL_MS);
      },
      onBlurCapture: (event: React.FocusEvent<HTMLElement>) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        clearDwell();
        dispatch({ type: "hover-leave-row" });
        armGrace();
      },
    }),
    [
      armDwell,
      armGrace,
      clearDwell,
      clearGrace,
      dismiss,
      dispatch,
      onListKeyDown,
      rowPointerLeave,
      rowPointerMove,
    ],
  );

  const registerRowKeys = React.useCallback((handler: SessionPeekRowKeyHandler) => {
    rowKeys.current = handler;
  }, []);

  return {
    rowProps,
    scrollProps: { onScroll: () => dismiss("list-scroll") },
    // PORTALLED to the body, never drawn where the surface mounts it. The card
    // is `position: fixed`, and fixed does not escape an ancestor's
    // `clip-path`: the framed shell clips the left sidebar at its right edge
    // (globals.css, `[data-volli-shell="framed"] [data-volli-sidebar]`), so a
    // card drawn inside it existed, took focus and hit-tests, and painted
    // nothing — found by the real-app probe (e2e/session-peek-shots.mjs), not
    // by jsdom, which has no clipping. React keeps its own tree through the
    // portal, so events still bubble to the surface exactly as before.
    card: card === null ? null : createPortal(card, document.body),
    // The hold (D7): a pointer in this surface, or any card open, freezes moves.
    holding: pointerInside || shown !== null,
    shownRowId: shown?.rowId ?? null,
    registerRowKeys,
  };
}

const EMPTY_ROWS: readonly string[] = [];

/** The folder card's one line per Session — the same fold the big card leads with. */
function peekSummaryLine(content: SessionPeekContent): string | null {
  return content.summary ?? peekSummaryOf(content.entries);
}
