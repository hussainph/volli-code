import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

import { Button } from "@renderer/components/ui/button";

/**
 * Right-rail "Sessions" section: empty state + a visually-present but
 * disabled "New session" button. Step 6 wires this up to real rows (harness
 * identity + working/idle/exited status chip, decision #5) sourced from
 * `api.sessions.listForTicket`, and makes the button boot a ticket-scoped
 * terminal (env-injected `VOLLI_TICKET`/`VOLLI_TICKET_DIR`, decision #16)
 * that opens as a tab in the tab plane above (decision #6).
 */
export function TicketSessionsPanel() {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Sessions
        </h2>
        <Button size="icon-xs" variant="ghost" disabled aria-label="New session">
          <PlusIcon />
        </Button>
      </div>
      <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-border py-6 text-center">
        <TerminalWindowIcon weight="fill" className="size-4 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">No sessions yet</p>
      </div>
    </section>
  );
}
