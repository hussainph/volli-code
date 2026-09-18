/**
 * Keyboard entry into a ticket, and the way back out (VC-419).
 *
 * VC-322's built-app pass found both halves broken: Enter on a focused board
 * card or list row opened the ticket and dropped `document.activeElement` to
 * BODY, and Escape out of the ticket returned to the board with focus still on
 * BODY. The keys worked; nobody carried the focus across. For a keyboard-only
 * reader that is the whole journey lost — after one round trip there is no
 * "here" left to Tab from, and the board's fifty cards start again at the top.
 *
 * Neither half can be a React ref handed between the two surfaces, because they
 * are never mounted at the same time: `home-surface.tsx` swaps the board for
 * the detail view, and the board is rebuilt from scratch on the way back
 * (`column-window.ts` says so in as many words). So the journey is carried as
 * module state — an ORIGIN, recorded by identity plus its neighbourhood — and
 * each surface claims its half on mount:
 *
 *   • the ticket view takes the ENTRY request and puts focus on the primary
 *     tab strip's selected tab: a real control, with the ring every other tab
 *     has, whose Enter does nothing destructive (the heading's Enter opens the
 *     rename field, which is not what a reader asked for by opening a ticket);
 *   • the board takes the ORIGIN and puts focus back on the card or row it
 *     started from — or, when that ticket is gone, on the neighbour that took
 *     its place (`lib/ticket-focus-origin.ts` owns that decision).
 *
 * Three things this must not do, each of which is a guard below:
 *
 *   • steal focus. Every move is gated on focus being UNOWNED — body, or an
 *     element the unmount just detached. A person who clicked into the composer
 *     while the board was mounting keeps their caret.
 *   • assume the card is mounted. A board column mounts a window (VC-316), so
 *     the origin of a journey that started 50 cards down does not exist when
 *     the board comes back. The restore asks the board to REVEAL it (the
 *     column's own `scrollOffsetForRow`, the same path a selection takes) and
 *     keeps looking until it appears or the budget runs out.
 *   • run forever. Both waits are bounded, and both stop the moment anything
 *     else takes focus.
 *
 * Only a KEYBOARD open records an origin. A double-click leaves focus wherever
 * the pointer put it, and a mouse user who never had a focus ring should not
 * suddenly acquire one on the way back.
 */
import * as React from "react";

import { restoreFocusTarget, type TicketFocusOrigin } from "@renderer/lib/ticket-focus-origin";

/**
 * The attribute every focusable card and row carries (`ticket-card.tsx`), and
 * the only handle this module needs on either surface. An attribute rather than
 * a ref registry for the reason `tab-strip.tsx` gives about its tabs: the list
 * is a DOM fact, and a registry is a second copy of it to keep in sync.
 */
export const TICKET_FOCUS_ATTRIBUTE = "data-ticket-focus-id";

/** How long the ticket view waits for its tab strip before giving up. */
const ENTRY_BUDGET_MS = 1000;
/** How long the board waits for a card to mount — a reveal is a scroll, a recompute and a commit. */
const RESTORE_BUDGET_MS = 1500;
/** Between attempts. Short enough to feel immediate, long enough not to be a spin. */
const POLL_MS = 50;

/** The journey in flight, or `null`. Claimed by the board on its next mount. */
let pendingOrigin: TicketFocusOrigin | null = null;
/** The ticket a keyboard open is on its way INTO. Claimed by the detail view. */
let pendingEntry: { projectId: string; ticketId: string } | null = null;

/** Drop any journey in flight — used when a surface must not act on a stale one, and by tests. */
export function forgetTicketFocusOrigin(): void {
  pendingOrigin = null;
  pendingEntry = null;
}

/**
 * Every focusable card or row in the origin's own column or list section, in
 * drawn order.
 *
 * Scoped to the column rather than the whole board because a board's columns
 * are not one continuous list: the card after the last card of Todo is the
 * first card of Doing, which is nobody's idea of "the next one". Scoped to what
 * is MOUNTED, deliberately — a windowed column's neighbours are the ones a
 * person can see, and a neighbour is only ever needed when the origin itself
 * has just vanished from that same view.
 */
function siblingTicketIds(from: HTMLElement): string[] {
  const scope = from.closest("[data-board-column], [data-list-section]") ?? document;
  return [...scope.querySelectorAll<HTMLElement>(`[${TICKET_FOCUS_ATTRIBUTE}]`)].flatMap(
    (element) => {
      const id = element.getAttribute(TICKET_FOCUS_ATTRIBUTE);
      return id === null ? [] : [id];
    },
  );
}

/**
 * The card or row for one ticket, if it is mounted.
 *
 * Matched by reading the attribute rather than by building a selector: a ticket
 * id is generated, not authored, and a selector built from a value is one
 * escaping bug away from throwing inside a focus restore.
 */
function ticketFocusElement(ticketId: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(`[${TICKET_FOCUS_ATTRIBUTE}]`);
  for (const candidate of candidates) {
    if (candidate.getAttribute(TICKET_FOCUS_ATTRIBUTE) === ticketId) return candidate;
  }
  return null;
}

