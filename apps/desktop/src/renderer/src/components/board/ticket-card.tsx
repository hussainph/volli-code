import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type Ticket } from "@volli/shared";

import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { TagChip } from "@renderer/components/board/tag-chip";
import { TicketContextMenu } from "@renderer/components/board/ticket-context-menu";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";

/** Pure presentational card body — also rendered inside the drag overlay (always unselected there). */
export function TicketCardContent({
  ticket,
  selected = false,
}: {
  ticket: Ticket;
  selected?: boolean;
}) {
  return (
    <article
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 cursor-default select-none transition-[border-color] duration-150 ease-out",
        // Selection colors the card's own border: a ring draws OUTSIDE the box
        // and the column scroller clips its top edge on the first card.
        selected ? "border-primary/70" : "border-border hover:border-[#333333]",
      )}
    >
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

interface TicketCardProps {
  ticket: Ticket;
  projectId: string;
  selected: boolean;
  onSelect(): void;
}

// Sibling shift while a drag reorders the column: Linear-crisp, a strong
// ease-out well under 300ms (dnd-kit's 250ms default reads floaty).
const SORT_TRANSITION = { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" };

/** Sortable wrapper: the in-column card. Dims while its drag overlay is out. */
export function TicketCard({ ticket, projectId, selected, onSelect }: TicketCardProps) {
  const reducedMotion = useReducedMotion();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    transition: reducedMotion ? null : SORT_TRANSITION,
  });

  return (
    <TicketContextMenu ticket={ticket} projectId={projectId}>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        className={cn(isDragging && "opacity-40")}
        onClick={onSelect}
        {...attributes}
        {...listeners}
      >
        <TicketCardContent ticket={ticket} selected={selected} />
      </div>
    </TicketContextMenu>
  );
}
