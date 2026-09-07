/**
 * The caption under an empty chat's drawing: two chips, and no sentences
 * (VC-55).
 *
 * What a chip says is a value, not an explanation — the venue's kind and its
 * branch. Prose was explored and killed: "your working tree — not isolated" is
 * a description of the thing you are already looking at, and CLAUDE.md's "let
 * controls talk" holds here too. If a fact matters, it is drawn.
 *
 * THE CAP IS ON THE CHIP, not on the text. A branch name is arbitrarily long,
 * and a caption wider than the drawing above it is what made the two read as
 * thrown together rather than composed. `min-w-0` on the label is what actually
 * lets `truncate` fire inside a flex row; without it the text sets the width
 * and the cap never bites.
 *
 * THE WHOLE VALUE IS ONE FOCUS AWAY, which used to be one HOVER away and no
 * more than that (VC-288). The chip was a `<span>` wearing a tooltip: a pointer
 * could ask for the path it was hiding and a keyboard had no way to, so at the
 * pane widths where the cap actually bites the value was simply gone for anyone
 * not using a mouse. It is a button now — a focus stop that goes nowhere,
 * because the reveal IS the act — and it carries the untruncated value as its
 * own accessible name, so nothing has to be opened to hear it at all.
 */
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import type { VenueSnapshot } from "@volli/shared";

import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";

/** The word for each venue kind. A noun; the drawing above carries the rest. */
export function venueKindLabel(venue: VenueSnapshot): string {
  return venue.kind === "main-checkout" ? "Main checkout" : "Worktree";
}

function ScopeChip({
  icon: Icon,
  /** What the value IS — `Worktree`, `Branch` — leading the accessible name. */
  term,
  /** The untruncated value — the reveal's whole reason to exist. */
  full,
  children,
}: {
  icon: React.ComponentType<{ className?: string; weight?: "bold" }>;
  term: string;
  full: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // The alternatives were both worse. `tabIndex` on the span puts a
          // stop in the tab order that AT announces as nothing in particular,
          // and wrapping a 60-character branch name turns a two-chip caption
          // into a paragraph under the drawing it is a caption for.
          aria-label={`${term} · ${full}`}
          className="inline-flex h-7 max-w-48 cursor-default items-center gap-1 rounded-full border border-border bg-card px-2 text-ui text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/45"
        >
          <Icon weight="bold" className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{children}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="font-mono">
        {full}
      </TooltipContent>
    </Tooltip>
  );
}

export function VenueChips({ venue }: { venue: VenueSnapshot }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-1">
      <ScopeChip icon={FolderOpenIcon} term={venueKindLabel(venue)} full={venue.path}>
        {venueKindLabel(venue)}
      </ScopeChip>
      {/* A detached HEAD has no branch to name, and inventing one ("HEAD",
          "none") would be naming a thing that is not there. */}
      {venue.branch === null ? null : (
        <ScopeChip icon={GitBranchIcon} term="Branch" full={venue.branch}>
          {venue.branch}
        </ScopeChip>
      )}
    </div>
  );
}
