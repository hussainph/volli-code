import { useDroppable } from "@dnd-kit/core";
import { TICKET_STATUS_LABELS, type TicketStatus } from "@volli/shared";

import { columnDroppableId } from "@renderer/components/board/board-dnd";
import { SectionHeading } from "@renderer/components/ui/section-heading";
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
  onExpand,
  animateEnter,
}: {
  statuses: TicketStatus[];
  dragActive: boolean;
  onExpand(status: TicketStatus): void;
  /** Play the enter transition — true for pills appearing on an already-mounted board. */
  animateEnter: boolean;
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
}: {
  status: TicketStatus;
  dragActive: boolean;
  onExpand(status: TicketStatus): void;
  animateEnter: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDroppableId(status) });

  return (
    <button
      type="button"
      ref={setNodeRef}
      onClick={() => {
        if (!dragActive) onExpand(status);
      }}
      className={cn(
        "flex items-center justify-between rounded-md border border-border/50 px-4 py-2 text-left text-ui text-muted-foreground outline-none",
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
  );
}
