/**
 * A glyph-only action inside a row, with the tooltip that makes it legible.
 *
 * An icon alone in a table cell is a guess. `aria-label` answers it for a
 * screen reader and leaves a sighted reader hovering a folder outline
 * wondering whether it opens, moves, or exports the thing — and REVEAL is
 * exactly the verb people do not predict, because it leaves the app entirely
 * and surfaces a window somewhere else.
 *
 * So the label is said twice, deliberately: once to assistive tech via
 * `aria-label`, once on hover and keyboard focus via the tooltip. Radix marks
 * its own tooltip content `aria-hidden` when it duplicates a label, so this
 * does not double-announce.
 */
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";

export function RowAction({
  label,
  hint,
  icon: Icon,
  disabled,
  onAct,
}: {
  /**
   * The full accessible name, naming the subject: `Reveal tdd in Finder`.
   * A table of twenty identical "Reveal" buttons is a list a screen-reader
   * user cannot navigate.
   */
  label: string;
  /**
   * What the tooltip shows. Just the action — the row already says which
   * thing, and repeating its name in a bubble anchored to that row is noise.
   */
  hint: string;
  icon: PhosphorIcon;
  disabled?: boolean;
  onAct: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          disabled={disabled}
          onClick={onAct}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{hint}</TooltipContent>
    </Tooltip>
  );
}
