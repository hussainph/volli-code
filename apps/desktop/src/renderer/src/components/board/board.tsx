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
import {
  displayTicketId,
  EMPTY_TICKET_FILTER,
  filterTickets,
  groupTicketsByStatus,
  moveTicket,
  sortTickets,
  TICKET_STATUSES,
  type Automation,
  type Label,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { useArmedRunStore } from "@renderer/components/automations/armed-run";
import type { DeliberateMoveChoice } from "@renderer/components/automations/armed-move-model";
import { resolveDrop, ticketPosition } from "@renderer/components/board/board-dnd";
import { BoardColumn } from "@renderer/components/board/board-column";
import {
  MOVE_ONLY_ROW,
  OFFERED_ROW_ATTRIBUTE,
  type ColumnOfferedPanelProps,
} from "@renderer/components/board/column-offered-panel";
import {
  dragPickerReducer,
  dragPickerRelease,
  highlightedIndex,
  IDLE_DRAG_PICKER,
  isPickerColumn,
  isPickerOpen,
  showsChooseHint,
  showsOfferedList,
  type DragPickerChoice,
  type DragPickerColumns,
  type DragPickerEvent,
  type DragPickerLanding,
} from "@renderer/components/board/drag-picker-model";
import { BoardEmpty } from "@renderer/components/board/board-empty";
import { BoardHeader } from "@renderer/components/board/board-header";
import { BoardListView, TicketRowContent } from "@renderer/components/board/board-list-view";
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
import {
  effectiveArmedIn,
  offeredInDigitOrder,
  selectArmings,
  selectAutomations,
  selectColumnOrders,
  useAutomationsStore,
} from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * Everything alive only while a card is mid-drag. The preview is a local
 * snapshot the drag mutates (via the shared moveTicket op) so the store —
 * and its localStorage persist — is written exactly once, on drop; cancel
 * simply discards the snapshot. The hidden set is frozen at drag start so
 * columns never collapse or expand under the pointer.
 */
interface DragState {
  ticket: Ticket;
  preview: Ticket[];
  hiddenAtStart: TicketStatus[];
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

/**
 * The column under the pointer, and the picker row under it when the pointer is
 * standing on an expanded panel.
 *
 * `elementFromPoint` rather than cached rects, for the Lab rig's reason: a
 * column list scrolls during a drag and the panel changes size when ⌥ goes
 * down, so a rect measured a frame ago is a rect for the wrong thing — and a
 * stale rect is the classic source of a drop landing one column over from where
 * it was aimed. Both facts come out of ONE read, so the hovered column and the
 * highlighted row can never disagree about where the pointer is.
 */
function pointerLanding(
  x: number,
  y: number,
): { status: TicketStatus | null; target: DragPickerLanding | null } {
  const element = document.elementFromPoint(x, y);
  const column = element?.closest<HTMLElement>("[data-board-column]");
  const status = (column?.dataset["boardColumn"] as TicketStatus | undefined) ?? null;
  const row = element?.closest<HTMLElement>(`[${OFFERED_ROW_ATTRIBUTE}]`);
  const value = row?.getAttribute(OFFERED_ROW_ATTRIBUTE) ?? null;
  if (status === null || value === null) return { status, target: null };
  return {
    status,
    target: { status, index: value === MOVE_ONLY_ROW ? null : Number(value) },
  };
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
function DragOverlayBody({
  ticket,
  ticketPrefix,
  projectLabels,
  listView,
}: {
  ticket: Ticket;
  ticketPrefix: string;
  projectLabels: readonly Label[];
  listView: boolean;
}) {
  const sessionActivity = useTicketActivity(ticket.id);

  // Row-shaped overlay sized to the active row by dnd-kit; a lifted surface
  // (bg + shadow) instead of the card's scale-up.
  //
  // `--shadow-card` rather than a black alpha: the elevation set is solved per
  // mode (a near-black in dark, a warm brown against the light canvas), and a
  // card being dragged is a card — the same tier the board's cards already sit
  // at, one step further off.
  if (listView) {
    return (
      <div className="cursor-grabbing overflow-hidden rounded-md bg-card shadow-card">
        <TicketRowContent
          ticket={ticket}
          ticketPrefix={ticketPrefix}
          projectLabels={projectLabels}
          sessionActivity={sessionActivity}
        />
      </div>
    );
  }

  // The overlay carries the ring too: picking a card up must not make its agent
  // look like it stopped.
  return (
    <div className="scale-[1.03] cursor-grabbing rounded-lg shadow-card">
      <TicketCardContent
        ticket={ticket}
        ticketPrefix={ticketPrefix}
        projectLabels={projectLabels}
        sessionActivity={sessionActivity}
      />
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
  // Selection is store-backed (session-only), not component state, so other
  // surfaces — the sidebar's Active Sessions — can select a card and have the
  // board reflect it. Board behavior is unchanged from the useState version.
  const selectedId = useBoardStore((state) => state.selectedByProject[projectId] ?? null);
  const selectTicket = useBoardStore((state) => state.selectTicket);
  const [expandedEmptyStatus, setExpandedEmptyStatus] = React.useState<TicketStatus | null>(null);
  const reducedMotion = useReducedMotion();

  /* ------------------------------------------- the ⌥ drag picker (VC-132) */

  // The four machine-local slices the digit order composes. Subscribed raw and
  // composed in a memo rather than read through one selector: a store selector
  // that mints an array on every read cannot be subscribed to at all.
  const automations = useAutomationsStore((state) => selectAutomations(state, projectId));
  const armings = useAutomationsStore((state) => selectArmings(state, projectId));
  const columnOrders = useAutomationsStore((state) => selectColumnOrders(state, projectId));
  const enabledIds = useAutomationsStore((state) => state.enabledIds);
  const offeredByStatus = React.useMemo(() => {
    // The store's own composition, handed the four slices this component
    // subscribed to — the same function the lane view runs, which is what makes
    // "the digit a lane prints is the digit a drag answers" structural rather
    // than a pair of memos that agree today.
    const slices = { automations, armings, orders: columnOrders, enabledAutomationIds: enabledIds };
    const offered = {} as Record<TicketStatus, readonly Automation[]>;
    const armed = {} as Record<TicketStatus, string | null>;
    for (const status of TICKET_STATUSES) {
      // The PIN's source: armed and switched on here. An armed Automation this
      // machine has switched off starts nothing on a plain drop, so pinning it
      // to `1` would make the safe digit promise a Run that never comes.
      armed[status] = effectiveArmedIn(slices, status)?.id ?? null;
      offered[status] = offeredInDigitOrder(slices, status);
    }
    return { offered, armed };
  }, [automations, armings, columnOrders, enabledIds]);

  // What the picker needs to know about a column. `defaultIndex` is a READ of
  // the very list every surface renders rather than a second statement of the
  // pin rule, so the two can never drift.
  const pickerColumns = React.useMemo<DragPickerColumns>(
    () => ({
      offeredCount: (status) => offeredByStatus.offered[status].length,
      defaultIndex: (status) => {
        const index = offeredByStatus.offered[status].findIndex(
          (automation) => automation.id === offeredByStatus.armed[status],
        );
        return index === -1 ? null : index;
      },
    }),
    [offeredByStatus],
  );
  const pickerColumnsRef = React.useRef(pickerColumns);
  pickerColumnsRef.current = pickerColumns;

  // The ref is the picker's truth and the state is only what renders it: a
  // release can land in the same frame as the pointer move that aimed it, and
  // reading a state value React has not committed yet would drop the aim.
  const pickerRef = React.useRef(IDLE_DRAG_PICKER);
  const [picker, setPicker] = React.useState(IDLE_DRAG_PICKER);
  const applyPicker = React.useCallback((event: DragPickerEvent) => {
    const next = dragPickerReducer(pickerRef.current, event, pickerColumnsRef.current);
    if (next === pickerRef.current) return;
    pickerRef.current = next;
    setPicker(next);
  }, []);

  // What a column shows mid-drag — its Offered list compactly while the pointer
  // is merely over it, grown into landing targets while ⌥ holds it open — built
  // in one place because TWO surfaces draw it: a standing column, and the rail
  // pill that stands in for an EMPTY one. An empty column can be armed, so the
  // pill has to be able to grow the same picker; what a column offers is a fact
  // about the column, never about how much of it is on screen.
  const offeredPanelFor = React.useCallback(
    (status: TicketStatus): ColumnOfferedPanelProps | undefined =>
      showsOfferedList(picker, status)
        ? {
            rows: offeredByStatus.offered[status],
            expanded: isPickerColumn(picker, status),
            highlighted: highlightedIndex(picker, pickerColumns, status),
            armedId: offeredByStatus.armed[status],
          }
        : undefined,
    [picker, pickerColumns, offeredByStatus],
  );
  // One column is being aimed at, and the rest — standing or collapsed — are
  // not the question.
  const dimmedFor = React.useCallback(
    (status: TicketStatus): boolean => isPickerOpen(picker) && !isPickerColumn(picker, status),
    [picker],
  );

  // Live only while a card is in the air. ⌥ is read from TWO sources for the
  // reason the Lab rig documents: the key events alone miss a drag that STARTED
  // with ⌥ already down, and a keyup that never arrived (⌥ released while the
  // window lacked focus) would leave a column enlarged under a modifier nobody
  // is holding. Every pointer move carries the live answer, so both halves are
  // read from whichever event is fresher.
  const dragging = drag !== null;
  React.useEffect(() => {
    if (!dragging) return;
    function handlePointerMove(event: PointerEvent) {
      const landing = pointerLanding(event.clientX, event.clientY);
      applyPicker({
        kind: "pointer-move",
        hovered: landing.status,
        modifierHeld: event.altKey,
        target: landing.target,
      });
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Alt") {
        applyPicker({ kind: "modifier", held: event.type === "keydown" });
        return;
      }
      if (event.type !== "keydown") return;
      // `code`, not `key`: it is the PHYSICAL key, so `1`–`9` mean the same row
      // on every layout (on AZERTY the unshifted top row is `& é " ' ( -`, and
      // macOS's ⌥ dead-key layer turns ⌥2 into `€`).
      const digit = /^Digit([0-9])$/.exec(event.code)?.[1];
      if (digit === undefined) return;
      event.preventDefault();
      applyPicker({ kind: "digit", digit: Number(digit) });
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKey);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", handleKey);
    };
  }, [dragging, applyPicker]);

  // The countdown owns bottom-centre while it is open: it has a deadline and
  // the one control, and the hint is advice. Two ephemeral surfaces on one edge
  // is a collision; this is which of them wins it.
  const countdownOpen = useArmedRunStore((state) => Object.keys(state.pending).length > 0);

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

  // What this project's columns offer and what they arm (VC-128). Read when the
  // board appears rather than subscribed, for the palette's reason: the record
  // changes only through this app's own doors, and a drop must be able to
  // consult the answer WITHOUT an await — a move that had to wait on IPC to
  // learn it was armed would either delay every drop or race the countdown.
  React.useEffect(() => {
    const store = useAutomationsStore.getState();
    void store.refresh(projectId);
    void store.refreshArming(projectId);
    // And in what ORDER this project's columns offer them (VC-132): the digit
    // a drag answers is composed from the same four reads, so the rank belongs
    // beside the arming rather than a frame behind it.
    void store.refreshOrder(projectId);
    // And which of them are switched on HERE (VC-127): the drag picker pins
    // only the effective armed Automation, so its renderer model needs this
    // beside the other reads. Main independently classifies the committed
    // arrival from its durable projections; these caches never own the timer.
    void store.refreshEnablement();
  }, [projectId]);

  React.useEffect(() => {
    if (selectedId === null) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // An Escape aimed at a focused control — the add-card composer, the ⌘K
      // search pill, an open context menu/dialog — is that control's dismissal,
      // not a board deselect; it still bubbles to window, so filter it out here.
      if (isEscapeExempt(event.target)) return;
      selectTicket(projectId, null);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedId, projectId, selectTicket]);

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
    (ticketId: string | null) => selectTicket(projectId, ticketId),
    [selectTicket, projectId],
  );
  // Click empty canvas to clear selection — pan-aware (a drag past slop is not
  // a click). Lives next to handleSelect so the deselect closure stays stable.
  const handleCanvasBackgroundClick = React.useCallback(() => handleSelect(null), [handleSelect]);
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

  function handleDragStart({ active, activatorEvent }: DragStartEvent) {
    const ticket = storeTickets.find((candidate) => candidate.id === String(active.id));
    if (!ticket) return;
    selectTicket(projectId, null);
    setExpandedEmptyStatus(null);
    setDrag({ ticket, preview: storeTickets, hiddenAtStart: hidden });
    // A drag may BEGIN with ⌥ already down, and that drag never sees a keydown.
    // The activator event is the only place that fact exists.
    applyPicker({
      kind: "drag-start",
      modifierHeld: "altKey" in activatorEvent && activatorEvent.altKey === true,
    });
  }

  function handleDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    setDrag((current) => {
      if (!current) return current;
      const target = resolveDrop(current.preview, activeId, overId);
      if (!target) return current;
      const next = moveTicket(
        current.preview,
        activeId,
        target.toStatus,
        target.toIndex,
        Date.now(),
      );
      return next === current.preview ? current : { ...current, preview: next };
    });
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (drag) {
      const finalPosition = ticketPosition(drag.preview, String(active.id));
      // Released over no droppable at all → the board's ordinary no-target
      // release, not a commit of whatever the last hovered preview position
      // happened to be. (Rare with the closestCorners fallback, but a stray
      // status change is consequential once Doing boots an agent.) A release
      // with the picker OPEN is not that case: the picker, not the pointer, is
      // what it obeys — see `dragPickerRelease`.
      const releaseStatus = over === null || !finalPosition ? null : finalPosition.toStatus;
      const release = dragPickerRelease(pickerRef.current, releaseStatus);
      if (release !== null) {
        // Landing on the column the board already previewed keeps the exact
        // slot the preview shows. A picked column the pointer is no longer
        // over has no previewed slot, so the card lands at its end.
        const toIndex =
          finalPosition && release.status === finalPosition.toStatus
            ? finalPosition.toIndex
            : drag.preview.filter((ticket) => ticket.status === release.status).length;
        void useBoardStore
          .getState()
          .moveTicket(
            projectId,
            String(active.id),
            release.status,
            toIndex,
            deliberateChoice(release.status, release.choice),
          );
      }
    }
    applyPicker({ kind: "drag-end" });
    setDrag(null);
  }

  /**
   * What the release carries to the Automation layer: the Automation a named
   * target actually names, the Move only target, or nothing at all for a plain
   * drop. An index the column no longer has a row for (the list changed under
   * the drag) degrades to the plain drop rather than to a neighbouring row —
   * running an Automation nobody aimed at is the one substitution this whole
   * gesture exists to prevent.
   */
  function deliberateChoice(
    status: TicketStatus,
    choice: DragPickerChoice,
  ): DeliberateMoveChoice | undefined {
    if (choice.kind === "move-only") return { kind: "move-only" };
    if (choice.kind === "default") return undefined;
    const automation = offeredByStatus.offered[status][choice.index];
    if (automation === undefined) return undefined;
    return { kind: "automation", automationId: automation.id };
  }

  function handleDragCancel() {
    applyPicker({ kind: "drag-end" });
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
                selectedId={selectedId}
                onSelect={handleSelect}
                onOpen={handleOpen}
              />
            ) : (
              <div
                ref={canvasRef}
                {...canvasProps}
                // Which card is in the air, for the one thing outside this
                // component that has to know a drag is live: the picker smoke,
                // which cannot start reading a panel before dnd-kit has
                // actually activated (`automations-picker-smoke.mjs`).
                data-board-drag={drag === null ? undefined : drag.ticket.id}
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
                    // What this column can run, mid-drag (VC-132) — the same
                    // panel the rail's pills draw, from the same builder.
                    offered={offeredPanelFor(status)}
                    dimmed={dimmedFor(status)}
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
                    selectedId={selectedId}
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
                    offeredFor={offeredPanelFor}
                    dimmedFor={dimmedFor}
                  />
                )}
              </div>
            )}
            <DragOverlay
              // The lifted card is a PICTURE, never a surface: dnd-kit's own
              // wrapper is a fixed, card-sized box at `z-index: 999` that
              // follows the pointer exactly, so without this it is the topmost
              // thing under the hand at every moment of the drag — and the
              // picker's hit test (`pointerLanding`) reads the topmost thing
              // under the hand. It answered "no column, no row" for any aim
              // that ended INSIDE the lifted card's own outline, which is most
              // of them: which aims survived depended on where the card had
              // been grabbed. A row aimed at and not taken is the one failure
              // this gesture cannot have, because the release then runs the
              // column's default instead of what the hand was pointing at.
              className="pointer-events-none"
              dropAnimation={
                // A picked release lands where the PICKER says, which is not
                // necessarily where the card is: animating the card into the
                // slot it was hovering would draw the wrong landing.
                reducedMotion || isPickerOpen(picker)
                  ? null
                  : { duration: 200, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
              }
            >
              {drag ? (
                isPickerOpen(picker) ? (
                  // The card gives way over the panel rather than moving out of
                  // it: a full card is the single worst thing that could sit on
                  // top of a list asking to be read. It shrinks to one line
                  // carrying the ref — the identity, never elided — and stops
                  // being the biggest thing on screen at the exact moment it
                  // stops being the thing being read.
                  <div className="w-fit rounded-md border border-border bg-card px-2 py-1 font-mono text-label text-muted-foreground shadow-overlay">
                    {displayTicketId(ticketPrefix, drag.ticket.ticketNumber)}
                  </div>
                ) : (
                  <DragOverlayBody
                    ticket={drag.ticket}
                    ticketPrefix={ticketPrefix}
                    projectLabels={projectLabels}
                    listView={boardView === "list"}
                  />
                )
              ) : null}
            </DragOverlay>
            {/* "⌥ to choose" — the mid-drag affordance (VC-132, VC-112). Three
                words, near bottom-centre, and only while the fact it teaches is
                actionable (see `showsChooseHint`). Bottom-centre rather than at
                the cursor: the pointer's neighbourhood belongs to the card and
                the rows being aimed at, and a hint that chases the hand becomes
                part of the drag instead of a caption under it. Appearance-only
                motion, like everything else on this path. */}
            {showsChooseHint(picker, pickerColumns) && !countdownOpen ? (
              <div
                data-choose-hint
                className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center"
              >
                <p
                  className={cn(
                    "flex items-center gap-2 rounded-full border border-border bg-popover px-2 py-1 text-ui text-muted-foreground shadow-overlay",
                    !reducedMotion &&
                      "transition-[opacity,translate] duration-200 ease-out starting:translate-y-1 starting:opacity-0",
                  )}
                >
                  <kbd className="rounded-sm border border-border px-1 font-mono text-label text-foreground">
                    ⌥
                  </kbd>
                  to choose
                </p>
              </div>
            ) : null}
          </DndContext>
        </div>
      </TicketDialogHost>
    </BoardSessionActivityProvider>
  );
});
