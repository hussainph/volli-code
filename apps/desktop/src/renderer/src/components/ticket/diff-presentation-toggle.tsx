/**
 * The diff pane's control band — the slim strip above the diff editor, and the
 * band plan §4.1's rule is written about.
 *
 * It was a full-width border-bottom row holding two text buttons reading
 * `Inline | Side by side`: page chrome, in words, for a choice about layout.
 * Icons say it in the space of one, which is what buys room for the word-wrap
 * toggle beside them — the rule this band exists under is that controls join it
 * or a context menu, and a band has to be earned.
 *
 * ONE other surface has since earned one. VC-192 gives markdown file tabs a
 * Source ⇄ Document control (`editor/markdown-view-toggle.tsx`), and a
 * segmented control is the one shape that cannot live in a context menu — so
 * that band is the same idiom, borrowed by the one file kind with a second view
 * to offer, and not a licence for a strip above every file. Word wrap on a file
 * tab is still a menu item (VC-187), which is the rule working.
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
  inlineFallback = false,
}: {
  presentation: DiffPresentation;
  onPresentationChange(next: DiffPresentation): void;
  wordWrap: boolean;
  onToggleWordWrap(): void;
  /**
   * The pane is too narrow for two columns, so the diff below is drawing
   * inline whatever the segmented control says (`diff-fit.ts`).
   */
  inlineFallback?: boolean;
}) {
  return (
    <div
      data-testid="ticket-diff-control-band"
      className="flex shrink-0 items-center gap-1 border-b border-border px-gutter py-1"
    >
      {/* The segmented control keeps showing the CHOICE, never the fit. The
          preference is app-wide and durable; a pane being narrow for a minute
          is not a person changing their mind, and a control that rewrote itself
          on a resize would lose the setting the moment the reader split a
          view. */}
      <DiffPresentationToggle presentation={presentation} onChange={onPresentationChange} />
      <WordWrapToggle wordWrap={wordWrap} onToggle={onToggleWordWrap} />
      {/* Which leaves one thing to say, and this says it: the diff is not
          drawing what the control shows, and the pane is why. Two words in the
          muted ink — a noun for a state, not a sentence explaining a feature
          (CLAUDE.md's "let controls talk") — and the recovery is the gesture a
          reader already has: widen the pane, and the choice standing in the
          control takes effect with nothing to press.

          `role="status"` rather than a tooltip on the segment, because a
          tooltip is the pointer's alone and this is a fact about the screen. It
          is announced when it appears and it stays readable while it stands. */}
      {inlineFallback ? (
        <span
          role="status"
          data-testid="ticket-diff-inline-fallback"
          className="min-w-0 truncate text-ui text-muted-foreground"
        >
          Narrow pane
        </span>
      ) : null}
    </div>
  );
}
