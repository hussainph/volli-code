/**
 * The Files header: ONE compact line that says where the listing is and what
 * can be done to it (VC-406, revision 06).
 *
 * THE DEFECT THIS REPLACES. The page used to open with its own name —
 * `Ticket files` / `Project files` — under a Files tab that had just said the
 * same word, and under that a labelled `Attachments` group whose chip strip sat
 * on screen forever so that a reader could see it had not changed. Three
 * stacked groups, two of which were titles: at the 240px floor the listing
 * itself began below the fold.
 *
 * So the header says the one thing no other surface says — WHERE THE LISTING
 * IS — and everything that acts on it rides that same line:
 *
 *  - the root's mark, or the folder's name, which is also the way back OUT of
 *    it (one target, so leaving a folder is never a separate control to find);
 *  - New File, which acts on that folder;
 *  - the Ticket's paperclip, which opens its attachments as a MENU
 *    (`files/attachment-menu.tsx`) rather than a strip that is always on screen —
 *    attachments belong to the Ticket, so the menu is reachable from every
 *    folder and with no worktree at all, but a list a reader is not currently
 *    asking about does not get permanent pixels;
 *  - the filter, beside it, because narrowing the listing is the other thing
 *    one does to it.
 *
 * NOTHING BELOW THAT LINE IS RESERVED. The read's own sentence
 * (`RailHeadingReadStatus`) draws when there is a read to report and takes no
 * room when there is not; the filter field appears when the filter is open.
 * A fixed band for either is 20-odd pixels of nothing under every navigator,
 * paid for a state the page is in for half a second a minute — and at the rail's
 * floor those pixels are the difference between seeing three rows and four.
 */
import type * as React from "react";
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowUUpLeft";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";

import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

export function FilesNavigatorHeader({
  status,
  actions,
  attachmentMenu,
  root,
  cwd,
  upTestId,
  filtering,
  query,
  onToggleFilter,
  onQueryChange,
  onNavigateUp,
}: {
  /**
   * What this page's read is doing, as `RailHeadingReadStatus` draws it. It
   * gets its own line under the directory when there IS one and none at all
   * when there is not — at 240px the directory line has no room to spare for a
   * fourth thing beside three controls.
   */
  status?: React.ReactNode;
  /** Actions on the FOLDER — New File. Never on the Ticket, never on the list. */
  actions?: React.ReactNode;
  /**
   * The Ticket's paperclip, beside the filter. Absent at a scope with no
   * Ticket to attach to, and at a scope whose host supplied an empty read-only
   * list: a menu that can neither list nor add anything is a control with no
   * object.
   */
  attachmentMenu?: React.ReactNode;
  /** The mono name of the checkout the navigator is rooted in. */
  root: string;
  /** The folder being browsed, or `""` at the root. */
  cwd: string;
  upTestId: string;
  filtering: boolean;
  query: string;
  onToggleFilter(): void;
  onQueryChange(next: string): void;
  onNavigateUp(): void;
}) {
  return (
    <header
      data-testid="files-navigator-header"
      className={cn("flex shrink-0 flex-col gap-1.5 pt-1 pb-2", RAIL_PANEL_INSET)}
    >
      <div className="flex min-h-7 items-center gap-1">
        {cwd === "" ? (
          <span className="flex min-w-0 flex-1 items-center gap-1 font-mono text-ui text-muted-foreground">
            <FolderOpenIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{root}</span>
          </span>
        ) : (
          // The folder's name IS the way out of it: one target, so a reader
          // never has to find a separate control to leave.
          <button
            type="button"
            data-testid={upTestId}
            onClick={onNavigateUp}
            aria-label={`Leave ${cwd}`}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-sm font-mono text-ui text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowUUpLeftIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{cwd}</span>
          </button>
        )}
        {actions}
        {attachmentMenu}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Filter files"
              aria-pressed={filtering}
              onClick={onToggleFilter}
            >
              <MagnifyingGlassIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Filter files</TooltipContent>
        </Tooltip>
      </div>
      {/* Both conditional, both under the location they are about: the read's
          sentence when there is one, the filter field while it is open. A
          `null` child of a flex column takes neither height nor gap, so at rest
          the header IS its one line. */}
      {status}
      {filtering ? (
        <Input
          autoFocus
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-label="Filter files"
          placeholder="Filter files…"
          className="h-7 text-ui"
        />
      ) : null}
    </header>
  );
}
