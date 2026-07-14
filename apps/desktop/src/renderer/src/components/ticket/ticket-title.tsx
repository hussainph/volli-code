import * as React from "react";
import type { Ticket } from "@volli/shared";

import { useBoardStore } from "@renderer/stores/board";

/**
 * The ticket's title, click-to-edit (ticket-detail-mvp decision #12). Clicking
 * the heading flips it to a single-line input seeded with the current title;
 * Enter or blur commits via the board store's `updateTicket({ title })`
 * (a no-op when unchanged), Escape reverts without writing (and
 * `stopPropagation`s so the detail shell's Escape-to-close never fires). An
 * empty title is rejected — the edit reverts and nothing is written, since a
 * ticket must always have a title. Commit failures surface via the store toast.
 */
export function TicketTitle({ ticket }: { ticket: Ticket }) {
  const updateTicket = useBoardStore((state) => state.updateTicket);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(ticket.title);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  function enterEdit() {
    setDraft(ticket.title);
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    // Reject an empty title (revert) and skip a no-op write.
    if (trimmed === "" || trimmed === ticket.title) return;
    void updateTicket({ ticketId: ticket.id, title: trimmed });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // the shell's Escape-to-close must not fire
      setEditing(false); // revert: discard the draft, write nothing
    }
  }

  // Seamless flip (ticket-detail live-preview pass): the input carries the exact
  // h1 typography with no border, background, or accent ring — the caret is the
  // only cue that you're editing, so nothing shifts when you click in.
  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        aria-label="Ticket title"
        className="w-full bg-transparent text-2xl font-semibold tracking-tight text-foreground outline-none"
      />
    );
  }

  return (
    <h1
      role="button"
      tabIndex={0}
      onClick={enterEdit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          enterEdit();
        }
      }}
      className="cursor-text text-2xl font-semibold tracking-tight text-foreground outline-none"
    >
      {ticket.title}
    </h1>
  );
}
