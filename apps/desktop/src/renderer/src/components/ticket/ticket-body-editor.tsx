import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import type { Ticket } from "@volli/shared";

import {
  type DocumentFileRefs,
  type MonacoDocumentEditorHandle,
  MonacoDocumentEditor,
} from "@renderer/components/editor/monaco-document-editor";
import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import { BODY_CLAMP_PX, planClamp } from "@renderer/components/ticket/clamp-policy";
import { AUTOSAVE_IDLE_MS, planAutosave } from "@renderer/editor/autosave-plan";
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
import { useDebouncedCallback } from "@renderer/lib/use-debounced-callback";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";

/**
 * The Doc tab's body: an always-mounted Monaco Document Mode editor. The
 * markdown buffer IS the document — syntax renders in place and there's no
 * read/edit flip. Edits autosave ~1.5s after the last keystroke via the board
 * store's `updateTicket({ body })`, and the pending save flushes immediately on
 * blur and on unmount so the last ~1.5s of typing is never lost. `lastSavedRef`
 * guards a redundant IPC/event when nothing changed since the previous write; a
 * failed save surfaces via the store's own toast. Escape inside the editor is
 * Monaco's (its suggest widget, multi-cursor); the detail shell's
 * Escape-to-close guard exempts the Monaco surface by selector, so it never
 * closes the view out from under a caret (issue #116).
 *
 * This is the surface that finally uses the `ticket-body` document identity: the
 * body gets a registry-owned Monaco model keyed by project + ticket, so a second
 * view of the same body would share it rather than fork it.
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
  editorRef,
}: {
  ticket: Ticket;
  fileRefs?: DocumentFileRefs;
  /** The host's splice-in point for `@` refs attached elsewhere on the view (VC-106). */
  editorRef?: React.Ref<MonacoDocumentEditorHandle>;
}) {
  const updateTicket = useBoardStore((state) => state.updateTicket);

  // The body's collapse (VC-99): agent-written bodies can run long, and an
  // uncapped editor pushes the Activity feed far below the fold. The editor
  // reports its unclamped content height on every change; over BODY_CLAMP_PX
  // the host clamps (Monaco scrolls inside the CSS-clamped box — the composer
  // bounds its body the same way) and an Expand/Collapse row appears under it.
  // Short bodies render exactly as before: no cap, no toggle. `null` until the
  // first report — `planClamp` reads that as "fits", and the reset below parks
  // it there again on ticket switch so a tall body never clamps a short one.
  const [contentHeight, setContentHeight] = React.useState<number | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const { overflowing, clamped } = planClamp(contentHeight, BODY_CLAMP_PX, expanded);

  React.useEffect(() => {
    setContentHeight(null);
    setExpanded(false);
  }, [ticket.id]);

  // The value that seeds / resets the editor doc; changing it re-syncs the
  // editor's buffer when it isn't focused (or, if focused-but-untouched, on blur
  // — see monaco-document-editor).
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

  /**
   * Clear registry dirty via `peek`, not the editor ref. React runs child
   * cleanups first: on unmount the Monaco editor has already released its lease
   * before this host's debounced flush runs `save`, so an imperative
   * `editorRef.markSaved` would no-op and leave the ticket-body entry parked dirty.
   */
  const markBodySaved = React.useCallback(() => {
    void loadMonacoRuntime()
      .then((runtime) => {
        runtime.registry
          .peek({ kind: "ticket-body", projectId: ticket.projectId, ticketId: ticket.id })
          ?.markSaved(null);
      })
      .catch(() => {
        // Monaco never loaded — nothing in the registry to clear.
      });
  }, [ticket.projectId, ticket.id]);

  const save = React.useCallback(() => {
    const next = draftRef.current;
    // `writing: false` — `updateTicket` is fire-and-forget through the store, so
    // there is no in-flight write for this surface to coalesce against; the
    // conflict pause and the clean-document skip are the live rules here.
    const action = planAutosave({
      value: next,
      baseline: lastSavedRef.current,
      conflicted: conflictRef.current !== null,
      writing: false,
    });
    if (action !== "save") return;
    lastSavedRef.current = next;
    // Keep the registry baseline in step with the store write so a later peek
    // does not see a permanently dirty ticket-body document.
    markBodySaved();
    void updateTicket({ ticketId: ticket.id, body: next });
  }, [updateTicket, ticket.id, markBodySaved]);

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
        <Notice
          title="Changed elsewhere. Autosave paused."
          actions={
            <Button size="sm" variant="secondary" onClick={reload}>
              <ArrowClockwiseIcon />
              Reload
            </Button>
          }
        />
      )}
      {/* -mx-4/px-4 bleeds the block into the gutter (Notion-style) so the body
          TEXT left-aligns with the title on the column edge. The padding is on
          the wrapper, never on the editor host, which IS the editor's layout
          box (see MonacoDocumentEditor). */}
      <div className="-mx-4 rounded-md px-4">
        <MonacoDocumentEditor
          identity={{ kind: "ticket-body", projectId: ticket.projectId, ticketId: ticket.id }}
          viewId={`ticket-body:${ticket.id}`}
          value={docValue}
          onChange={handleChange}
          onBlur={() => debouncer.flush()}
          onContentHeightChange={setContentHeight}
          placeholder="Add description…"
          ariaLabel="Ticket description"
          fileRefs={fileRefs}
          className="min-h-32"
          style={clamped ? { maxHeight: BODY_CLAMP_PX } : undefined}
          ref={editorRef}
        />
        {overflowing ? (
          // The same disclosure language as the feed's bunch rows: a muted
          // text button with a rotating caret. Sits in the gutter-bleed wrapper
          // so it aligns with the body text it expands.
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="mt-1 flex items-center gap-1 rounded-sm px-1 text-ui text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            {expanded ? "Collapse" : "Expand"}
            <CaretDownIcon
              className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}