/** The selected tab of the ticket workspace's primary strip, or its first tab. */
function primaryTicketTab(): HTMLElement | null {
  const strip = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Ticket tabs"]');
  if (strip === null) return null;
  return (
    strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
    strip.querySelector<HTMLElement>('[role="tab"]')
  );
}

/**
 * Whether focus is nobody's — the document body, nothing at all, or an element
 * the surface that just unmounted took with it.
 *
 * This is the whole anti-theft rule. Both halves re-check it on every attempt,
 * not just the first, so a wait that is still running when a person clicks into
 * something stops rather than yanking them back out of it.
 */
function focusIsUnowned(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/**
 * Run `attempt` now and then every {@link POLL_MS} until it reports done, focus
 * is taken by something else, or the budget expires. Returns the canceller.
 */
function pollUntil(attempt: () => boolean, budgetMs: number, onStop: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const deadline = Date.now() + budgetMs;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    onStop();
  };
  const tick = () => {
    if (stopped) return;
    if (!focusIsUnowned() || attempt() || Date.now() >= deadline) {
      stop();
      return;
    }
    timer = setTimeout(tick, POLL_MS);
  };
  tick();
  return stop;
}

/**
 * Record where a keyboard open is leaving from, and ask the ticket view to take
 * focus when it arrives. Called from the card/row's own Enter handler, with the
 * element that had focus — which is also how the neighbourhood is read.
 */
export function rememberTicketFocusOrigin(
  projectId: string,
  ticketId: string,
  from: HTMLElement,
): void {
  const siblingIds = siblingTicketIds(from);
  pendingOrigin = { projectId, ticketId, siblingIds, index: siblingIds.indexOf(ticketId) };
  pendingEntry = { projectId, ticketId };
}

/**
 * The ticket view's half: put focus on the primary tab when this view was
 * opened from the keyboard. Mounted once by `ticket-detail.tsx`.
 *
 * Waits for the strip because a ticket that has to load its tabs is a ticket
 * whose strip is one commit away, and gives up quietly rather than chasing a
 * surface that never draws one.
 */
export function useTicketEntryFocus(projectId: string, ticketId: string): void {
  React.useEffect(() => {
    const entry = pendingEntry;
    if (entry === null || entry.projectId !== projectId || entry.ticketId !== ticketId) return;
    pendingEntry = null;
    if (!focusIsUnowned()) return;
    return pollUntil(
      () => {
        const tab = primaryTicketTab();
        if (tab === null) return false;
        // `preventScroll` for `tab-strip.tsx`'s reason: the strip owns its own
        // scroller and reveals its selected tab itself, while the browser's
        // scroll-into-view would walk every scrollable ancestor above it.
        tab.focus({ preventScroll: true });
        return true;
      },
      ENTRY_BUDGET_MS,
      () => {},
    );
  }, [projectId, ticketId]);
}

/**
 * The board's half: put focus back on the card or row the journey started from.
 * Mounted once by `board.tsx`, which supplies what it is currently SHOWING (so
 * a filtered-out origin resolves to a neighbour immediately rather than after a
 * wait) and a way to REVEAL a ticket its column has windowed out.
 */
export function useTicketFocusRestore({
  projectId,
  shownIds,
  onReveal,
}: {
  projectId: string;
  /** The ticket ids the board is drawing right now, filtered and in board order. */
  shownIds: readonly string[];
  /** Ask the owning column to scroll a ticket into its window; `null` releases the request. */
  onReveal: (ticketId: string | null) => void;
}): void {
  // Read live on every attempt rather than closed over: the restore outlives
  // several renders, and the set it must answer against is the current one.
  const shown = React.useRef(shownIds);
  shown.current = shownIds;
  const reveal = React.useRef(onReveal);
  reveal.current = onReveal;

  React.useEffect(() => {
    const origin = pendingOrigin;
    if (origin === null || origin.projectId !== projectId) return;
    // Claimed, whatever happens next: a journey is restored once, and a board
    // that cannot honour it must not leave it to fire on some later mount.
    pendingOrigin = null;
    pendingEntry = null;
    if (!focusIsUnowned()) return;

    let requested: string | null = null;
    return pollUntil(
      () => {
        const target = restoreFocusTarget(origin, shown.current);
        // Nothing of that neighbourhood is on this board — an emptied column, a
        // project switched underneath. Leave focus where it is.
        if (target === null) return true;
        const element = ticketFocusElement(target);
        if (element !== null) {
          element.focus();
          return true;
        }
        // Held by the column but not mounted: the window (VC-316) has it out.
        // Ask for it once, then keep watching for it to arrive.
        if (requested !== target) {
          requested = target;
          reveal.current(target);
        }
        return false;
      },
      RESTORE_BUDGET_MS,
      () => {
        if (requested !== null) reveal.current(null);
      },
    );
  }, [projectId]);
}
