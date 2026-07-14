import type { Ticket } from "@volli/shared";

/**
 * The ticket's title, main-column, above-the-fold. Static for now — this
 * component is the seam step 4 replaces with click-to-edit (Notion-like
 * semantics: click flips it into a text field, blur/⌘-Enter flips back,
 * firing a `retitled` event), so callers already pass `ticket` rather than a
 * bare string.
 */
export function TicketTitle({ ticket }: { ticket: Ticket }) {
  return <h1 className="text-2xl font-semibold tracking-tight text-foreground">{ticket.title}</h1>;
}
