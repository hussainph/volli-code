import * as React from "react";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { motion } from "motion/react";
import {
  EMPTY_TICKET_FILTER,
  filterTickets,
  groupTicketsByStatus,
  moveTicket,
  sortTickets,
  TICKET_STATUSES,
  type Label,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import {
  isTicketDragData,
  resolveDrop,
  resolveGroupDrop,
  ticketPosition,
  type DropTarget,
} from "@renderer/components/board/board-dnd";
import { BoardColumn } from "@renderer/components/board/board-column";
import { BoardEmpty } from "@renderer/components/board/board-empty";
import { BoardHeader } from "@renderer/components/board/board-header";
import { BoardListView, TicketRowContent } from "@renderer/components/board/board-list-view";
import {
  ticketSelectionAfterClick,
  type TicketSelectionGesture,
} from "@renderer/components/board/board-selection";
import { CollapsedColumnRail } from "@renderer/components/board/collapsed-column-rail";
import {
  BoardSessionActivityProvider,
  useTicketActivity,
} from "@renderer/components/board/session-activity-context";
import { TicketCardContent } from "@renderer/components/board/ticket-card";
import { TicketDialogHost } from "@renderer/components/board/ticket-dialog-host";
import { useBoardCanvasPan } from "@renderer/hooks/use-board-canvas-pan";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { isEscapeExempt } from "@renderer/lib/escape-guard";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * Everything alive only while a card is mid-drag. A one-card preview mutates
 * its local snapshot via the shared moveTicket op; a group deliberately leaves
 * measured source rects still and previews in the detached overlay (see
 * handleDragOver). Either way the store is written exactly once on drop, and
 * cancel discards the state. Column topology is frozen at drag start.
 */
interface DragState {
  activeTicket: Ticket;
  tickets: Ticket[];
  ticketIds: string[];
  preview: Ticket[];
  hiddenAtStart: TicketStatus[];
  /** Final slot in the preview, ready for the atomic persistence call. */
  drop: DropTarget | null;
}

// Precise pointer hits first (narrow collapsed pills, tall columns), corner
// proximity as the fallback for fast flicks where the pointer sits between
// rects — dnd-kit's own multi-container recipe.
const boardCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCorners(args);
};

// Stable fallbacks for a project with no ticket/label record yet — an inline
// `?? []` would mint a fresh array identity every render and defeat the memos
// below. Never mutated (every board op is pure); `EMPTY_TICKETS` is typed
// mutable to match the store's slice type.
const EMPTY_TICKETS: Ticket[] = [];
const EMPTY_LABELS: readonly Label[] = [];
const NO_STATUSES: readonly TicketStatus[] = [];
const NO_TICKET_IDS: readonly string[] = [];

function ticketSlotElement(ticketId: string): HTMLElement | null {
  const slots = document.querySelectorAll<HTMLElement>("[data-board-ticket-slot]");
  return [...slots].find((slot) => slot.dataset.boardTicketSlot === ticketId) ?? null;
}

/**
 * Whether two already-sorted columns hold exactly the same tickets in the same
 * order. Identity per element, never deep: every board op is pure and
 * `moveTicket` re-emits an untouched column's tickets BY REFERENCE, so an
 * unchanged ticket is the same object and a `!==` here is a real change.
 */
function sameColumn(previous: readonly Ticket[], next: readonly Ticket[]): boolean {
  return previous.length === next.length && previous.every((ticket, i) => ticket === next[i]);
}

/**
 * The lifted card (or row) under the pointer.
 *
 * A component at module scope rather than JSX inline in the overlay, because it
 * is the one piece of the drag that still has to READ session activity: the
 * board no longer holds that map. Declared out here and never inside `Board` so
 * its type identity is fixed — a component minted during a render remounts its
 * whole subtree every time, which is the exact class of churn the provider
 * exists to stop.
 */
const CLUSTER_SPRING = { type: "spring", duration: 0.5, bounce: 0.2 } as const;

