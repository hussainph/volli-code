import * as React from "react";
import type { Ticket } from "@volli/shared";

import { InlineRename } from "@renderer/components/ui/inline-rename";
import { useBoardStore } from "@renderer/stores/board";

/**
 * The ticket's title, click-to-edit (ticket-detail-mvp decision #12). Clicking
 * the heading flips it to a single-line field seeded with the current title;
 * Enter or blur commits via the board store's `updateTicket({ title })`, Escape
 * reverts without writing. An empty title is rejected — the edit reverts and
 * nothing is written, since a ticket must always have a title. Commit failures
 * surface via the store toast.
 *
 * The field is `ui/inline-rename.tsx`, which is where the commit semantics now
 * live: unchanged and empty both resolve to a cancel, Escape stops propagating
 * so the detail shell's Escape-to-close never fires, and — the reason this file
 * changed — a one-shot latch means Enter cannot write twice. This component had
 * `onBlur={commit}` beside an Enter that also committed, and no guard between
 * them; the second pass compared the draft against a `ticket.title` that had
 * not round-tripped through the store yet, so the no-op check still saw a
 * change and fired a second `updateTicket`.
 */
export function TicketTitle({ ticket }: { ticket: Ticket }) {
  const updateTicket = useBoardStore((state) => state.updateTicket);
  const [editing, setEditing] = React.useState(false);

  // Seamless flip (ticket-detail live-preview pass): the field carries the exact
  // h1 typography with no border, background, or accent ring — the caret is the
  // only cue that you're editing, so nothing shifts when you click in.
  if (editing) {
    return (
      <InlineRename
        value={ticket.title}
        size="title"
        ariaLabel="Ticket title"
        onCommit={(title) => {
          setEditing(false);
          void updateTicket({ ticketId: ticket.id, title });
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <h1
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          setEditing(true);
        }
      }}
      className="cursor-text text-title font-semibold text-foreground outline-none"
    >
      {ticket.title}
    </h1>
  );
}
