/** Compact board page header: title + total ticket count. */
export function BoardHeader({ ticketCount }: { ticketCount: number }) {
  return (
    <div className="flex items-center gap-3 px-4 pt-3 pb-3">
      <h2 className="text-sm font-semibold">Board</h2>
      <span className="font-mono text-xs text-muted-foreground">{ticketCount}</span>
      {/* FilterBar lands with the filter commit */}
    </div>
  );
}
