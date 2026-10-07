import * as React from "react";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringFrequency,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type MeasuringConfiguration,
  KeyboardCode,
  type KeyboardSensorOptions,
  type PointerSensorOptions,
} from "@dnd-kit/core";
import { guardWrite, useCanWrite } from "@renderer/components/hosts/use-hosts";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { motion } from "motion/react";
import {
  EMPTY_TICKET_FILTER,
  filterTickets,
  groupTicketsByStatus,
  sortTickets,
  TICKET_STATUSES,
  type Automation,
  type Label,
  type Ticket,
  type TicketFilter,
  type TicketSort,
  type TicketStatus,
} from "@volli/shared";

import { useArmedRunStore } from "@renderer/components/automations/armed-run";
import type { DeliberateMoveChoice } from "@renderer/components/automations/armed-move-model";
import {
  columnDroppableId,
  isTicketDragData,
  resolveGroupDrop,
  type DropTarget,
} from "@renderer/components/board/board-dnd";
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
import { ProjectFolderBanner } from "@renderer/components/board/project-folder-banner";
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
import { useTicketFocusRestore } from "@renderer/hooks/use-ticket-focus-handoff";
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
import {
  DEFAULT_WORKSPACE_UI,
  useWorkspaceStore,
  type BoardView,
} from "@renderer/stores/workspace";

/**
 * Everything alive only while a card is mid-drag. The ticket snapshot and
 * column topology stay frozen for single- and multi-card drags alike. Only
 * the intended slot changes; transforms and the detached overlay preview it.
 * The store is written exactly once on drop, and cancel discards the state.
 *
 * The snapshot is taken at the SUBSCRIPTION (see {@link FrozenReads}), not
 * here: freezing the ticket array while the board still read a live filter,
 * sort, view or label slice left four doors a store write could re-render the
 * drag machinery through. `FrozenReads` is the ONLY home for those — this
 * state deliberately does not carry its own copy, because two snapshots of one
 * invariant is two things to keep in step.
 */
interface DragState {
  activeTicket: Ticket;
  selectedTickets: Ticket[];
  ticketIds: string[];
  preview: Ticket[];
  hiddenAtStart: TicketStatus[];
  /** Final slot in the preview, ready for the atomic persistence call. */
  drop: DropTarget | null;
}

/**
 * Every store read the board holds ABOVE `DndContext`, snapshotted for one
 * gesture (VC-329, extended to the reads VC-329 left live).
 *
 * ── WHY A GESTURE FREEZES ITS READS RATHER THAN ITS OUTPUT ────────────────
 * `Board` renders `<DndContext>`, and dnd-kit recomputes its collisions during
 * that render and hands them to its own context — so a `Board` render is a
 * re-render of EVERY droppable and every sortable shell on the board, memo or
 * no memo, and `children` being rebuilt each time means `DndContext`'s own
 * `React.memo` can never bail out of it. That is the churn that took this
 * board out twice (error #185, `Maximum update depth exceeded`), and it is why
 * the sessions-store read was pushed below this component in the first place
 * — see session-activity-context.tsx, which documents the same mechanism from
 * the other end.
 *
 * ── WHAT AN AUTOMATION DOES TO THOSE READS ────────────────────────────────
 * A Run started by a drop is a live agent Session, and its `data:changed`
 * broadcasts reach this renderer as `hydrateProjectRoster` — a WHOLESALE
 * replacement of both the ticket slice and the label slice, in which every
 * object is a new identity even when nothing a person can see has moved. Land
 * one while a card is in the air and the board re-rendered `DndContext` from
 * outside the drag, which is precisely the interleaving the crash reports
 * name. Frozen, the selector hands back the same array, `useSyncExternalStore`
 * compares identity, and React never re-renders the board at all.
 *
 * `view` is frozen for a different failure with the same cure: switching the
 * board/list toggle mid-gesture unmounts the active sortable underneath
 * dnd-kit. A keyboard drag (dnd-kit's `KeyboardSensor`) leaves the pointer free
 * to press it, so this is reachable rather than theoretical.
 *
 * Nothing is LOST by freezing: every one of these is re-read on the render
 * that ends the gesture, because clearing the snapshot and clearing `drag`
 * happen in the same handler.
 *
 * ── THE ONE UNSOUNDNESS, STATED ───────────────────────────────────────────
 * Consulting this ref inside a selector makes that selector impure: a
 * `useSyncExternalStore` snapshot is contractually a function of store state
 * alone, and this one also reads a ref. It is sound in the only ordering that
 * occurs — the ref is written and cleared in drag handlers, and every write to
 * it is followed by the `setDrag` that renders it — but React owes us nothing
 * here, so an abandoned or replayed render under StrictMode (React 19, on in
 * `main.tsx`) could in principle read a snapshot this commit never used. It is
 * unsound rather than broken, and it is the cheapest mechanism that keeps a
 * mid-gesture store write from re-measuring the whole board. Anything stronger
 * belongs at the store, by making `hydrateProjectRoster` identity-stable so no
 * consumer has to look away (VC-447).
 */
