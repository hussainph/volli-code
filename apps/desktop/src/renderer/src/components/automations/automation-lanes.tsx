/**
 * The lane view (VC-112, VC-132): one lane per board column, holding that
 * column's **Offered list in digit order**, arranged by dragging.
 *
 * This is the surface VC-127 deliberately did not build — "building a lane view
 * before columns can be a Trigger would be drawing lanes with nothing to put in
 * them". Now they can, and the lanes have exactly one job the flat list below
 * them cannot do: they are where the ORDER lives. Everything else about a
 * record — create, edit, duplicate, enable, delete, run — stays in the list,
 * because this page is the one authoring surface and a second one drawn as a
 * board would be two.
 *
 * Three rules the drawing has to keep saying:
 *
 *  - **The digit printed here is the digit that works mid-drag.** Both come out
 *    of one composition (`offeredAutomationsInDigitOrder` over the same four
 *    machine-local reads), which is the whole reason per-column rank is
 *    machine-local like the arming that pins it.
 *  - **One Automation can hold a different rank in two columns.** A row is a
 *    (column, Automation) pair, never a record — hence the composite drag id,
 *    and hence a lane that reorders without touching any other lane.
 *  - **The armed row is pinned to `1` only while it is switched on here.** In
 *    that effective state it does not drag, and its stored rank is untouched by
 *    everything that moves around it. When switched off it keeps its authored
 *    digit, stays draggable, and is annotated instead: a plain drop then starts
 *    nothing, so a pin would promise a Run that will not come.
 *
 * A row does not move BETWEEN lanes. Which lanes an Automation appears in is
 * its Trigger, and the Trigger is authored in the editor; a cross-lane drag
 * would rewrite a field of the record from a surface that is arranging digits.
 *
 * Motion: dnd-kit's sortable shift, dropped under reduced motion the way the
 * board's cards and the tab strip already drop theirs. Nothing here dwells.
 */
import * as React from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DotsSixVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsSixVertical";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import {
  armedAutomationFor,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Automation,
  type TicketStatus,
} from "@volli/shared";

import { laneDropRank, laneRowId, SWITCHED_OFF_NOTE } from "./automations-page-model";
import { ColumnArmingButton } from "@renderer/components/board/column-arming";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import {
  effectiveArmedIn,
  offeredInDigitOrder,
  offeredInRankOrder,
  selectArmings,
  selectAutomations,
  selectColumnOrders,
  useAutomationsStore,
} from "@renderer/stores/automations";

/** Sibling shift while a lane is arranged — the board card's own number, copied deliberately. */
const LANE_SORT_TRANSITION = { duration: 180, easing: "var(--ease-out)" };

/** One lane's whole content, composed once for both the drawing and the drop. */
interface Lane {
  status: TicketStatus;
  /** The digit order, effective arming pinned to `1` and capped at nine. */
  digits: readonly Automation[];
  /** The authored rank, uncapped: the list a drop rewrites. */
  authored: readonly Automation[];
  /** The valid arming row, whether switched on here or not. */
  armedId: string | null;
  /** The effective armed Automation's id, pinned to slot 1 and not draggable. */
  pinnedId: string | null;
}

