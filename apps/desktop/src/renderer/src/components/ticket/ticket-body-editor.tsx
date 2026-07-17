import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import type { Ticket } from "@volli/shared";

import {
  MarkdownLiveEditor,
  type MarkdownFileRefs,
} from "@renderer/components/editor/markdown-live-editor";
import { Button } from "@renderer/components/ui/button";
import { useDebouncedCallback } from "@renderer/lib/use-debounced-callback";
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
 *
 * Because agents (and other views) edit the same body, autosave is
 * conflict-guarded exactly like the FileView: an external `ticket.body`
 * change is adopted silently only when there is NO unsaved draft; if the user
 * has an unsaved edit and the body changed underneath it, that's a conflict —
 * autosave pauses (so the stale draft can't clobber the external edit), a
 * non-destructive banner appears, and Reload adopts the external value.
 */
export function TicketBodyEditor({
  ticket,
  fileRefs,
}: {
  ticket: Ticket;
  fileRefs?: MarkdownFileRefs;
}) {
  const updateTicket = useBoardStore((state) => state.updateTicket);

  // The value that seeds / resets the editor doc; changing it re-syncs the
  // editor's buffer when it isn't focused (or, if focused-but-untouched, on blur
  // — see markdown-live-editor).
  const [docValue, setDocValue] = React.useState(ticket.body);
  // The external body captured when a conflict is detected — drives the banner
  // and Reload. `null` = no conflict, autosave live.
  const [conflict, setConflict] = React.useState<string | null>(null);

  const draftRef = React.useRef(ticket.body); // current editor content
  // The value last written through / adopted — also the baseline the current
  // draft is derived from: a draft is "pending" iff draftRef !== lastSavedRef.
  const lastSavedRef = React.useRef(ticket.body);
  const conflictRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);

  // External body change (agent edit, store rehydrate). With no pending draft it
  // is the new baseline — adopt it (the editor resets when unfocused, or on blur
  // when focused-but-untouched). With a pending draft AND a real divergence it's
  // a conflict: do NOT rebase (so the flush guard still sees draft ≠ baseline and
  // is paused below) and raise the banner rather than stomping either side.
  React.useEffect(() => {
    const external = ticket.body;
    if (external === lastSavedRef.current) return; // no change / echo of our own write
    const pending = draftRef.current !== lastSavedRef.current;
    if (!pending) {
      lastSavedRef.current = external;
      setDocValue(external);
      return;
    }
    setConflict(external);
  }, [ticket.body]);

  const save = React.useCallback(() => {
    if (conflictRef.current !== null) return; // paused until reload
    const next = draftRef.current;
    if (next === lastSavedRef.current) return;
    lastSavedRef.current = next;
    void updateTicket({ ticketId: ticket.id, body: next });
  }, [updateTicket, ticket.id]);

  const debouncer = useDebouncedCallback(save, AUTOSAVE_IDLE_MS);

  function handleChange(next: string) {
    draftRef.current = next; // immediate, so a flush right after has the latest
    if (conflictRef.current !== null) return; // paused until reload
    debouncer.schedule();
  }

  // Reload = take the external version: drop the pending draft, adopt the
  // conflicting body as the new baseline, and reset the (now-unfocused, since
  // the button took focus) editor to it.
  function reload() {
    const external = conflictRef.current;
    if (external === null) return;
    debouncer.cancel();
    lastSavedRef.current = external;
    draftRef.current = external;
    setDocValue(external);
    setConflict(null);
  }

  return (
    <div className="flex flex-col gap-2">
      {conflict !== null && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span>Changed elsewhere — autosave paused to avoid overwriting.</span>
          <Button size="sm" variant="secondary" onClick={reload}>
            <ArrowClockwiseIcon />
            Reload
          </Button>
        </div>
      )}
      <MarkdownLiveEditor
        value={docValue}
        onChange={handleChange}
        onBlur={() => debouncer.flush()}
        placeholder="Add description…"
        ariaLabel="Ticket description"
        fileRefs={fileRefs}
        // -mx-3 bleeds the hover block into the gutter (Notion-style) so the
        // body TEXT left-aligns with the title on the column edge.
        className="-mx-3 min-h-32 rounded-md px-3 py-2"
      />
    </div>
  );
}
