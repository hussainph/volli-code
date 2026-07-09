import { Terminal } from "lucide-react";

/** Placeholder: global, ticket-less scratch sessions land with the terminal spike. */
export function SessionsPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <Terminal className="size-8 text-muted-foreground" />
      <h2 className="text-lg font-semibold">Sessions</h2>
      <p className="text-sm text-muted-foreground">
        Global scratch sessions — plan, brainstorm, and orchestrate outside any ticket.
      </p>
    </div>
  );
}
