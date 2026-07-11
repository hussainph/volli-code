import { TICKET_STATUS_LABELS, type TicketStatus } from "@volli/shared";

/** Static rail listing empty columns as collapsed pills; becomes droppable later. */
export function CollapsedColumnRail({ statuses }: { statuses: TicketStatus[] }) {
  if (statuses.length === 0) return null;

  return (
    <div className="flex w-44 flex-none flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">Empty</span>
      {statuses.map((status) => (
        <div
          key={status}
          className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground"
        >
          <span>{TICKET_STATUS_LABELS[status]}</span>
          <span className="font-mono text-[11px]">0</span>
        </div>
      ))}
    </div>
  );
}
