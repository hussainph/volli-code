import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Ticket } from "@volli/shared";

import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { TagChip } from "@renderer/components/board/tag-chip";
import { cn } from "@renderer/lib/utils";

/** Pure presentational card body — also rendered inside the drag overlay. */
export function TicketCardContent({ ticket }: { ticket: Ticket }) {
  return (
    <article className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 hover:border-[#333333] cursor-default select-none">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{ticket.id}</span>
        <PriorityIndicator priority={ticket.priority} />
      </div>
      <p className="text-sm font-medium leading-snug text-foreground line-clamp-2">
        {ticket.title}
      </p>
      {ticket.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {ticket.tags.map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

/** Sortable wrapper: the in-column card. Dims while its drag overlay is out. */
export function TicketCard({ ticket }: { ticket: Ticket }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      <TicketCardContent ticket={ticket} />
    </div>
  );
}
