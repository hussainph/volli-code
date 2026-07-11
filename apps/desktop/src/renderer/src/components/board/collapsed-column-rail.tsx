import { useDroppable } from "@dnd-kit/core";
import { TICKET_STATUS_LABELS, type TicketStatus } from "@volli/shared";

import { columnDroppableId } from "@renderer/components/board/board-dnd";
import { cn } from "@renderer/lib/utils";

/**
 * Rail of empty columns collapsed into pills at the board's right end.
 * Each pill is the live droppable for its column (it shares the column's
 * droppable id — a status is never a column and a pill at once); dropping
 * a card expands the column in place on drop.
 */
export function CollapsedColumnRail({
  statuses,
  dragActive,
  animateEnter,
}: {
  statuses: TicketStatus[];
  dragActive: boolean;
  /** Play the enter transition — true for pills appearing on an already-mounted board. */
  animateEnter: boolean;
}) {
  if (statuses.length === 0) return null;

  return (
    <div className="flex w-44 flex-none flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">Empty</span>
      {statuses.map((status) => (
        <CollapsedColumnTarget
          key={status}
          status={status}
          dragActive={dragActive}
          animateEnter={animateEnter}
        />
      ))}
    </div>
  );
}

function CollapsedColumnTarget({
  status,
  dragActive,
  animateEnter,
}: {
  status: TicketStatus;
  dragActive: boolean;
  animateEnter: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDroppableId(status) });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground",
        "transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-150 ease-out",
        animateEnter && "starting:scale-[0.98] starting:opacity-0 motion-reduce:starting:scale-100",
        // While any card is mid-drag every pill brightens into an affordance…
        dragActive && "border-border text-foreground/80",
        // …and the hovered one lights up as the drop target.
        isOver && "border-transparent bg-accent ring-1 ring-primary/60",
      )}
    >
      <span>{TICKET_STATUS_LABELS[status]}</span>
      <span className="font-mono text-[11px]">0</span>
    </div>
  );
}
