/**
 * The Ticket's attachments, behind the Files header's paperclip (VC-406,
 * revision 06).
 *
 * THE DEFECT THIS REPLACES was a PERMANENT LIST. The rail drew an `Attachments`
 * eyebrow and a strip of chips above the listing, on screen in every state
 * because attachments belong to the Ticket rather than to the folder — which is
 * true, and is an argument about REACHABILITY, not about pixels. A list a
 * reader checks occasionally does not need to be shown continuously; it needs
 * to be one press away from wherever they are. So the strip became a menu: the
 * paperclip is always in the header, at every folder and with no worktree at
 * all, and what it opens is the same list with room to be read properly.
 *
 * ORDINARY ROWS, NOT TILES AND NOT CHIPS. `attachments/attachment-strip.tsx`
 * draws 64px tiles, which is right above a composer — there the picture IS the
 * label. A rail attachment is something one CHECKS is still attached, so the
 * menu draws the app's own compact list row (`ui/list-row.tsx`): a paperclip,
 * the label, and the remove the owner already offers. The full file name rides
 * the row's hover title, and the composer's tiles remain the place a file is
 * actually looked at.
 *
 * WHAT THIS OWNS: the drawing and the picker's door. Not the attachment domain
 * — `hooks/use-attachments.ts` still decides what an attach and a remove mean,
 * and `attachments/composer-attach-button.tsx`'s `useFilePicker` is still the
 * one file dialog in the app. A host that supplied its attachments read-only
 * passes neither handler, and the menu then has nothing to offer but the list.
 */
import * as React from "react";
import { PaperclipIcon } from "@phosphor-icons/react/dist/csr/Paperclip";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { useFilePicker } from "@renderer/components/attachments/composer-attach-button";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { ListRow } from "@renderer/components/ui/list-row";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";

/**
 * The least an attachment has to be to appear here.
 *
 * Structural rather than `BlobLinkView`, because the two lists that reach this
 * menu are different types: the live strip from `useAttachments` (a full
 * `BlobLinkView`, removable) and a host's read-only `NamedBlobLink` view. Both
 * satisfy this, and the generic below keeps `onRemove` typed as whichever one
 * the caller actually holds.
 */
export interface AttachmentMenuEntry {
  linkId: string | null;
  blobHash: string;
  label: string;
  originalName: string;
}

/** What the trigger says, out loud and on hover. The count is the discoverable part. */
export function attachmentMenuLabel(count: number): string {
  return count === 0 ? "Attachments" : `Attachments (${count})`;
}

/**
 * The menu's contents — exported for the tests, on `pr-checks-row.tsx`'s
 * grounds: a popover portals out of its host's render, so this is where the
 * information is and a mount of the panel alone would assert none of it.
 */
export function AttachmentMenuDetail<T extends AttachmentMenuEntry>({
  attachments,
  onAttachFiles,
  onRemove,
}: {
  attachments: readonly T[];
  /** Absent where this host may not add to the list — a read-only view. */
  onAttachFiles?: (files: readonly File[]) => void;
  /** Absent where this host may not mutate the list. */
  onRemove?: (attachment: T) => void;
}): React.ReactElement {
  // The app's one file dialog. Called unconditionally (hooks are), rendered
  // only where attaching is allowed — an unmounted input opens nothing.
  const picker = useFilePicker((files) => onAttachFiles?.(files));
  return (
    <>
      {attachments.length === 0 ? (
        <p data-testid="rail-attachments-empty" className={EMPTY_INLINE}>
          Nothing attached yet
        </p>
      ) : (
        // Capped and scrollable: a Ticket can collect a dozen screenshots, and
        // a menu as tall as the window is a panel that happens to float. The
        // list names itself for a reader who arrives inside it.
        //
        // FOCUSABLE, because the cap can hide rows that nothing else can reach:
        // a read-only list has no buttons to tab through, so without a stop of
        // its own the overflow is pointer-only scrolling. `tabIndex={0}` on the
        // scroller is `copy-report-dialog.tsx`'s answer to the same shape — the
        // region takes focus and arrow keys scroll it, while the rows stay as
        // inert as they were.
        <ul
          aria-label="Attachments"
          data-testid="rail-attachments-list"
          tabIndex={0}
          className="flex max-h-64 flex-col overflow-y-auto focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {attachments.map((attachment) => (
            <li key={attachment.linkId ?? attachment.blobHash}>
              <ListRow
                density="row"
                data-testid="rail-attachment-row"
                // Inert: there is nothing to open. An attachment need not have
                // a materialized file at all (a PDF attached before the
                // worktree existed), so a row that looked pressable would be
                // promising a preview this surface cannot give.
                onActivate={null}
                title={`${attachment.label} · ${attachment.originalName}`}
                leading={
                  // Outline at 16px, which is what every other file row in the
                  // rail wears: the glyph says "attachment" beside names that
                  // say "file", and the two lists have to read as one kind of
                  // thing.
                  <PaperclipIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                }
                primary={attachment.label}
                actions={
                  onRemove === undefined ? undefined : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove ${attachment.label}`}
                      onClick={() => onRemove(attachment)}
                    >
                      <XIcon />
                    </Button>
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}
      {onAttachFiles === undefined ? null : (
        <div className={attachments.length === 0 ? undefined : "mt-1 border-t border-border pt-1"}>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Attach files"
            onClick={picker.open}
            // `rounded-lg`, which is the radius the rows above it wear: inside
            // one small surface the act and the things it acts on have to read
            // as the same kind of object.
            className="w-full justify-start rounded-lg"
          >
            <PaperclipIcon />
            Attach files
          </Button>
          {picker.input}
        </div>
      )}
    </>
  );
}

/**
 * The paperclip and the surface it opens.
 *
 * The trigger carries the count in its own accessible name and, when there is
 * one, beside the glyph — which is the whole job the permanent strip was doing:
 * saying that something is attached. Reading WHICH files is what opening it is
 * for.
 */
export function AttachmentMenu<T extends AttachmentMenuEntry>({
  attachments,
  onAttachFiles,
  onRemove,
}: {
  attachments: readonly T[];
  onAttachFiles?: (files: readonly File[]) => void;
  onRemove?: (attachment: T) => void;
}): React.ReactElement {
  const count = attachments.length;
  const label = attachmentMenuLabel(count);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          data-testid="rail-attachments-trigger"
          aria-label={label}
          // In both, because `aria-label` replaces the title for a screen
          // reader and the pointer only ever sees the title.
          title={label}
          // `sm` rather than `icon-sm`: this is the one control on the line that
          // sometimes has a number to say, and a pill that can hold the glyph
          // and the count keeps the row's height when it does.
          className="gap-1"
        >
          <PaperclipIcon />
          {count === 0 ? null : (
            <span aria-hidden className="text-label tabular-nums">
              {count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Attachments" align="end" className="flex w-64 flex-col p-1">
        <AttachmentMenuDetail
          attachments={attachments}
          {...(onAttachFiles === undefined ? {} : { onAttachFiles })}
          {...(onRemove === undefined ? {} : { onRemove })}
        />
      </PopoverContent>
    </Popover>
  );
}
