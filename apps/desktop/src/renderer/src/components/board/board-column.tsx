import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TICKET_STATUS_LABELS, type Label, type Ticket, type TicketStatus } from "@volli/shared";

import { columnDroppableId } from "@renderer/components/board/board-dnd";
import type { TicketSelectionGesture } from "@renderer/components/board/board-selection";
import {
  COLUMN_ROW_STRIDE_FALLBACK,
  COLUMN_WINDOW_MINIMUM,
  columnWindow,
  measuredRowStride,
  mergeColumnWindows,
  scrollOffsetForRow,
  shouldAdoptRowStride,
  type ColumnWindow,
} from "@renderer/components/board/column-window";
import { ColumnArmingButton } from "@renderer/components/board/column-arming";
import {
  ColumnOfferedPanel,
  type ColumnOfferedPanelProps,
} from "@renderer/components/board/column-offered-panel";
import { useBoardSessionActivityMap } from "@renderer/components/board/session-activity-context";
import { TicketCard } from "@renderer/components/board/ticket-card";
import { useTicketComposer } from "@renderer/components/board/use-ticket-composer";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

interface BoardColumnProps {
  status: TicketStatus;
  tickets: Ticket[];
  projectId: string;
  /** The board's owning project's ticket prefix — constant for the whole board tree. */
  ticketPrefix: string;
  /** The board's owning project's label rows — constant for the whole board tree. */
  projectLabels: readonly Label[];
  selectedIds: readonly string[];
  draggingIds: readonly string[];
  /** Payload shared by every selected card; unselected cards advertise only themselves. */
  groupDragIds: readonly string[];
  onSelect(ticketId: string, gesture: TicketSelectionGesture): void;
  /** Double-click opens the ticket's full-page detail view (ticket-detail-mvp step 3). */
  onOpen(ticketId: string): void;
  composerInitiallyOpen: boolean;
  onComposerClose(status: TicketStatus): void;
  /** Play the enter transition — true for columns appearing on an already-mounted board. */
  animateEnter: boolean;
  /**
   * This column's Offered list, mid-drag (VC-132) — absent when there is
   * nothing to show here, which is every column at rest and every column the
   * pointer is not over.
   */
  offered?: ColumnOfferedPanelProps;
  /** Quieted because another column is currently grown into landing targets. */
  dimmed?: boolean;
  /** The frozen drag snapshot currently resolves its release into this column. */
  aimed?: boolean;
  /**
   * A card is in the air somewhere on the board (VC-316).
   *
   * The window only ever GROWS while this is true — see `mergeColumnWindows`
   * for why unmounting a droppable mid-gesture is the one thing this column is
   * not allowed to do.
   */
  dragActive?: boolean;
}

/** The column list's `gap-2`, in px — the spacers have to account for it. */
const COLUMN_ROW_GAP = 8;

/**
 * Which slice of `tickets` this column mounts, tracked against its scroller.
 *
 * State rather than a ref because the render depends on it, and it is written
 * only when the answer actually CHANGES: a wheel gesture that moves the column
 * by four pixels resolves to the same window and does not re-render anything.
 */