export function AutomationLanes({ projectId }: { projectId: string }) {
  const automations = useAutomationsStore((state) => selectAutomations(state, projectId));
  const armings = useAutomationsStore((state) => selectArmings(state, projectId));
  const orders = useAutomationsStore((state) => selectColumnOrders(state, projectId));
  const enabledIds = useAutomationsStore((state) => state.enabledIds);
  const setColumnOrder = useAutomationsStore((state) => state.setColumnOrder);
  const reducedMotion = useReducedMotion();

  // Composed by the STORE's own three compositions, never here: the digit this
  // lane prints and the digit the board's ⌥ picker answers have to be one list,
  // and the only way to make that structural rather than a promise is for both
  // surfaces to run the same function. The four slices are subscribed raw above
  // and handed in — see `OfferedListSlices` for why they cannot be subscribed
  // to already composed.
  const lanes = React.useMemo<readonly Lane[]>(() => {
    const slices = { automations, armings, orders, enabledAutomationIds: enabledIds };
    return TICKET_STATUSES.map((status) => ({
      status,
      digits: offeredInDigitOrder(slices, status),
      authored: offeredInRankOrder(slices, status),
      armedId: armedAutomationFor(automations, armings, status)?.id ?? null,
      pinnedId: effectiveArmedIn(slices, status)?.id ?? null,
    }));
  }, [automations, armings, orders, enabledIds]);

  // Automations that answer to no column: listed so the page never hides a
  // record, and digitless because a digit means "this column's row N".
  //
  // The complement of the lanes rather than the "Nothing else" Trigger alone: a
  // schedule record is offered by no column either, and filtering for `none`
  // left a schedule-only project reading "Every automation has a column" —
  // a completeness claim under a view that was hiding the records. Stated as
  // "not a column Trigger" so a Trigger kind added later lands here by default
  // instead of vanishing.
  const offBoard = React.useMemo(
    () => automations.filter((automation) => automation.trigger.kind !== "columns"),
    [automations],
  );

  const sensors = useSensors(
    // The board's and the tab strip's constraint: a plain click still selects,
    // and the drag engages only after real travel.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd({ active, over }: DragEndEvent) {
    const lane = lanes.find((candidate) =>
      candidate.digits.some(
        (automation) => laneRowId(candidate.status, automation.id) === String(active.id),
      ),
    );
    if (lane === undefined) return;
    const drop = laneDropRank({
      authoredIds: lane.authored.map((automation) => automation.id),
      visibleIds: draggableRows(lane).map((automation) => automation.id),
      activeId: String(active.id),
      overId: over === null ? null : String(over.id),
    });
    if (drop === null) return;
    void setColumnOrder({
      projectId,
      status: drop.status,
      rankedAutomationIds: drop.rankedAutomationIds,
    }).then((refusal) => {
      // The lane is still on screen, but a refusal here is not a correction to
      // anything a person can retype — it is a write that did not happen, so it
      // toasts like every other failed mutation.
      if (refusal !== null) toastError(`Couldn't reorder this column: ${refusal}`);
    });
  }

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading className="h-6 leading-6">Columns</SectionHeading>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="flex gap-2 overflow-x-auto pb-2">
          {lanes.map((lane) => (
            <LaneColumn
              key={lane.status}
              projectId={projectId}
              lane={lane}
              reducedMotion={reducedMotion}
            />
          ))}
          <OffBoardLane automations={offBoard} />
        </div>
      </DndContext>
    </section>
  );
}

/** The rows a lane lets a hand move: everything but the pinned armed row. */
function draggableRows(lane: Lane): readonly Automation[] {
  return lane.digits.filter((automation) => automation.id !== lane.pinnedId);
}

function LaneColumn({
  projectId,
  lane,
  reducedMotion,
}: {
  projectId: string;
  lane: Lane;
  reducedMotion: boolean;
}) {
  const movable = draggableRows(lane);
  return (
    <div className="flex w-64 shrink-0 flex-col gap-1 rounded-lg bg-muted/30 p-2">
      {/* `group/column-header` is what the bolt's hover reveal reads: the same
          control as the board's, so arming a column from the page and arming it
          from the board are provably one act (and one store door). */}
      <div className="group/column-header flex items-center gap-2 px-1">
        <span className="text-ui font-medium text-foreground">
          {TICKET_STATUS_LABELS[lane.status]}
        </span>
        <span className="text-label text-muted-foreground tabular-nums">
          {lane.digits.length === 0 ? "" : lane.digits.length}
        </span>
        <div className="flex-1" />
        <ColumnArmingButton projectId={projectId} status={lane.status} />
      </div>
      {lane.digits.length === 0 ? (
        <p className="px-1 py-1 text-ui text-muted-foreground">Nothing offered here</p>
      ) : null}
      <SortableContext
        items={movable.map((automation) => laneRowId(lane.status, automation.id))}
        strategy={verticalListSortingStrategy}
      >
        {lane.digits.map((automation, index) => (
          <LaneRow
            key={automation.id}
            status={lane.status}
            automation={automation}
            digit={index + 1}
            pinned={automation.id === lane.pinnedId}
            switchedOff={automation.id === lane.armedId && automation.id !== lane.pinnedId}
            reducedMotion={reducedMotion}
          />
        ))}
      </SortableContext>
    </div>
  );
}