interface FrozenReads {
  tickets: Ticket[];
  labels: readonly Label[];
  filter: TicketFilter;
  sort: TicketSort;
  /** The union, not `string`: widening it here would silently widen the
   * `boardView` every comparison below is checked against. */
  view: BoardView;
  countdownOpen: boolean;
}

/**
 * When dnd-kit is allowed to measure, stated rather than inherited.
 *
 * `WhileDragging` + `Optimized` is what dnd-kit defaults to today, and pinning
 * it is the point: this board has been taken out twice by measurement churn,
 * and an upstream default change would move exactly that. Under it, droppables
 * are measured ONCE when a gesture activates and then only when the set of
 * registered droppables changes — which is the measurement model the
 * freeze-and-commit-on-release gesture is built on. Nothing re-measures at
 * rest, which matters on a board whose columns re-render on ordinary session
 * activity.
 *
 * `MeasuringStrategy.Always` is the one setting this must never take: it
 * re-measures every droppable on every commit, so any mid-gesture re-render —
 * an Automation's roster replacement, a card growing an activity row — feeds
 * new rects straight back into the collision/translate cycle. That is the
 * crash, configured on. `BeforeDragging` is wrong for the opposite reason: it
 * measures the whole board on every IDLE commit and stops during the gesture,
 * paying the cost where there is no drag to spend it on.
 */
const BOARD_MEASURING: MeasuringConfiguration = {
  droppable: {
    strategy: MeasuringStrategy.WhileDragging,
    frequency: MeasuringFrequency.Optimized,
  },
};

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
 * The column under the pointer, and the picker row under it when the pointer is
 * standing on an expanded panel.
 *
 * A live hit test rather than cached rects, for the Lab rig's reason: a
 * column list scrolls during a drag and the panel changes size when ⌥ goes
 * down, so a rect measured a frame ago is a rect for the wrong thing — and a
 * stale rect is the classic source of a drop landing one column over from where
 * it was aimed. Both facts come out of ONE element, so the hovered column and
 * the highlighted row can never disagree about where the pointer is.
 *
 * `elementsFromPoint` — the whole hit-test stack, topmost first — rather than
 * `elementFromPoint`, and the first entry that sits in a column wins. Clickable
 * chrome floats over the board by design: the armed-run countdown owns
 * bottom-centre and must keep its Cancel live, and sonner's toasts own
 * bottom-right. Either one under the hand used to answer "no column", so ⌥
 * opened nothing and a drag aimed low at a column ran its default (VC-451).
 * Anything hit-testable above a column is looked through, not only those two —
 * which is also how dnd-kit's rect-based collision already resolves the drop,
 * so the picker and the release agree. A modal is not looked through: Radix
 * sets `pointer-events: none` on the body behind it, so nothing under it is in
 * the stack. Looking through is right only mid-drag, which is the only time
 * this runs; the chrome itself stays clickable at rest. A pure DOM read in a
 * pointer handler — it adds no store read and no render path to the board.
 */
