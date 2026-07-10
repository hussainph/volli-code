import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

/** Placeholder: global, ticket-less scratch sessions land with the terminal spike. */
export function SessionsPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <TerminalWindowIcon weight="fill" className="size-8 text-muted-foreground" />
      <h2 className="text-lg font-semibold">Sessions</h2>
      <p className="text-sm text-muted-foreground">
        Global scratch sessions — plan, brainstorm, and orchestrate outside any ticket.
      </p>
    </div>
  );
}
