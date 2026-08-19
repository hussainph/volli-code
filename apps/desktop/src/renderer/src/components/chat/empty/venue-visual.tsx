/**
 * VENUE — one object, two registers (VC-55).
 *
 * The visual both scopes can draw, and the ticket scope's only one. It answers
 * the question a chat surface never used to: which tree is this Session
 * standing in, and what is in it.
 *
 * IT IS ONE OBJECT, not two stacked charts. Two centred bars with a rule
 * between them are two silhouettes competing for the same slot, neither
 * anchoring the other — the shape this replaced. So: one rounded body, two
 * registers sharing its exact width and its corner radius, the way a spirit
 * level has a bubble and a rule. The wrapper owns the radius and clips both
 * tracks, so neither can round its own corners and become a separate object
 * again.
 *
 *  • The thick track partitions FILES by state — how much of this tree is in
 *    play.
 *  • The hairline under it splits LINES added against removed — how much work
 *    is in it.
 *
 * Different units on purpose, and that is why the object works: two file-count
 * bars would just be a bar chart with two rows.
 *
 * A VENUE WITH NO BASE DROPS THE HAIRLINE rather than drawing an empty one. An
 * empty diff track reads as "no work", which is the opposite of what a dirty
 * main checkout means — and the missing hairline is the identity signal doing
 * its work for free: a Session in the user's own working tree simply does not
 * have that second register.
 */
import {
  venueFileTotal,
  venueSegments,
  type VenueFileState,
  type VenueSnapshot,
} from "@volli/shared";

import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

/** The tone each state draws in, and the word its tooltip uses. */
const STATE_TONE: Record<VenueFileState, string> = {
  // Committed work takes the accent: it is the only state that means progress
  // rather than exposure.
  committed: "bg-primary",
  modified: "bg-attention",
  added: "bg-positive",
  untracked: "bg-muted-foreground/40",
};

const STATE_LABEL: Record<VenueFileState, string> = {
  committed: "committed",
  modified: "modified",
  added: "added",
  untracked: "untracked",
};

export function VenueVisual({ venue }: { venue: VenueSnapshot }) {
  const total = venueFileTotal(venue.files);
  const segments = venueSegments(venue.files);
  const diff = venue.diff;
  const span = diff === null ? 0 : diff.added + diff.removed;

  return (
    <div className="flex w-80 flex-col gap-3" data-empty-visual="venue">
      <div className="flex flex-col overflow-hidden rounded-control">
        <div className="flex h-8 bg-muted">
          {segments.map((segment) => (
            <Tooltip key={segment.state}>
              <TooltipTrigger asChild>
                <span
                  className={cn("h-full cursor-default", STATE_TONE[segment.state])}
                  style={{ width: `${(segment.count / total) * 100}%` }}
                />
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {segment.count} {STATE_LABEL[segment.state]}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        {diff === null || span === 0 ? null : (
          // Bordered in the page's own colour rather than gapped: the two
          // tracks stay one clipped body, with a hairline of paper between them.
          <div className="flex h-1.5 border-t border-background">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="h-full cursor-default bg-positive"
                  style={{ width: `${(diff.added / span) * 100}%` }}
                />
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {diff.added} lines added
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="h-full cursor-default bg-destructive"
                  style={{ width: `${(diff.removed / span) * 100}%` }}
                />
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {diff.removed} lines removed
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1">
        <span className="text-title text-foreground tabular-nums">{total}</span>
        <span className="text-ui text-muted-foreground">
          {total === 1 ? "file changed" : "files changed"}
        </span>
        {diff === null ? null : (
          <>
            <span className="text-ui text-positive tabular-nums">+{diff.added}</span>
            <span className="text-ui text-destructive tabular-nums">−{diff.removed}</span>
            <span className="text-ui text-muted-foreground">vs {diff.base}</span>
          </>
        )}
      </div>
    </div>
  );
}
