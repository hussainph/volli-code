import * as React from "react";
import type { Ticket } from "@volli/shared";

import { MarkdownLiveEditor } from "@renderer/components/editor/markdown-live-editor";
import { createDebouncer, type Debouncer } from "@renderer/lib/debounce";
import { useBoardStore } from "@renderer/stores/board";

const AUTOSAVE_IDLE_MS = 1500;

/**
 * The Doc tab's body: an always-mounted Obsidian-style live-preview editor
 * (see components/editor). The markdown buffer IS the document — syntax renders
 * in place and there's no read/edit flip. Edits autosave ~1.5s after the last
 * keystroke via the board store's `updateTicket({ body })`, and the pending save
 * flushes immediately on blur and on unmount so the last ~1.5s of typing is
 * never lost. `lastSavedRef` guards a redundant IPC/event when nothing changed
 * since the previous write; a failed save surfaces via the store's own toast.
 * Escape blurs the editor (handled inside the editor keymap) and — because the
 * focused `.cm-content` is contenteditable, which the detail shell's
 * Escape-to-close guard already exempts — never closes the view; once unfocused,
 * Escape bubbles and closes as usual.
 */
export function TicketBodyEditor({ ticket }: { ticket: Ticket }) {
  const updateTicket = useBoardStore((state) => state.updateTicket);

  const draftRef = React.useRef(ticket.body);
  // The value last written through — guards a redundant IPC/event when a
  // debounced save and a blur-flush both fire with nothing changed since, and
  // when a background refresh resets the buffer to content already on disk.
  const lastSavedRef = React.useRef(ticket.body);

  // Track external body changes (agent edits, store rehydrate) as the new
  // "saved" baseline. When the editor is unfocused it adopts the new value and
  // the resulting programmatic edit must not echo a redundant write — this
  // keeps `lastSavedRef` aligned with what's already persisted.
  React.useEffect(() => {
    lastSavedRef.current = ticket.body;
  }, [ticket.body]);

  const save = React.useCallback(() => {
    const next = draftRef.current;
    if (next === lastSavedRef.current) return;
    lastSavedRef.current = next;
    void updateTicket({ ticketId: ticket.id, body: next });
  }, [updateTicket, ticket.id]);

  // The debouncer is created once (ref) but must always call the LATEST `save`
  // (which closes over the current ticket id) — so it calls through a ref.
  const saveRef = React.useRef(save);
  React.useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const debouncerRef = React.useRef<Debouncer | null>(null);
  if (debouncerRef.current === null) {
    debouncerRef.current = createDebouncer(() => saveRef.current(), AUTOSAVE_IDLE_MS);
  }
  const debouncer = debouncerRef.current;

  // Flush any pending save if the component unmounts mid-edit (e.g. the ticket
  // is closed) — never lose the last ~1.5s of typing.
  React.useEffect(() => () => debouncer.flush(), [debouncer]);

  function handleChange(next: string) {
    draftRef.current = next; // immediate, so a flush right after has the latest
    debouncer.schedule();
  }

  return (
    <MarkdownLiveEditor
      value={ticket.body}
      onChange={handleChange}
      onBlur={() => debouncer.flush()}
      placeholder="Add description…"
      ariaLabel="Ticket description"
      className="min-h-32 rounded-md px-3 py-2"
    />
  );
}