function useColumnWindow({
  count,
  selectedIndex,
  dragActive,
  scrollerRef,
  listRef,
}: {
  count: number;
  selectedIndex: number;
  dragActive: boolean;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
}): { window: ColumnWindow; rowStride: number } {
  const [rowStride, setRowStride] = React.useState(COLUMN_ROW_STRIDE_FALLBACK);
  const [range, setRange] = React.useState<ColumnWindow>(() => ({
    first: 0,
    last: Math.min(count, COLUMN_WINDOW_MINIMUM),
  }));
  // Read inside the scroll handler, which must not be re-bound on every one of
  // these changing — a listener re-registered per commit is its own cost, and
  // the handler wants the LATEST value rather than the one it closed over.
  const strideRef = React.useRef(rowStride);
  strideRef.current = rowStride;
  const dragRef = React.useRef(dragActive);
  dragRef.current = dragActive;
  const countRef = React.useRef(count);
  countRef.current = count;

  const recompute = React.useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const next = columnWindow({
      count: countRef.current,
      scrollTop: scroller.scrollTop,
      viewportHeight: scroller.clientHeight,
      rowStride: strideRef.current,
    });
    setRange((previous) => {
      const merged = dragRef.current ? mergeColumnWindows(previous, next) : next;
      return merged.first === previous.first && merged.last === previous.last ? previous : merged;
    });
  }, [scrollerRef]);

  // Scroll and resize are the two things that move the window, and both are
  // the scroller's own. `passive` because nothing here ever cancels a scroll.
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    scroller.addEventListener("scroll", recompute, { passive: true });
    const observer = new ResizeObserver(recompute);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", recompute);
      observer.disconnect();
    };
  }, [scrollerRef, recompute]);

  // The column's content changed under a fixed scroll offset — a filter, a
  // drop, an agent moving a ticket. Recomputed in a LAYOUT effect so the first
  // painted frame after the change already holds the right cards.
  React.useLayoutEffect(() => {
    recompute();
  }, [count, dragActive, recompute]);

  // Learn the real row height from whatever is mounted. The measurement reads
  // the slots the previous commit painted, so it can only ever refine an
  // estimate — it never gates the first render on a measurement.
  //
  // Re-run on the window or the count moving, which is exactly when the
  // mounted SET changed and there is something new to learn. The write it can
  // make feeds back into `range`, so the deadband in `shouldAdoptRowStride` is
  // what stops measure → write → measure from becoming a loop.
  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const heights = [...list.querySelectorAll<HTMLElement>("[data-board-ticket-slot]")].map(
      (slot) => slot.offsetHeight,
    );
    const measured = measuredRowStride(heights, COLUMN_ROW_GAP);
    if (measured === null || !shouldAdoptRowStride(strideRef.current, measured)) return;
    strideRef.current = measured;
    setRowStride(measured);
    recompute();
  }, [range, count, listRef, recompute]);

  // Selected-item visibility. A selection made somewhere else — the sidebar, a
  // nav step, a drop landing under a non-manual sort — can name a row outside
  // the window; bring the COLUMN to it rather than widening the window to
  // reach it (see `scrollOffsetForRow`). Keyed on the index alone, so clicking
  // a card already on screen never moves anything: on an unwindowed column the
  // window is the whole list and this is a permanent no-op.
  const lastScrolledTo = React.useRef(selectedIndex);
  React.useLayoutEffect(() => {
    if (selectedIndex === lastScrolledTo.current) return;
    lastScrolledTo.current = selectedIndex;
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const offset = scrollOffsetForRow({
      index: selectedIndex,
      window: range,
      rowStride: strideRef.current,
      viewportHeight: scroller.clientHeight,
      maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
    });
    if (offset === null) return;
    scroller.scrollTop = offset;
    recompute();
  }, [selectedIndex, range, scrollerRef, recompute]);

  // Clamped at the edge rather than trusted: `count` can shrink between a
  // scroll event and the commit that reads this (a filter keystroke, an agent
  // moving a ticket out), and a slice past the end would silently mount less
  // than the window claims.
  const bounded: ColumnWindow = {
    first: Math.max(0, Math.min(range.first, count)),
    last: Math.max(0, Math.min(range.last, count)),
  };
  return { window: bounded, rowStride };
}

/**
 * A single status column: header, its own vertically-scrolling ticket list, and an add-card composer.
 *
 * Memoized so a board render is not, by itself, a render of every column. The
 * board re-renders for things that are about ONE column or none of them — the
 * ⌥ picker's hover, a drop target moving, a selection click — and every prop
 * here is either a primitive, a board-held memo (`tickets`, `selectedIds`,
 * `draggingIds`, `groupDragIds`) or a stable id-taking callback, so the memo
 * holds for every column the change did not name. `offered` is the one prop
 * built fresh per board render, and only for the column it is about, which is
 * exactly the column that has to redraw.
 */
