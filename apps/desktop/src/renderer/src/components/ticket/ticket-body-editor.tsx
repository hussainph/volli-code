import * as React from "react";
import type { Ticket } from "@volli/shared";

import { Markdown } from "@renderer/components/ticket/markdown";
import { createDebouncer, type Debouncer } from "@renderer/lib/debounce";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";

const AUTOSAVE_IDLE_MS = 1500;

/**
 * The Doc tab's body: Notion-like click-to-edit (ticket-detail-mvp decision #9).
 * The rendered markdown view flips to a plain monospace textarea on click, on
 * Enter/`e` while the body region is focused; the textarea auto-grows
 * (`field-sizing`), autosaves ~1.5s after the last keystroke via the board
 * store's `updateTicket({ body })`, and flushes that pending save immediately on
 * blur, on unmount, and whenever it flips back to the rendered view. ⌘-Enter or
 * blur returns to the rendered view; Escape leaves edit mode too but
 * `stopPropagation`s so the detail shell's Escape-to-close never fires. A failed
 * save is surfaced by the store's own toast path.
 */
export function TicketBodyEditor({ ticket }: { ticket: Ticket }) {
  const updateTicket = useBoardStore((state) => state.updateTicket);

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(ticket.body);
  const draftRef = React.useRef(draft);
  // The value last written through — guards a redundant IPC/event when a
  // debounced save and a blur-flush both fire with nothing changed since.
  const lastSavedRef = React.useRef(ticket.body);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

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

  // Move the caret to the end when entering edit mode.
  React.useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  function enterEdit() {
    const seed = ticket.body;
    setDraft(seed);
    draftRef.current = seed;
    lastSavedRef.current = seed;
    setEditing(true);
  }

  function exitEdit() {
    debouncer.flush();
    setEditing(false);
  }

  function handleChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = event.target.value;
    setDraft(next);
    draftRef.current = next; // immediate, so a flush right after has the latest
    debouncer.schedule();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      exitEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // the shell's Escape-to-close must not fire
      exitEdit();
    }
  }

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={handleChange}
        onBlur={exitEdit}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        aria-label="Ticket description"
        className="min-h-32 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm leading-6 text-foreground outline-none [field-sizing:content] focus-visible:border-ring"
      />
    );
  }

  if (ticket.body.trim() === "") {
    return (
      <button
        type="button"
        onClick={enterEdit}
        className="w-full rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors duration-150 ease-out hover:bg-accent/50"
      >
        Add description…
      </button>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Edit description"
      onClick={enterEdit}
      onKeyDown={(event) => {
        if (event.key === "e" || event.key === "Enter") {
          event.preventDefault();
          enterEdit();
        }
      }}
      className={cn(
        "cursor-text rounded-md px-3 py-2 outline-none transition-colors duration-150 ease-out",
        "hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
    >
      <Markdown source={ticket.body} />
    </div>
  );
}
