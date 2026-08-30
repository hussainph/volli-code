import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TICKET_STATUS_LABELS, type Label, type Ticket, type TicketStatus } from "@volli/shared";

import { columnDroppableId } from "@renderer/components/board/board-dnd";
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
  selectedId: string | null;
  onSelect(ticketId: string): void;
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
}

/** A single status column: header, its own vertically-scrolling ticket list, and an add-card composer. */
export function BoardColumn({
  status,
  tickets,
  projectId,
  ticketPrefix,
  projectLabels,
  selectedId,
  onSelect,
  onOpen,
  composerInitiallyOpen,
  onComposerClose,
  animateEnter,
  offered,
  dimmed = false,
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
      )}
    >
      <div className="group/column-header flex items-center gap-2 px-4 pt-2 pb-2">
        <span className="text-ui font-medium text-foreground">{TICKET_STATUS_LABELS[status]}</span>
        <Badge variant="count">{tickets.length}</Badge>
        <div className="flex-1" />
        {/* Arming lives on the column because that is what it is a property of
            (VC-112). Trailing, so an unarmed board's header reads exactly as it
            did before this existed. */}
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
            data-column-scroller={status}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            <div
              // Named so the split above is a fact a test can hold rather than a
              // shape a refactor can quietly undo — the two must never be the
              // same element again. See `board-column-dropzone.test.tsx`.
              data-column-dropzone={status}
              ref={setNodeRef}
              className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2"
            >
              {tickets.map((ticket) => (
                <TicketCard
                  key={ticket.id}
                  ticket={ticket}
                  projectId={projectId}
                  ticketPrefix={ticketPrefix}
                  projectLabels={projectLabels}
                  selected={ticket.id === selectedId}
                  sessionActivity={sessionActivity[ticket.id] ?? null}
                  onSelect={onSelect}
                  onOpen={onOpen}
                />
              ))}
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
}
