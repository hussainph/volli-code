/**
 * The diff pane's control band — the ONE slim strip above the editor, and the
 * only always-visible editor chrome the app draws (plan §4.1).
 *
 * It was a full-width border-bottom row holding two text buttons reading
 * `Inline | Side by side`: page chrome, in words, for a choice about layout.
 * Icons say it in the space of one, which is what buys room for the word-wrap
 * toggle beside them — the rule this band exists under is that controls join it
 * or a context menu, and nothing earns a second band.
 *
 * Each icon keeps its label as its accessible name (`Segmented`'s `iconOnly`),
 * so nothing is lost to a screen reader or a hover.
 */
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ArrowElbowDownLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowElbowDownLeft";
import { RowsIcon } from "@phosphor-icons/react/dist/csr/Rows";
import { SquareSplitHorizontalIcon } from "@phosphor-icons/react/dist/csr/SquareSplitHorizontal";

import { Button } from "@renderer/components/ui/button";
import { Segmented } from "@renderer/components/ui/segmented";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import type { DiffPresentation } from "@renderer/stores/ui";

/** Stacked rows for one column of diff; a split square for two. */
const PRESENTATIONS = [
  { key: "inline", label: "Inline", icon: RowsIcon },
  { key: "side-by-side", label: "Side by side", icon: SquareSplitHorizontalIcon },
] as const satisfies readonly { key: DiffPresentation; label: string; icon: PhosphorIcon }[];

export function DiffPresentationToggle({
  presentation,
  onChange,
}: {
  presentation: DiffPresentation;
  onChange(next: DiffPresentation): void;
}) {
  return (
    <Segmented
      ariaLabel="Diff presentation"
      testId="ticket-diff-presentation"
      value={presentation}
      options={PRESENTATIONS}
      iconOnly
      className="shrink-0"
      onChange={onChange}
    />
  );
}

/**
 * Word wrap: one control for one binary state, drawn in the segmented control's
 * own pressed/unpressed language so the band reads as one row of switches rather
 * than two vocabularies. Not a `Segmented` of Wrap/No-wrap — that would spend
 * two buttons saying what `aria-pressed` says in one.
 *
 * The preference is app-wide (stores/ui), so this and the file tab's Word Wrap
 * menu item are two doors onto the same switch.
 */
export function WordWrapToggle({ wordWrap, onToggle }: { wordWrap: boolean; onToggle(): void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant={wordWrap ? "secondary" : "ghost"}
          aria-pressed={wordWrap}
          aria-label="Word wrap"
          data-testid="ticket-diff-word-wrap"
          onClick={onToggle}
        >
          <ArrowElbowDownLeftIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Word wrap</TooltipContent>
    </Tooltip>
  );
}

/** The band itself: every diff control there is, on one line. */
export function DiffControlBand({
  presentation,
  onPresentationChange,
  wordWrap,
  onToggleWordWrap,
}: {
  presentation: DiffPresentation;
  onPresentationChange(next: DiffPresentation): void;
  wordWrap: boolean;
  onToggleWordWrap(): void;
}) {
  return (
    <div
      data-testid="ticket-diff-control-band"
      className="flex shrink-0 items-center gap-1 border-b border-border px-gutter py-1"
    >
      <DiffPresentationToggle presentation={presentation} onChange={onPresentationChange} />
      <WordWrapToggle wordWrap={wordWrap} onToggle={onToggleWordWrap} />
    </div>
  );
}