function DragOverlayBody({
  activeTicket,
  tickets,
  ticketPrefix,
  projectLabels,
  listView,
  reducedMotion,
}: {
  activeTicket: Ticket;
  tickets: readonly Ticket[];
  ticketPrefix: string;
  projectLabels: readonly Label[];
  listView: boolean;
  reducedMotion: boolean;
}) {
  const sessionActivity = useTicketActivity(activeTicket.id);
  // Two backing surfaces are enough to communicate "a stack"; the count badge
  // carries the exact size without mounting an unbounded overlay subtree.
  const backing = tickets.filter((ticket) => ticket.id !== activeTicket.id).slice(0, 2);

  const content = (ticket: Ticket, active: boolean) =>
    listView ? (
      <div className="overflow-hidden rounded-md bg-card shadow-card">
        <TicketRowContent
          ticket={ticket}
          ticketPrefix={ticketPrefix}
          projectLabels={projectLabels}
          sessionActivity={active ? sessionActivity : null}
        />
      </div>
    ) : (
      <div className="rounded-lg shadow-card">
        <TicketCardContent
          ticket={ticket}
          ticketPrefix={ticketPrefix}
          projectLabels={projectLabels}
          sessionActivity={active ? sessionActivity : null}
        />
      </div>
    );

  return (
    <div className="relative cursor-grabbing">
      {backing.toReversed().map((ticket, index) => {
        // Spacing-ladder geometry: the cards begin one component inset apart,
        // then cluster to one 4px step. Only transform + opacity animate.
        const depth = backing.length - index;
        const clusteredOffset = depth * 4;
        const spreadOffset = depth * 16;
        return (
          <motion.div
            key={ticket.id}
            aria-hidden
            className="absolute inset-0"
            initial={
              reducedMotion
                ? false
                : {
                    opacity: 0,
                    transform: `translate3d(${spreadOffset}px, ${spreadOffset}px, 0)`,
                  }
            }
            animate={{
              opacity: 0.7,
              transform: `translate3d(${clusteredOffset}px, ${clusteredOffset}px, 0)`,
            }}
            transition={CLUSTER_SPRING}
          >
            {content(ticket, false)}
          </motion.div>
        );
      })}
      <div className="relative">{content(activeTicket, true)}</div>
      {tickets.length > 1 ? (
        <motion.span
          className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-primary text-ui font-medium text-primary-foreground shadow-raised"
          initial={reducedMotion ? false : { opacity: 0, transform: "scale(0.95)" }}
          animate={{ opacity: 1, transform: "scale(1)" }}
          transition={CLUSTER_SPRING}
          aria-label={`${tickets.length} tickets selected`}
        >
          {tickets.length}
        </motion.span>
      ) : null}
    </div>
  );
}

/**
 * The kanban board: columns scroll vertically; the canvas pans horizontally.
 *
 * Memoized, and the two string props are why it can be: the board is the largest
 * subtree in the window and it hangs under `AppShell`, which re-renders on app
 * chrome state — including `sidebarWidth`, written on every pointermove of the
 * resize grip. Memo blocks parent-driven renders only, never a hook's own
 * update, so the board's store subscriptions behave exactly as before.
 *
 * Honest about what this does NOT buy: profiling a 150-ticket board during a
 * sidebar drag showed the per-card `React.memo`s were ALREADY holding — the
 * cards themselves did not re-render either way. What scaled with ticket count
 * was the Radix machinery under each card, and the dialog half of that is gone
 * (see `TicketDialogHost`); the context menu each card must keep is the rest.
 * This is a cheap correct boundary, not the fix for either.
 */
