import { SquareKanban } from "lucide-react";

/** Placeholder: the kanban board lands with the ticket layer (M1). */
export function BoardPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <SquareKanban className="size-8 text-muted-foreground" />
      <h2 className="text-lg font-semibold">Board</h2>
      <p className="text-sm text-muted-foreground">
        The kanban board lands with the ticket layer (M1).
      </p>
    </div>
  );
}
