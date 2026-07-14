import type { Ticket } from "@volli/shared";

/**
 * The Doc tab's content: the ticket's markdown body, rendered as plain
 * preformatted text for now — step 4 replaces this with typeset markdown
 * render + click-to-edit (shadcn/typeset, decision #9) and debounced
 * autosave. Below it, an Activity placeholder — step 4 builds the merged
 * property-change + comment feed there.
 */
export function TicketDocTab({ ticket }: { ticket: Ticket }) {
  return (
    <div className="flex flex-col gap-6 py-4">
      {ticket.body.trim() === "" ? (
        <p className="text-sm text-muted-foreground">No description yet.</p>
      ) : (
        <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-foreground">
          {ticket.body}
        </pre>
      )}
      <section className="border-t border-border pt-4">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Activity
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Comments and history will show up here.
        </p>
      </section>
    </div>
  );
}
