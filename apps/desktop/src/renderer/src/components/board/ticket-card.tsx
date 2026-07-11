import type { Ticket } from "@volli/shared";

import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { TagChip } from "@renderer/components/board/tag-chip";

/** Pure presentational card body — reused by the drag overlay once dnd lands. */
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

/** Thin wrapper around {@link TicketCardContent}; becomes the sortable drag handle later. */
export function TicketCard({ ticket }: { ticket: Ticket }) {
  return (
    <div>
      <TicketCardContent ticket={ticket} />
    </div>
  );
}
