import { useDroppable } from "@dnd-kit/core";
import { TICKET_STATUS_LABELS, type TicketStatus } from "@volli/shared";

import { columnDroppableId } from "@renderer/components/board/board-dnd";
import {
  ColumnOfferedPanel,
  type ColumnOfferedPanelProps,
} from "@renderer/components/board/column-offered-panel";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { cn } from "@renderer/lib/utils";

/**
 * Rail of empty columns collapsed into pills at the board's right end.
 * Each pill is the live droppable for its column (it shares the column's
 * droppable id — a status is never a column and a pill at once); dropping
 * a card expands the column in place on drop.
 *
 * A pill is a COLUMN drawn small, and the ⌥ picker (VC-132) treats it as one:
 * it carries `data-board-column` like a standing column's root, and it grows
 * the same Offered list panel. What a column offers is a fact about the column
 * — its Trigger membership and its rank — and has nothing to do with whether
 * any ticket happens to be sitting in it, so an ARMED empty column had to be
 * reachable here. Without it, ⌥ held over the one column shape that can still
 * fire on arrival opened nothing, the hint never appeared, `Move only` could
 * not be aimed at, and the release started the armed countdown anyway: a held
 * modifier with nothing honouring it, which is the rejected Option-alone
 * design's exact failure.
 */
export function CollapsedColumnRail({
  statuses,
  dragActive,
  onExpand,
  animateEnter,
  offeredFor,
  dimmedFor,
}: {
  statuses: TicketStatus[];
  dragActive: boolean;
  onExpand(status: TicketStatus): void;
  /** Play the enter transition — true for pills appearing on an already-mounted board. */
  animateEnter: boolean;
  /** This pill's Offered list mid-drag, or `undefined` when there is none to draw. */
  offeredFor?: (status: TicketStatus) => ColumnOfferedPanelProps | undefined;
  /** Quieted because another column is currently grown into landing targets. */
  dimmedFor?: (status: TicketStatus) => boolean;
}) {
  if (statuses.length === 0) return null;

  return (
    <div className="flex w-44 flex-none cursor-default flex-col gap-1">
      {/* A shade under the standard mute: this rail names a column that is not
          there, and must never compete with the columns that are. */}
      <SectionHeading as="span" className="text-muted-foreground/70">
        Empty
      </SectionHeading>
      {statuses.map((status) => (
        <CollapsedColumnTarget
          key={status}
          status={status}
          dragActive={dragActive}
          onExpand={onExpand}
          animateEnter={animateEnter}
          offered={offeredFor?.(status)}
          dimmed={dimmedFor?.(status) ?? false}
        />
      ))}
    </div>
  );
}

function CollapsedColumnTarget({
  status,
  dragActive,
  onExpand,
  animateEnter,
  offered,
  dimmed,
}: {
  status: TicketStatus;
  dragActive: boolean;
  onExpand(status: TicketStatus): void;
  animateEnter: boolean;
  offered: ColumnOfferedPanelProps | undefined;
  dimmed: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDroppableId(status) });

  return (
    <div
      // Read by the picker's one `elementFromPoint` per pointer move, exactly
      // as a standing column's root is (board.tsx's `pointerLanding`). On a
      // wrapper rather than on the button so the panel floating over the pill
      // still reads as this column.
      data-board-column={status}
      className={cn(
        "relative transition-opacity duration-200 ease-out motion-reduce:transition-none",
        // Quieted while another column holds the picker, like the standing
        // columns. Opacity only: the pill is a dnd-kit droppable measured in
        // synchronous layout effects, and this wrapper is what holds its rect.
        dimmed && "opacity-50",
      )}
    >
      <button
        type="button"
        ref={setNodeRef}
        onClick={() => {
          if (!dragActive) onExpand(status);
        }}
        className={cn(
          "flex w-full items-center justify-between rounded-md border border-border/50 px-4 py-2 text-left text-ui text-muted-foreground outline-none",
          // No scale in this list, ever: the pill is a dnd-kit droppable measured
          // in synchronous layout effects, and a scale mid-flight yields a new
          // rect every commit — measureRects loops to React's max update depth
          // (the DndContext crash). Enter is an opacity fade only.
          "transition-[color,background-color,border-color,box-shadow,opacity] duration-150 ease-out",
          "hover:border-border hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
          animateEnter && "starting:opacity-0",
          // While any card is mid-drag every pill brightens into an affordance…
          dragActive && "border-border text-foreground/70",
          // …and the hovered one lights up as the drop target.
          isOver && "border-transparent bg-accent ring-1 ring-primary/50",
        )}
      >
        <span>{TICKET_STATUS_LABELS[status]}</span>
        <span className="font-mono text-label">0</span>
      </button>
      {/* Floated, never in the flow: the pill IS the droppable, and a panel
          that grew and shrank in the layout would move the rect dnd-kit
          measures every time ⌥ went down — the same reason the standing column
          floats its own panel (`column-offered-panel.tsx`).

          Hung BELOW the pill rather than over it, which is where the standing
          column puts its own: a column's panel covers cards, and this one would
          otherwise cover the only thing naming the column being aimed at. It
          also keeps the pill itself pointable, so ⌥ grows the list out from
          under nothing — the hand is still resting on the pill when the targets
          appear beneath it. */}
      {offered === undefined ? null : (
        <div className="absolute inset-x-0 top-full z-20 pt-1">
          <ColumnOfferedPanel {...offered} />
        </div>
      )}
    </div>
  );
}