export const Board = React.memo(function Board({
  projectId,
  ticketPrefix,
}: {
  projectId: string;
  ticketPrefix: string;
}) {
  const storeTickets = useBoardStore((state) => state.ticketsByProject[projectId]) ?? EMPTY_TICKETS;
  const filter = useBoardStore((state) => state.filterByProject[projectId]) ?? EMPTY_TICKET_FILTER;
  // One store subscription for the whole board rather than one per visible card
  // — the same reasoning that already made `ticketPrefix` a prop: a board only
  // ever shows one project, so its label rows are constant for the whole tree
  // and every card was subscribing to the identical slice.
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]) ?? EMPTY_LABELS;
  // View mode and sort are per-workspace, session-only (same pattern as
  // use-active-nav.ts): fall back to the shared default for never-visited projects.
  const boardView = useWorkspaceStore(
    (state) => state.byProject[projectId]?.boardView ?? DEFAULT_WORKSPACE_UI.boardView,
  );
  const boardSort = useWorkspaceStore(
    (state) => state.byProject[projectId]?.boardSort ?? DEFAULT_WORKSPACE_UI.boardSort,
  );
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const pendingSlotAnimation = React.useRef<Map<string, DOMRect> | null>(null);
  // Selection is store-backed (session-only), so sidebar/detail navigation can
  // still collapse it to one card while board gestures may hold several.
  const selectedIds = useBoardStore((state) => state.selectedByProject[projectId]) ?? NO_TICKET_IDS;
  const selectTicket = useBoardStore((state) => state.selectTicket);
  const selectTickets = useBoardStore((state) => state.selectTickets);
  const selectionAnchor = React.useRef<string | null>(selectedIds.at(-1) ?? null);
  React.useEffect(() => {
    if (selectedIds.length <= 1) selectionAnchor.current = selectedIds[0] ?? null;
  }, [selectedIds]);
  const [expandedEmptyStatus, setExpandedEmptyStatus] = React.useState<TicketStatus | null>(null);
  const reducedMotion = useReducedMotion();
  React.useLayoutEffect(() => {
    const sourceRects = pendingSlotAnimation.current;
    if (sourceRects === null) return;
    pendingSlotAnimation.current = null;
    if (reducedMotion) return;

    for (const [ticketId, source] of sourceRects) {
      const slot = ticketSlotElement(ticketId);
      if (slot === null) continue;
      const destination = slot.getBoundingClientRect();
      const dx = source.left - destination.left;
      const dy = source.top - destination.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      for (const animation of slot.getAnimations()) animation.cancel();
      slot.dataset.boardSlotAnimated = "true";
      slot.animate(
        [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
        { duration: 200, easing: "cubic-bezier(0.77, 0, 0.175, 1)" },
      );
    }
  }, [storeTickets, reducedMotion]);

  // Which tickets have an agent running on them (VC-100) — the ids the one
  // board-wide derivation walks. The derivation itself hangs off
  // `BoardSessionActivityProvider` below, deliberately BELOW this component:
  // its store is bumped about once a second per busy terminal, and a
  // subscription up here re-rendered `DndContext` from outside the drag often
  // enough to trip dnd-kit's measure loop. See session-activity-context.tsx.
  const boardTicketIds = React.useMemo(
    () => new Set(storeTickets.map((ticket) => ticket.id)),
    [storeTickets],
  );

  // Columns and pills only play their enter transition when they appear on an
  // ALREADY-mounted board (a drop expanded a column, a filter emptied one).
  // Opening the board page — a many-times-a-day action — stays instant.
  const boardMounted = React.useRef(false);
  React.useEffect(() => {
    boardMounted.current = true;
  }, []);

  React.useEffect(() => {
    if (selectedIds.length === 0) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // An Escape aimed at a focused control — the add-card composer, the ⌘K
      // search pill, an open context menu/dialog — is that control's dismissal,
      // not a board deselect; it still bubbles to window, so filter it out here.
      if (isEscapeExempt(event.target)) return;
      selectionAnchor.current = null;
      selectTicket(projectId, null);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds.length, projectId, selectTicket]);

  // distance: 4 keeps plain clicks (selection, context menu) working — the
  // drag only activates after real pointer travel. Keyboard drags come free
  // with the sortable coordinate getter.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const tickets = drag?.preview ?? storeTickets;
  // `tickets` may be the drag preview snapshot — filtering it is correct and
  // expected here; `filterTickets` returns the same reference when inactive.
  // The whole derived pipeline is memoized: the board re-renders on every
  // drag-over event and on selection changes, and none of those should re-run
  // a filter pass plus five column sorts.
  const visible = React.useMemo(
    () => filterTickets(tickets, filter, ticketPrefix),
    [tickets, filter, ticketPrefix],
  );
  const groups = React.useMemo(() => groupTicketsByStatus(visible), [visible]);
  // One sort pass shared by BOTH views (the columns and the list sections
  // previously each re-sorted per render) — and one array identity per status
  // held across it. `sortTickets` calls `toSorted`, so it hands back a fresh
  // array every time even when nothing moved; a drag that only ever touches two
  // columns was re-sorting all five on every preview change. Reusing the
  // previous array whenever the sort produced the same tickets in the same
  // order takes that to only the columns that changed.
  //
  // Honest about what this does NOT buy, measured in the lab's board scratch
  // (13 cards, one cross-column mouse drag of 24 pointer steps, under
  // StrictMode so halve the raw counts): it removed 80% of the sorted arrays
  // (270 → 54) and 60% of the downstream
  // `sortableIds` recomputes (270 → 108), and moved the card re-render count by
  // exactly ZERO. `TicketCard`'s `React.memo` was already holding for every
  // untouched column, and the `SortableContext` invalidation this avoids never
  // reached the memo — it reaches `SortableTicketShell` inside it, which
  // re-renders on dnd-kit's own context (`over`, `droppableRects`) on every
  // pointermove regardless of what we do out here. This is a real CPU saving on
  // the sort, not a fix for the drag's re-render volume; that one lives in
  // dnd-kit.
  //
  // The ref is a memo cache, not state. Writing it during render is idempotent
  // (a StrictMode double-invoke compares against its own first pass and reuses
  // it), and a value cached by a render React later discards is still
  // element-wise identical to what the next sort would produce — reuse can only
  // ever hand back a correct array, never a stale one.
  const previousSorted = React.useRef<Record<TicketStatus, Ticket[]> | null>(null);
  const sortedGroups = React.useMemo(() => {
    const previous = previousSorted.current;
    const sorted = {} as Record<TicketStatus, Ticket[]>;
    for (const status of TICKET_STATUSES) {
      const next = sortTickets(groups[status], boardSort);
      const before = previous?.[status];
      sorted[status] = before !== undefined && sameColumn(before, next) ? before : next;
    }
    previousSorted.current = sorted;
    return sorted;
  }, [groups, boardSort]);
  const selectionOrder = React.useMemo(
    () => TICKET_STATUSES.flatMap((status) => sortedGroups[status].map((ticket) => ticket.id)),
    [sortedGroups],
  );
  const visibleSelectedIds = React.useMemo(() => {
    const selected = new Set(selectedIds);
    return selectionOrder.filter((id) => selected.has(id));
  }, [selectedIds, selectionOrder]);
  // Once dragging, freeze the payload and placeholder set exactly as topology
  // is frozen. Before a drag, every selected card advertises the visible group
  // through dnd-kit's active data for future board-adjacent drop targets.
  const groupDragIds = drag?.ticketIds ?? visibleSelectedIds;
  const draggingIds = drag?.ticketIds ?? NO_TICKET_IDS;
  // Memoized for the same reason the sorted groups are: both are props, and a
  // fresh array on every drag-over defeats the children's memos. `hidden`
  // keeps its identity ACROSS drag start too — the drag freezes the very array
  // this returned on the previous render.
  const hidden = React.useMemo(
    () =>
      drag?.hiddenAtStart ??
      // Derived straight from `groups` — a separate helper would group (and
      // sort) the same array a second time.
      TICKET_STATUSES.filter(
        (status) => groups[status].length === 0 && status !== expandedEmptyStatus,
      ),
    [drag, groups, expandedEmptyStatus],
  );
  const shown = React.useMemo(
    () => TICKET_STATUSES.filter((status) => !hidden.includes(status)),
    [hidden],
  );
  // The list view's slim drop rows exist only during a drag; outside one this
  // is the frozen empty array rather than a fresh `[]` per render.
  const emptyDropStatuses = drag ? hidden : NO_STATUSES;
  // A board with nothing on it, which is not the same as a filter matching
  // nothing: this reads the PROJECT's tickets, so a filter that hides them all
  // still leaves the columns (and the collapsed rail) standing. See BoardEmpty.
  const boardEmpty = storeTickets.length === 0;
  // ...and nothing else on the canvas to say it around. The invitation stands IN
  // PLACE OF the collapsed rail, so it may only appear when that rail is the
  // whole of what would otherwise be drawn.
  //
  // The case that separates the two: expanding an empty column (the rail's own
  // affordance) opens an inline composer in it, and the board can empty behind
  // that composer — archive the last card while typing in another column. On
  // `boardEmpty` alone the invitation would appear BESIDE the open composer,
  // and replacing the columns outright would delete what was being typed.
  // Keyed on the columns actually shown, neither can happen.
  const boardBare = boardEmpty && shown.length === 0;

  const handleSelect = React.useCallback(
    (ticketId: string, gesture: TicketSelectionGesture) => {
      const clicked = storeTickets.find((ticket) => ticket.id === ticketId);
      if (!clicked) return;
      const next = ticketSelectionAfterClick(
        selectedIds,
        ticketId,
        {
          allIds: storeTickets
            .filter((ticket) => ticket.status === clicked.status)
            .map((ticket) => ticket.id),
          visibleIds: sortedGroups[clicked.status].map((ticket) => ticket.id),
        },
        selectionAnchor.current,
        gesture,
      );
      selectionAnchor.current = next.anchorId;
      selectTickets(projectId, next.selectedIds);
    },
    [projectId, selectedIds, selectTickets, sortedGroups, storeTickets],
  );
  // Click empty canvas to clear selection — pan-aware (a drag past slop is not
  // a click). Lives next to handleSelect so the deselect closure stays stable.
  const handleCanvasBackgroundClick = React.useCallback(() => {
    selectionAnchor.current = null;
    selectTicket(projectId, null);
  }, [projectId, selectTicket]);
  const { panning, canvasRef, canvasProps } = useBoardCanvasPan(
    handleCanvasBackgroundClick,
    boardView === "board",
  );
  // Double-click open (ticket-detail-mvp step 3): `openTicket` is a stable
  // zustand action reference, same stability contract as `selectTicket` above.
  const openTicket = useWorkspaceStore((state) => state.openTicket);
  const handleOpen = React.useCallback(
    (ticketId: string) => openTicket(projectId, ticketId),
    [openTicket, projectId],
  );
  // Stable (the column passes its own status back) so columns aren't handed a
  // fresh closure every board render.
  const handleComposerClose = React.useCallback(
    (status: TicketStatus) =>
      setExpandedEmptyStatus((current) => (current === status ? null : current)),
    [],
  );

  function handleDragStart({ active }: DragStartEvent) {
    const activeId = String(active.id);
    const activeTicket = storeTickets.find((ticket) => ticket.id === activeId);
    if (!activeTicket) return;

    const payload = isTicketDragData(active.data.current) ? active.data.current : null;
    const requestedIds =
      payload?.projectId === projectId && payload.ticketIds.includes(activeId)
        ? payload.ticketIds
        : [activeId];
    const requested = new Set(requestedIds);
    const startingGroups = groupTicketsByStatus(storeTickets);
    const ticketIds = TICKET_STATUSES.flatMap((status) =>
      startingGroups[status]
        .filter((ticket) => requested.has(ticket.id))
        .map((ticket) => ticket.id),
    );
    const selectedTickets = ticketIds
      .map((ticketId) => storeTickets.find((ticket) => ticket.id === ticketId))
      .filter((ticket): ticket is Ticket => ticket !== undefined);
    if (selectedTickets.length === 0) return;

    // Starting from an unselected card collapses selection to that card. A
    // selected card keeps its whole advertised group selected and draggable.
    if (!selectedIds.includes(activeId)) {
      selectionAnchor.current = activeId;
      selectTicket(projectId, activeId);
    } else {
      // A filter may have hidden part of an older selection. The advertised
      // payload is the visible group, so make the visible group the honest
      // selection before lifting it.
      selectTickets(projectId, ticketIds);
    }
    setExpandedEmptyStatus(null);
    setDrag({
      activeTicket,
      tickets: selectedTickets,
      ticketIds,
      preview: storeTickets,
      hiddenAtStart: hidden,
      drop: null,
    });
  }

  function handleDragOver({ over }: DragOverEvent) {
    if (!over) return;
    const overId = String(over.id);
    setDrag((current) => {
      if (!current) return current;

      if (current.ticketIds.length > 1) {
        // Returning the pointer to any selected source card means "put the
        // group back". Clear a previously-resolved destination rather than
        // committing the last column the pointer happened to cross.
        if (current.ticketIds.includes(overId)) {
          return current.drop === null ? current : { ...current, drop: null };
        }
        const drop = resolveGroupDrop(
          current.preview,
          current.ticketIds,
          current.activeTicket.id,
          overId,
        );
        if (!drop) return current;
        if (drop.toStatus === current.drop?.toStatus && drop.toIndex === current.drop.toIndex) {
          return current;
        }
        // Do not move several mounted sortables while dnd-kit is measuring the
        // active drag. That changes several observed rects in one layout pass
        // and triggers its React-185 measurement loop. The detached overlay is
        // the group preview; source cards stay as dimmed placeholders until the
        // gesture ends, then the atomic board op lays the group out once.
        return { ...current, drop };
      }

      // Keep the proven one-card preview path byte-for-byte in spirit: moving
      // one observed sortable is what dnd-kit's multi-container recipe expects.
      const activeId = current.ticketIds[0]!;
      const target = resolveDrop(current.preview, activeId, overId);
      if (!target) return current;
      const next = moveTicket(
        current.preview,
        activeId,
        target.toStatus,
        target.toIndex,
        Date.now(),
      );
      const drop = ticketPosition(next, activeId);
      if (
        next === current.preview &&
        drop?.toStatus === current.drop?.toStatus &&
        drop?.toIndex === current.drop?.toIndex
      ) {
        return current;
      }
      return { ...current, preview: next, drop };
    });
  }

  function handleDragEnd({ over }: DragEndEvent) {
    const completed = drag;
    const sourceRects =
      !reducedMotion && completed !== null && completed.ticketIds.length > 1
        ? new Map(
            completed.ticketIds.flatMap((ticketId) => {
              const slot = ticketSlotElement(ticketId);
              return slot === null ? [] : [[ticketId, slot.getBoundingClientRect()] as const];
            }),
          )
        : null;
    setDrag(null);
    // Released over no droppable at all → cancel. A group also needs a resolved
    // destination; releasing over its untouched source selection is a no-op.
    if (!completed || over === null || completed.drop === null) return;
    const drop = completed.drop;

    if (completed.ticketIds.length === 1) {
      void useBoardStore
        .getState()
        .moveTicket(projectId, completed.ticketIds[0]!, drop.toStatus, drop.toIndex);
      return;
    }

    // Let dnd-kit tear down its measurement observers before the atomic group
    // changes parents. The board's layout effect consumes the captured source
    // rects immediately after the destination DOM commits, before it paints.
    window.requestAnimationFrame(() => {
      pendingSlotAnimation.current = sourceRects;
      const move = useBoardStore
        .getState()
        .moveTickets(projectId, completed.ticketIds, drop.toStatus, drop.toIndex);
      void move.finally(() => {
        if (pendingSlotAnimation.current === sourceRects) pendingSlotAnimation.current = null;
      });
    });
  }

  function handleDragCancel() {
    setDrag(null);
  }

  return (
    // The sessions-store read sits out here, above the tree it feeds and below
    // nothing that renders `DndContext` — an agent's output must never re-render
    // the drag machinery. Everything under it arrives as `children`, built by
    // THIS render, so a bump re-renders the provider alone and React bails the
    // subtree out while still routing the new value to the columns that read it.
    <BoardSessionActivityProvider projectId={projectId} ticketIds={boardTicketIds}>
      {/* Every card's context menu asks this host — not itself — to open the
          archive and remove-worktree confirms, so the board carries one of each
          instead of one per card. The whole board is its `children` prop, which
          is what lets an open dialog re-render the host alone. */}
      <TicketDialogHost projectId={projectId}>
        <div className="flex min-h-0 flex-1 flex-col">
          <BoardHeader
            projectId={projectId}
            ticketCount={visible.length}
            tickets={storeTickets}
            filter={filter}
          />
          {/* One DndContext drives BOTH views — same handlers, same preview/commit
            machinery, same ticket id space. The view branch lives inside it so the
            list view has full drag parity with the board; only the layout and the
            drag overlay's shape differ. Escape-clears-selection (above) is shared. */}
          <DndContext
            sensors={sensors}
            collisionDetection={boardCollision}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            {boardView === "list" ? (
              // Same grouped/filtered set, sort, and selection as the board. `shown`
              // and `hidden` are the board's own frozen-during-drag topology reused:
              // shown → full sections; hidden (empty-at-start) → slim drop rows,
              // rendered only while dragging so a row can land in any status.
              <BoardListView
                projectId={projectId}
                ticketPrefix={ticketPrefix}
                projectLabels={projectLabels}
                groups={sortedGroups}
                shownStatuses={shown}
                emptyDropStatuses={emptyDropStatuses}
                boardEmpty={boardEmpty}
                dragActive={drag !== null}
                selectedIds={selectedIds}
                draggingIds={draggingIds}
                groupDragIds={groupDragIds}
                onSelect={handleSelect}
                onOpen={handleOpen}
              />
            ) : (
              <div
                ref={canvasRef}
                {...canvasProps}
                className={cn(
                  // Columns cap below full height so a strip of canvas stays
                  // grab-able under them (Trello-style mouse pan). Scrollbar is
                  // hidden — drag / shift-wheel / trackpad replace it.
                  "flex min-h-0 flex-1 items-start gap-4 overflow-x-auto px-gutter pb-4",
                  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                  panning ? "cursor-grabbing select-none" : "cursor-grab",
                )}
              >
                {boardBare ? <BoardEmpty className="min-h-0 flex-1 self-stretch" /> : null}
                {shown.map((status) => (
                  <BoardColumn
                    key={status}
                    status={status}
                    // Display order is sort-driven: `sortedGroups` reorders each
                    // column for rendering. Drag mechanics stay unchanged — a drop
                    // still writes the manual `order` (see handleDragEnd), but under
                    // a non-manual sort the displayed position is sort-driven, so the
                    // card snaps to its sorted slot after the drop (Linear behaves the
                    // same). "manual" remains the true drag-reorder mode.
                    tickets={sortedGroups[status]}
                    projectId={projectId}
                    ticketPrefix={ticketPrefix}
                    projectLabels={projectLabels}
                    selectedIds={selectedIds}
                    draggingIds={draggingIds}
                    groupDragIds={groupDragIds}
                    onSelect={handleSelect}
                    onOpen={handleOpen}
                    composerInitiallyOpen={expandedEmptyStatus === status}
                    onComposerClose={handleComposerClose}
                    animateEnter={boardMounted.current}
                  />
                ))}
                {boardBare ? null : (
                  <CollapsedColumnRail
                    statuses={hidden}
                    dragActive={drag !== null}
                    onExpand={setExpandedEmptyStatus}
                    animateEnter={boardMounted.current}
                  />
                )}
              </div>
            )}
            <DragOverlay
              dropAnimation={
                reducedMotion ? null : { duration: 200, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
              }
            >
              {drag ? (
                <DragOverlayBody
                  activeTicket={drag.activeTicket}
                  tickets={drag.tickets}
                  ticketPrefix={ticketPrefix}
                  projectLabels={projectLabels}
                  listView={boardView === "list"}
                  reducedMotion={reducedMotion}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      </TicketDialogHost>
    </BoardSessionActivityProvider>
  );
});
