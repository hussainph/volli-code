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
 * children and a pointer over a child must resolve to the child. The scroll
 * container may mark itself `data-peek-container`; without one the list the
 * handlers are spread on is the clamp (`peek-geometry.ts` takes real bounds).
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
import {
  displayTicketId,
  peekSummaryOf,
  type ModelSelection,
  type SessionPeekContent,
  type SessionProvenance,
  type Ticket,
} from "@volli/shared";
import type { InteractionSubmission } from "@volli/session-presentation";

import { SessionGlyph } from "@renderer/components/sessions/session-glyph";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { compactAge } from "@renderer/lib/relative-time";

import { clamp, PEEK_CARD_WIDTH, positionPeek, type PeekPosition } from "./peek-geometry";
import {
  initialPeekState,
  peekReducer,
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

function sameTarget(a: PeekTarget | null, b: PeekTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.rowId === b.rowId && a.surface === b.surface;
}

/** The scroll container a row is clamped to, or the list it was found in. */
function containerRectOf(row: HTMLElement, list: HTMLElement | null): DOMRect {
  const container = row.closest<HTMLElement>("[data-peek-container]") ?? list;
  return (container ?? row).getBoundingClientRect();
}

/**
 * The one line each Session in a folder's card shows.
 *
 * A folder card is the one surface that needs several folds at once, and it is
 * also the one where a row's own title says least ("Chat", three times). Each is
 * one pull, cached for the life of the mount, and started only once a folder's
 * card is actually on screen.
 */
function useFolderSummaries(
  rowIds: readonly string[],
  read: (sessionId: string) => Promise<SessionPeekContent | null>,
  summarise: (content: SessionPeekContent) => string | null,
): ReadonlyMap<string, string | null> {
  const [summaries, setSummaries] = React.useState<ReadonlyMap<string, string | null>>(new Map());
  const asked = React.useRef(new Set<string>());
  const key = rowIds.join("|");
  React.useEffect(() => {
    let live = true;
    for (const rowId of key === "" ? [] : key.split("|")) {
      const sessionId = peekSessionId(rowId);
      if (sessionId === null || asked.current.has(rowId)) continue;
      asked.current.add(rowId);
      void read(sessionId).then(
        (content) => {
          if (!live) return;
          const line = content === null ? null : summarise(content);
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

  /* ----------------------------------------------------- dismissal & scroll */

  const dismiss = React.useCallback(
    (reason: "click-away" | "list-scroll" | "pointer-down") => {
      dispatch({ type: "dismiss", reason, now: Date.now() });
    },
    [dispatch],
  );

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

      if (event.key === "ArrowDown" || event.key === "j") return step(event, 1);
      if (event.key === "ArrowUp" || event.key === "k") return step(event, -1);
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
    setPosition(
      positionPeek({
        row: row.getBoundingClientRect(),
        container: containerRectOf(row, listRef.current),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        surface: shown.surface,
        cardHeight,
        cardWidth: PEEK_CARD_WIDTH,
      }),
    );
  }, [cardHeight, shown]);

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
    card,
    // The hold (D7): a pointer in this surface, or any card open, freezes moves.
    holding: pointerInside || shown !== null,
    shownRowId: shown?.rowId ?? null,
    registerRowKeys,
  };
}

const EMPTY_ROWS: readonly string[] = [];

/** The folder card's one line per Session — the same fold the big card leads with. */
function peekSummaryLine(content: SessionPeekContent): string | null {
  return peekSummaryOf(content.entries);
}