function pointerLanding(
  x: number,
  y: number,
): { status: TicketStatus | null; target: DragPickerLanding | null } {
  const element = document
    .elementsFromPoint(x, y)
    .find((hit) => hit.closest("[data-board-column]") !== null);
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
const POINTER_DRAG: PointerSensorOptions = { activationConstraint: { distance: 4 } };
/** A pointer that never travels far enough: a read-only board lifts nothing. */
const POINTER_NEVER: PointerSensorOptions = {
  activationConstraint: { distance: Number.POSITIVE_INFINITY },
};
const KEYBOARD_DRAG: KeyboardSensorOptions = { coordinateGetter: sortableKeyboardCoordinates };
/** No key starts a keyboard drag on a read-only board. */
const KEYBOARD_NEVER: KeyboardSensorOptions = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: {
    start: [],
    cancel: [KeyboardCode.Esc],
    end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
  },
};

export const Board = React.memo(function Board({
  projectId,
  ticketPrefix,
}: {
  projectId: string;
  ticketPrefix: string;
}) {
  // The gesture's snapshot of everything below, or `null` at rest. Read INSIDE
  // each selector so a store write during a gesture hands the same reference
  // straight back and `useSyncExternalStore` never re-renders the board — see
  // `FrozenReads` for why a re-render here is a re-measure of the whole drag.
  // A ref rather than state: it is written from a drag handler and read during
  // the render that handler schedules, and it must never schedule one itself.
  const frozen = React.useRef<FrozenReads | null>(null);
  const storeTickets = useBoardStore(
    (state) => frozen.current?.tickets ?? state.ticketsByProject[projectId] ?? EMPTY_TICKETS,
  );
  const filter = useBoardStore(
    (state) => frozen.current?.filter ?? state.filterByProject[projectId] ?? EMPTY_TICKET_FILTER,
  );
  // One store subscription for the whole board rather than one per visible card
  // — the same reasoning that already made `ticketPrefix` a prop: a board only
  // ever shows one project, so its label rows are constant for the whole tree
  // and every card was subscribing to the identical slice.
  const projectLabels = useBoardStore(
    (state) => frozen.current?.labels ?? state.labelsByProject[projectId] ?? EMPTY_LABELS,
  );
  // View mode and sort are per-workspace, session-only (same pattern as
  // use-active-nav.ts): fall back to the shared default for never-visited projects.
  const boardView = useWorkspaceStore(
    (state) =>
      frozen.current?.view ??
      state.byProject[projectId]?.boardView ??
      DEFAULT_WORKSPACE_UI.boardView,
  );
  const boardSort = useWorkspaceStore(
    (state) =>
      frozen.current?.sort ??
      state.byProject[projectId]?.boardSort ??
      DEFAULT_WORKSPACE_UI.boardSort,
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
      const easing = getComputedStyle(slot).getPropertyValue("--ease-swift").trim();
      // Web Animations does not resolve `var(...)` in its options dictionary;
      // read the canonical motion token from the element instead. If a future
      // shell omits it, skip the flourish rather than throwing during layout.
      if (easing === "") continue;
      for (const animation of slot.getAnimations()) animation.cancel();
      slot.dataset.boardSlotAnimated = "true";
      slot.animate(
        [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
        { duration: 200, easing },
      );
    }
  }, [storeTickets, reducedMotion]);

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
  // Which column the frozen preview currently resolves the release into. A
  // callback keyed on the STATUS rather than on `drag`, so the memoized rail
  // below sees the same function across every drag-over that did not move the
  // target — an inline lambda here re-rendered every pill on every board render.
  const aimedStatus = drag?.drop?.toStatus ?? null;
  const aimedFor = React.useCallback(
    (status: TicketStatus): boolean => aimedStatus === status,
    [aimedStatus],
  );

  // Listen before activation, but consume input only while the synchronous
  // picker ref says a card is in the air. Attaching from the drag-start render's
  // passive effect loses moves and Option presses that arrive before it commits
  // (VC-530). A stationary hand must not need a second move to recover them.
  // ⌥ is read from TWO sources for the
  // reason the Lab rig documents: the key events alone miss a drag that STARTED
  // with ⌥ already down, and a keyup that never arrived (⌥ released while the
  // window lacked focus) would leave a column enlarged under a modifier nobody
  // is holding. Every pointer move carries the live answer, so both halves are
  // read from whichever event is fresher.
  const dragging = drag !== null;
  React.useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!pickerRef.current.dragging) return;
      const landing = pointerLanding(event.clientX, event.clientY);
      applyPicker({
        kind: "pointer-move",
        hovered: landing.status,
        modifierHeld: event.altKey,
        target: landing.target,
      });
    }
    function handleKey(event: KeyboardEvent) {
      if (!pickerRef.current.dragging) return;
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
  }, [applyPicker]);

  // The countdown owns bottom-centre while it is open: it has a deadline and
  // the one control, and the hint is advice. Two ephemeral surfaces on one edge
  // is a collision; this is which of them wins it.
  const countdownOpen = useArmedRunStore(
    (state) => frozen.current?.countdownOpen ?? Object.keys(state.pending).length > 0,
  );

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
  //
  // The same four caches the Ticket rail decides from, through the same
  // landed-version gate (VC-373) — what this project offers, what its columns
  // arm (VC-128), in what ORDER (VC-132) and which are switched on here
  // (VC-127). The board remounts on every return from a Ticket, and none of
  // these four can have moved just because it did; a planning refresh the
  // board missed while a Ticket was in front still re-reads, because it moved
  // the version these caches are marked at.
  React.useEffect(() => {
    void useAutomationsStore
      .getState()
      .refreshRail(projectId, useBoardStore.getState().lastPlanningChange.version);
  }, [projectId]);

  React.useEffect(() => {
    if (selectedIds.length === 0) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || dragging) return;
      // During a drag, Escape belongs to dnd-kit's cancellation path and keeps
      // the selected group intact. At rest it remains the board deselect key.
      // An Escape aimed at a focused control — the add-card composer, the ⌘K
      // search pill, an open context menu/dialog — is that control's dismissal,
      // not a board deselect; it still bubbles to window, so filter it out here.
      if (isEscapeExempt(event.target)) return;
      selectionAnchor.current = null;
      selectTicket(projectId, null);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds.length, projectId, selectTicket, dragging]);

  // distance: 4 keeps plain clicks (selection, context menu) working — the
  // drag only activates after pointer travel through the browser event
  // pipeline. Keyboard drags come free with the sortable coordinate getter.
  //
  // Read-only (VC-576): a move is a write, so no drag can start while the
  // project's host cannot serve — the same two sensors, set never to
  // activate (dnd-kit wants the sensor list's size fixed). Cards still open
  // and select.
  const canWrite = useCanWrite(projectId);
  const sensors = useSensors(
    useSensor(PointerSensor, canWrite ? POINTER_DRAG : POINTER_NEVER),
    useSensor(KeyboardSensor, canWrite ? KEYBOARD_DRAG : KEYBOARD_NEVER),
  );

  const tickets = drag?.preview ?? storeTickets;
  // The other reads need no `drag?.` fallback of their own: during a gesture
  // their selectors already answer from `frozen` (see `FrozenReads`), so
  // `filter`, `boardSort`, `projectLabels` and `boardView` ARE the gesture's
  // snapshot for as long as it lasts. `preview` above is the one exception,
  // because a drag rewrites it on every drag-over rather than holding it still.
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

  // What a click needs to know, read AT CLICK TIME rather than closed over.
  //
  // `handleSelect` is a prop on every column and, through them, on every card,
  // so a closure whose identity moved with the ticket slice re-rendered the
  // whole DnD subtree for a mutation that changed nothing on screen — which is
  // precisely what an Automation's roster replacement is (see `DragState`), and
  // it did it while a card was in the air. The ref is safe for the same reason
  // `pickerColumnsRef` above is: this callback only ever runs from an event
  // handler, which is always after the commit that wrote it.
  const selectionInputs = React.useRef({ storeTickets, selectedIds, sortedGroups });
  selectionInputs.current = { storeTickets, selectedIds, sortedGroups };
  const handleSelect = React.useCallback(
    (ticketId: string, gesture: TicketSelectionGesture) => {
      const {
        storeTickets: all,
        selectedIds: selected,
        sortedGroups: shownGroups,
      } = selectionInputs.current;
      const clicked = all.find((ticket) => ticket.id === ticketId);
      if (!clicked) return;
      const next = ticketSelectionAfterClick(
        selected,
        ticketId,
        {
          allIds: all
            .filter((ticket) => ticket.status === clicked.status)
            .map((ticket) => ticket.id),
          visibleIds: shownGroups[clicked.status].map((ticket) => ticket.id),
        },
        selectionAnchor.current,
        gesture,
      );
      selectionAnchor.current = next.anchorId;
      selectTickets(projectId, next.selectedIds);
    },
    [projectId, selectTickets],
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

  // Coming BACK from a ticket opened with Enter: focus returns to the card or
  // row it left from (VC-419). The board is re-mounted from scratch on that
  // return, so this runs on mount and is a no-op for every other way of
  // arriving here — see `use-ticket-focus-handoff.ts`.
  //
  // `revealTicketId` is the one thing the hook cannot do from the DOM: a card
  // 50 rows down a windowed column is not mounted to be focused, so the column
  // that holds it scrolls it into its window first, through the same
  // `scrollOffsetForRow` path a selection made elsewhere takes. Released as
  // soon as focus lands, so it never pins a column against later scrolling.
  const [revealTicketId, setRevealTicketId] = React.useState<string | null>(null);
  useTicketFocusRestore({ projectId, shownIds: selectionOrder, onReveal: setRevealTicketId });
  // Stable (the column passes its own status back) so columns aren't handed a
  // fresh closure every board render.
  const handleComposerClose = React.useCallback(
    (status: TicketStatus) =>
      setExpandedEmptyStatus((current) => (current === status ? null : current)),
    [],
  );

  function handleDragStart({ active, activatorEvent }: DragStartEvent) {
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
    // The gesture's snapshot of every store read above `DndContext`, taken at
    // this instant. Until the gesture clears it, a store write — an
    // Automation's `hydrateProjectRoster` replacement above all — hands these
    // same references back through the selectors, so the board never
    // re-renders (and never re-measures) from outside the drag. Cleared at
    // every site that clears `drag`.
    frozen.current = {
      tickets: storeTickets,
      labels: projectLabels,
      filter,
      sort: boardSort,
      view: boardView,
      countdownOpen,
    };
    setDrag({
      activeTicket,
      selectedTickets,
      ticketIds,
      preview: storeTickets,
      hiddenAtStart: hidden,
      drop: null,
    });
    // A drag may BEGIN with ⌥ already down, and that drag never sees a keydown.
    // The activator event is the only place that fact exists.
    applyPicker({
      kind: "drag-start",
      modifierHeld: "altKey" in activatorEvent && activatorEvent.altKey === true,
    });
  }

  function handleDragOver({ over }: DragOverEvent) {
    if (!over) return;
    const overId = String(over.id);
    setDrag((current) => {
      if (!current) return current;

      // Returning to a selected source card cancels the previously aimed slot.
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
      // Freeze measured nodes for ONE card too (VC-329). Same-column reorder
      // fed useSortable's derived-transform reset; cross-column reparenting
      // could also feed core's active-node measureRect after rollback. Keeping
      // the original snapshot breaks both collision/layout feedback paths.
      // Source cards remain dimmed placeholders; only the detached overlay and
      // the intended slot change until the gesture finishes.
      return { ...current, drop };
    });
  }

  function handleDragEnd({ over }: DragEndEvent) {
    const completed = drag;
    // With the picker closed, releasing over no droppable cancels instead of
    // committing the last crossed column. With it open, the named picker row
    // owns the landing even if the pointer slips off during release.
    const releaseStatus =
      completed === null || over === null ? null : (completed.drop?.toStatus ?? null);
    const release = dragPickerRelease(pickerRef.current, releaseStatus);
    applyPicker({ kind: "drag-end" });

    if (completed === null || release === null) {
      frozen.current = null;
      setDrag(null);
      return;
    }

    // Keep an exact previewed slot when the release names that column. A picker
    // may instead name another column; that unpreviewed landing appends after
    // removing the active group, matching the one-card picker behavior.
    const drop =
      completed.drop !== null && release.status === completed.drop.toStatus
        ? completed.drop
        : completed.ticketIds.length > 1
          ? resolveGroupDrop(
              completed.preview,
              completed.ticketIds,
              completed.activeTicket.id,
              columnDroppableId(release.status),
            )
          : {
              toStatus: release.status,
              toIndex: completed.preview.filter(
                (ticket) =>
                  ticket.status === release.status && ticket.id !== completed.activeTicket.id,
              ).length,
            };
    const choice = deliberateChoice(release.status, release.choice);
    const sourceRects =
      !reducedMotion && completed.ticketIds.length > 1
        ? new Map(
            completed.ticketIds.flatMap((ticketId) => {
              const slot = ticketSlotElement(ticketId);
              return slot === null ? [] : [[ticketId, slot.getBoundingClientRect()] as const];
            }),
          )
        : null;
    frozen.current = null;
    setDrag(null);
    if (drop === null) return;
    // A drag that began before the host went away lands nowhere; the card
    // goes back and the reason shows.
    if (!guardWrite(projectId)) return;

    if (completed.ticketIds.length === 1) {
      void useBoardStore
        .getState()
        .moveTicket(projectId, completed.ticketIds[0]!, drop.toStatus, drop.toIndex, choice);
      return;
    }

    // Let dnd-kit tear down its measurement observers before the atomic group
    // changes parents. The board's layout effect consumes the captured source
    // rects immediately after the destination DOM commits, before it paints.
    window.requestAnimationFrame(() => {
      pendingSlotAnimation.current = sourceRects;
      void useBoardStore
        .getState()
        .moveTickets(projectId, completed.ticketIds, drop.toStatus, drop.toIndex, choice);
      // The IPC response can beat React's concurrent commit; clearing in the
      // Promise's finally would then erase the FLIP input before the layout
      // effect sees it. The effect clears eagerly, and this is only a stale-ref
      // fallback for a no-op/unmount path.
      window.setTimeout(() => {
        if (pendingSlotAnimation.current === sourceRects) pendingSlotAnimation.current = null;
      }, 1_000);
    });
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
    frozen.current = null;
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
          {/* Under the header and above everything that would fail without a
              folder: a project whose checkout has moved looks healthy here and
              breaks everywhere else (VC-430). Renders nothing in the ordinary
              case. */}
          <ProjectFolderBanner projectId={projectId} />
          {/* One DndContext drives BOTH views — same handlers, same preview/commit
            machinery, same ticket id space. The view branch lives inside it so the
            list view has full drag parity with the board; only the layout and the
            drag overlay's shape differ. Escape-clears-selection (above) is shared. */}
          <DndContext
            sensors={sensors}
            collisionDetection={boardCollision}
            // Stated rather than inherited — see `BOARD_MEASURING`.
            measuring={BOARD_MEASURING}
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
                aimedStatus={aimedStatus}
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
                // Which card is in the air, for the one thing outside this
                // component that has to know a drag is live: the picker smoke,
                // which cannot start reading a panel before dnd-kit has
                // actually activated (`automations-picker-smoke.mjs`).
                data-board-drag={drag === null ? undefined : drag.activeTicket.id}
                // How many cards the board is HOLDING, as against how many its
                // columns currently mount (VC-316). Published because the two
                // stopped being the same number when columns gained a window,
                // and "the board has finished drawing" is asked from outside
                // React — by the performance harness and the board smokes —
                // where counting card nodes would now answer the window's size.
                data-board-ticket-count={visible.length}
                className={cn(
                  // Columns cap below full height so a strip of canvas stays
                  // grab-able under them (Trello-style mouse pan). Scrollbar is
                  // hidden — drag / shift-wheel / trackpad replace it.
                  "flex min-h-0 flex-1 items-start gap-4 overflow-x-auto px-gutter pb-4",
                  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                  panning ? "cursor-grabbing select-none" : "cursor-grab",
                )}
              >
                {boardBare ? (
                  <BoardEmpty projectId={projectId} className="min-h-0 flex-1 self-stretch" />
                ) : null}
                {shown.map((status) => (
                  <BoardColumn
                    key={status}
                    status={status}
                    // What this column can run, mid-drag (VC-132) — the same
                    // panel the rail's pills draw, from the same builder.
                    offered={offeredPanelFor(status)}
                    dimmed={dimmedFor(status)}
                    aimed={aimedStatus === status}
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
                    // A card keyboard focus is coming home to (VC-419). Only
                    // the column that holds it hears about it; every other one
                    // is handed `null` and does nothing.
                    revealTicketId={revealTicketId}
                    // A column's window may only GROW while a card is in the
                    // air: see `column-window.ts`.
                    dragActive={drag !== null}
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
                    aimedFor={aimedFor}
                  />
                )}
              </div>
            )}
            <DragOverlay
              // Keep the full card behind the landing panel rather than
              // replacing it with a tiny id label while the person is aiming.
              zIndex={isPickerOpen(picker) ? 10 : 999}
              // The lifted card is a PICTURE, never a surface: dnd-kit's own
              // wrapper is a fixed, card-sized box at `z-index: 999` that
              // follows the pointer exactly, so without this it is the topmost
              // thing under the hand at every moment of the drag. When the
              // picker's hit test (`pointerLanding`) read only the topmost
              // thing, that answered "no column, no row" for any aim that ended
              // INSIDE the lifted card's own outline — most of them. It now
              // looks through to the first hit inside a column (VC-451), which
              // would skip the overlay anyway; this keeps the picture out of
              // the hit-test stack altogether, so nothing reading it — the
              // picker or anything later — can mistake the card for a surface.
              // A row aimed at and not taken is the one failure this gesture
              // cannot have: the release would run the column's default
              // instead of what the hand was pointing at.
              className="pointer-events-none"
              dropAnimation={
                // A picked release lands where the PICKER says, which is not
                // necessarily where the card is: animating the card into the
                // slot it was hovering would draw the wrong landing.
                reducedMotion || isPickerOpen(picker) || (drag?.ticketIds.length ?? 0) > 1
                  ? null
                  : { duration: 200, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
              }
            >
              {drag ? (
                <div
                  data-ticket-drag-preview
                  className={isPickerOpen(picker) ? "opacity-30" : undefined}
                >
                  <DragOverlayBody
                    activeTicket={drag.activeTicket}
                    tickets={drag.selectedTickets}
                    ticketPrefix={ticketPrefix}
                    projectLabels={projectLabels}
                    listView={boardView === "list"}
                    reducedMotion={reducedMotion}
                  />
                </div>
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
                  Choose automation · 0 Move only
                </p>
              </div>
            ) : null}
          </DndContext>
        </div>
      </TicketDialogHost>
    </BoardSessionActivityProvider>
  );
});