function LaneRow({
  status,
  automation,
  digit,
  pinned,
  switchedOff,
  reducedMotion,
}: {
  status: TicketStatus;
  automation: Automation;
  digit: number;
  pinned: boolean;
  switchedOff: boolean;
  reducedMotion: boolean;
}) {
  // Two components would need two hook orders; one component with a disabled
  // sortable keeps dnd-kit's own opt-out where it belongs.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: laneRowId(status, automation.id),
    disabled: pinned,
    // `null` is dnd-kit's own "do not animate": under reduced motion the
    // siblings jump to their new places instead of sliding.
    transition: reducedMotion ? null : LANE_SORT_TRANSITION,
  });

  return (
    <div
      ref={setNodeRef}
      data-lane-row={laneRowId(status, automation.id)}
      data-lane-digit={digit}
      data-lane-arming={pinned ? "ready" : switchedOff ? "switched-off" : undefined}
      // Whether dnd-kit has actually picked this row up — for the page smoke,
      // which cannot aim a drop before the drag it is aiming has begun
      // (`automations-page-smoke.mjs`, the same hook the board's own drag
      // exposes as `data-board-drag`).
      data-lane-dragging={isDragging ? "true" : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition: transition ?? undefined }}
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1",
        isDragging && "z-10 opacity-50",
        pinned ? "cursor-default" : "cursor-grab",
      )}
      {...(pinned ? {} : attributes)}
      {...(pinned ? {} : listeners)}
    >
      {pinned ? (
        // The bolt stands in for the grip on the one row that does not move:
        // it is armed and switched on here, so it IS digit 1 — and its stored
        // rank is waiting underneath for the day the effective pin lets go.
        <LightningIcon weight="fill" className="size-3 shrink-0 text-foreground" />
      ) : (
        <DotsSixVerticalIcon className="size-3 shrink-0 text-muted-foreground" />
      )}
      <kbd className="shrink-0 rounded-sm border border-border px-1 font-mono text-label text-muted-foreground">
        {digit}
      </kbd>
      <span className="min-w-0 flex-1 truncate text-ui text-foreground">{automation.name}</span>
      {switchedOff ? (
        <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
          <LightningIcon weight="bold" className="size-3" />
          Armed · {SWITCHED_OFF_NOTE}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Automations no column offers. They are here because a page that showed only
 * the board's lanes would hide every record whose Trigger is "Nothing else" —
 * the default a new Automation is born with — behind a view that looks
 * complete. No digits: a digit is a column's row number, and these answer to no
 * column.
 */
function OffBoardLane({ automations }: { automations: readonly Automation[] }) {
  return (
    <div className="flex w-64 shrink-0 flex-col gap-1 rounded-lg border border-dashed border-border p-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-ui font-medium text-muted-foreground">No column</span>
        <span className="text-label text-muted-foreground tabular-nums">
          {automations.length === 0 ? "" : automations.length}
        </span>
      </div>
      {automations.length === 0 ? (
        <p className="px-1 py-1 text-ui text-muted-foreground">Every automation has a column.</p>
      ) : (
        automations.map((automation) => (
          <div
            key={automation.id}
            data-lane-row={`none:${automation.id}`}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1"
          >
            <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
              {automation.name}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