export const BoardColumn = React.memo(function BoardColumn({
  status,
  tickets,
  projectId,
  ticketPrefix,
  projectLabels,
  selectedIds,
  draggingIds,
  groupDragIds,
  onSelect,
  onOpen,
  composerInitiallyOpen,
  onComposerClose,
  animateEnter,
  offered,
  dimmed = false,
  aimed = false,
  dragActive = false,
}: BoardColumnProps) {
  // ticketId → what is running on it; absent means nothing is (VC-100). Read
  // from the board's single derivation rather than handed down as a prop: the
  // provider hangs BELOW `Board`, so an output bump re-renders this column
  // without ever touching the `DndContext` above it (session-activity-context.tsx).
  // Each card still gets its own word as a plain string, so `TicketCard`'s memo
  // keeps holding for every card whose word did not change.
  const sessionActivity = useBoardSessionActivityMap();
  // The body is the column's droppable so cards can be dropped onto the empty
  // space below the list (or into a column emptied mid-drag).
  const { setNodeRef } = useDroppable({ id: columnDroppableId(status) });
  // `SortableContext` keys its context value on this array's identity, and every
  // `useSortable` card below reads that context — so a fresh array here
  // invalidates it for all of them. What that reaches is narrower than it reads:
  // `TicketCard`'s `React.memo` still holds (its props did not change), so what
  // re-renders is `SortableTicketShell` INSIDE it — the component that actually
  // calls `useContext` — while the card body it wraps is the same element object
  // and is skipped. `tickets` is the board's memoized sorted group, whose
  // identity board.tsx now holds across a drag-over for every column the drag
  // did not touch.
  const sortableIds = React.useMemo(() => tickets.map((ticket) => ticket.id), [tickets]);
  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds]);
  const draggingSet = React.useMemo(() => new Set(draggingIds), [draggingIds]);
  // Windowing (VC-316). The column HOLDS every ticket — `sortableIds` above is
  // still the complete list, so dnd-kit's index arithmetic, the count badge and
  // the filter results are all untouched — and MOUNTS the slice around the
  // scroll offset, with a spacer standing in for each end.
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  // The first selected card in THIS column; the window is widened to hold it.
  const selectedIndex = React.useMemo(
    () => tickets.findIndex((ticket) => selectedSet.has(ticket.id)),
    [tickets, selectedSet],
  );
  const attachList = React.useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  const { window: mountedRange, rowStride } = useColumnWindow({
    count: tickets.length,
    selectedIndex,
    dragActive,
    scrollerRef,
    listRef,
  });
  const mounted = tickets.slice(mountedRange.first, mountedRange.last);
  // A spacer stands for the rows above or below the window so the scroller's
  // range describes the whole column. `- gap` because the flex `gap-2` between
  // the spacer and the card beside it already supplies the last row's gap.
  const spacerHeight = (rows: number) => Math.max(0, rows * rowStride - COLUMN_ROW_GAP);
  const leadingRows = mountedRange.first;
  const trailingRows = tickets.length - mountedRange.last;
  const composer = useTicketComposer({
    projectId,
    status,
    initiallyOpen: composerInitiallyOpen,
    onClose: () => onComposerClose(status),
  });

  return (
    <div
      // The ⌥ picker's own hit test reads this: one `elementFromPoint` per
      // pointer move answers both which column is under the hand and which
      // panel row is (board.tsx's `pointerLanding`). It is on the column ROOT
      // so the panel floating over the list still reads as this column.
      data-board-column={status}
      data-drop-aimed={aimed || undefined}
      className={cn(
        // Cap below the canvas so a strip of background stays grab-able for
        // mouse drag-to-pan (see useBoardCanvasPan). Short columns still hug.
        // cursor-default overrides the canvas's cursor-grab so only empty
        // background reads as a pan surface.
        "flex min-h-0 max-h-[85%] w-72 flex-none cursor-default flex-col rounded-lg bg-muted/30",
        // Enter is an opacity fade ONLY, and so is the dim below it. This
        // column hosts droppables that dnd-kit measures in synchronous layout
        // effects; a scale mid-flight returns a different rect on every commit
        // and measureRects loops to React's max update depth (the DndContext
        // crash). Nothing here may animate anything a rect is read from — the
        // 0.98 entrance died for that, and the ⌥ picker's own panel floats
        // over the list rather than growing inside it for the same reason.
        "transition-[opacity] duration-200 ease-out motion-reduce:transition-none",
        animateEnter && "starting:opacity-0",
        // Quieted while another column holds the ⌥ picker: one column is being
        // aimed at, and the rest are not the question.
        dimmed && "opacity-50",
        // The board's card order and parentage stay frozen during the gesture
        // to keep dnd-kit measurement stable. This paint-only ring replaces the
        // old reparented-card gap as explicit cross-column landing feedback.
        aimed && "bg-accent/50 ring-1 ring-inset ring-primary/50",
      )}
    >
      <div className="group/column-header flex items-center gap-2 px-4 pt-2 pb-2">
        <span className="text-ui font-medium text-foreground">{TICKET_STATUS_LABELS[status]}</span>
        <Badge variant="count">{tickets.length}</Badge>
        <div className="flex-1" />
        {/* Arming lives on the column because that is what it is a property of
            (VC-112). Always visible so an unarmed column still offers an
            obvious way to configure what happens on arrival. */}
        <ColumnArmingButton projectId={projectId} status={status} />
      </div>
      {/* The panel floats OVER the list rather than sitting above it in the
          flow: the list below is this column's droppable, and a panel that
          grew and shrank in the layout would move its measured rect every time
          ⌥ went down — the mid-flight rect change the enter transition above
          is already scarred by. See `column-offered-panel.tsx`. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {offered === undefined ? null : (
          <div className="absolute inset-x-2 top-0 z-20">
            <ColumnOfferedPanel {...offered} />
          </div>
        )}
        {/* The SCROLL CONTAINER is the droppable's PARENT, never the droppable
            itself (VC-221). dnd-kit answers `getScrollableAncestors` by walking
            up from a node and EXCLUDING that node, so while this element was
            both, a card and the column holding it disagreed about their own
            ancestry: a card's list scrolls, so it counted three ancestors
            (list, canvas, document) where its column counted two.

            `over` flips between a card and its column on ordinary pointer
            travel, and each flip handed `useRects` an `elements` array of a
            different LENGTH — the first thing `sameMeasuredRects` checks, so
            the patch's guard could not absorb it. The new state moved
            `scrollAdjustedTranslate`, which moved `collisionRect`, which
            flipped `over` straight back: a closed cycle that reached React's
            nested-update limit in one commit chain and took the board out
            through `BoardBoundary` (error #185, `Maximum update depth
            exceeded`). It needed no modifier — ⌥ was how it was noticed, not
            why it happened.

            Split, both nodes resolve to the SAME three ancestors, so a flip
            measures identical rects, `setRects` bails, and the cycle has
            nothing to feed it. The scroll behaviour is unchanged: this element
            carries the overflow and the cap, exactly as the merged one did. */}
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <div
            ref={scrollerRef}
            data-column-scroller={status}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            <div
              // Named so the split above is a fact a test can hold rather than a
              // shape a refactor can quietly undo — the two must never be the
              // same element again. See `board-column-dropzone.test.tsx`.
              data-column-dropzone={status}
              // What this column HOLDS and what it currently MOUNTS (VC-316).
              // Published because the two are no longer the same number and
              // every reader outside React — the performance harness's mounted
              // count, the board smokes' readiness — needs to ask for the one
              // it means rather than counting cards and hoping.
              data-column-count={tickets.length}
              data-column-mounted={mounted.length}
              // ONE stable callback, never an inline arrow. React calls a ref
              // callback whose identity changed with `null` and then with the
              // node, so an inline one would unregister and re-register this
              // droppable with dnd-kit on every render of the column — and a
              // droppable node changing underneath a live drag is the
              // measurement churn that took this board out once already
              // (VC-221, see the note above the scroller).
              ref={attachList}
              className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2"
            >
              {leadingRows > 0 ? (
                <div
                  aria-hidden
                  data-column-spacer="leading"
                  style={{ height: spacerHeight(leadingRows) }}
                />
              ) : null}
              {mounted.map((ticket) => (
                <TicketCard
                  key={ticket.id}
                  ticket={ticket}
                  projectId={projectId}
                  ticketPrefix={ticketPrefix}
                  projectLabels={projectLabels}
                  selected={selectedSet.has(ticket.id)}
                  dragHidden={draggingSet.has(ticket.id)}
                  dragTicketIds={selectedSet.has(ticket.id) ? groupDragIds : undefined}
                  sessionActivity={sessionActivity[ticket.id] ?? null}
                  onSelect={onSelect}
                  onOpen={onOpen}
                />
              ))}
              {trailingRows > 0 ? (
                <div
                  aria-hidden
                  data-column-spacer="trailing"
                  style={{ height: spacerHeight(trailingRows) }}
                />
              ) : null}
            </div>
          </div>
        </SortableContext>
      </div>
      {composer.open ? (
        <div className="mx-2 mb-2 rounded-lg border border-border bg-card px-4 py-2">
          <input
            ref={composer.inputRef}
            autoFocus
            value={composer.title}
            onChange={(event) => composer.setTitle(event.target.value)}
            onKeyDown={composer.handleKeyDown}
            onBlur={composer.handleBlur}
            placeholder="Ticket title…"
            className="w-full border-none bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      ) : (
        <Button
          variant="ghost"
          onClick={composer.openComposer}
          className="mx-2 mb-2 justify-start gap-1 text-ui text-muted-foreground"
        >
          <PlusIcon className="size-3.5" />
          New
        </Button>
      )}
    </div>
  );
});
