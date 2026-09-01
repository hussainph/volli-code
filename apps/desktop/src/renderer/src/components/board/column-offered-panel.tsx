/**
 * What a column can run, shown inside the column mid-drag — compact while the
 * pointer is merely over it, grown into real landing targets while ⌥ is held
 * (VC-132).
 *
 * ONE list at two sizes, never two components. That is the whole reason the
 * digits stay meaningful: `2` picks the same row whether or not the row is
 * currently big enough to drop onto, and ⌥ reads as the list GROWING rather
 * than as one control being swapped for another. The Lab rig's earlier attempt
 * drew a read-only legend collapsed and a grid expanded, and the digits looked
 * like they belonged to a different control than the targets.
 *
 * Collapsed rows are deliberately NOT pointer targets. They are one text line
 * tall, which is the needle-in-a-haystack size that made the rejected design
 * bad to aim at while holding a card; offering them as targets anyway would be
 * inviting the miss. Collapsed, the keyboard drives; expanded, the pointer does.
 *
 * The panel is ABSOLUTELY positioned over the column's own cards, and that is a
 * production requirement rather than a drawing choice: the column body is a
 * dnd-kit droppable, and a panel in the flow would move that droppable's
 * measured rect every time ⌥ went down or up — the class of mid-flight rect
 * change `board-column.tsx` already records as the DndContext measure loop. It
 * also happens to be the right drawing: the list sits on top of the cards it
 * hides, which is why it carries its own surface and shadow.
 *
 * An EXPANDED column with nothing offered still draws the panel, holding the
 * one target it honestly has — **Move only**. Under ⌥ every release must land
 * on a named target, and collapsing to the empty note here would put the one
 * column shape with nothing to choose in a different drawing from every other
 * column, exactly while the modifier is promising large landing targets.
 *
 * Motion is appearance only: rows fade and the panel's own padding eases, and
 * nothing anywhere on this path dwells, debounces or animates a position the
 * pointer is aiming at. Under reduced motion the transitions drop and every
 * signifier — the ring, the digit, the bolt, the dashed Move only row — stays.
 */
import type * as React from "react";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { type Automation } from "@volli/shared";

import { cn } from "@renderer/lib/utils";

export interface ColumnOfferedPanelProps {
  /** This column's Offered list in digit order — armed pinned to `1`, capped at nine. */
  rows: readonly Automation[];
  /** Grown into landing targets, because ⌥ is held over this column. */
  expanded: boolean;
  /** The lit row, or `null` for the Move only row. */
  highlighted: number | null;
  /** The effective armed Automation's id, marked as what a plain release runs. */
  armedId: string | null;
}

/** The row a pointer/digit picks, as the hit test reads it back. */
export const OFFERED_ROW_ATTRIBUTE = "data-offered-row";
/** The Move only row's value under {@link OFFERED_ROW_ATTRIBUTE}. */
export const MOVE_ONLY_ROW = "move-only";

export function ColumnOfferedPanel({
  rows,
  expanded,
  highlighted,
  armedId,
}: ColumnOfferedPanelProps) {
  if (rows.length === 0 && !expanded) {
    return (
      /* Not helper text: with no rows there is nothing on screen at all, and a
         blank panel would read as a list that failed to load. */
      <p className="rounded-lg border border-dashed border-border bg-popover px-2 py-1 text-label text-muted-foreground shadow-overlay">
        Nothing to run here
      </p>
    );
  }
  return (
    <div
      data-offered-panel={expanded ? "expanded" : "collapsed"}
      className={cn(
        "flex flex-col rounded-lg border border-border bg-popover shadow-overlay",
        "transition-[gap,padding] duration-150 ease-out motion-reduce:transition-none",
        expanded ? "gap-1 p-1" : "gap-0 p-1",
      )}
    >
      {rows.map((automation, index) => (
        <OfferedRow
          key={automation.id}
          row={String(index)}
          digit={index + 1}
          label={automation.name}
          chosen={highlighted === index}
          expanded={expanded}
          // Expanded only: collapsed, the lit row already says what a plain
          // release runs. Expanded it earns its width, because a digit can move
          // the highlight off the default and then the two facts differ.
          trailing={
            expanded && armedId === automation.id ? (
              <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
                <LightningIcon weight="fill" className="size-3" />
                default
              </span>
            ) : null
          }
        />
      ))}
      <OfferedRow
        row={MOVE_ONLY_ROW}
        // `0` carries a digit like every other row because it IS one: the key
        // that runs nothing. Without it, "move the ticket and start nothing"
        // was the most expensive gesture on the board — open the picker, aim,
        // release — while the cheap one spent tokens.
        digit={0}
        label="Move only"
        chosen={highlighted === null}
        expanded={expanded}
        dashed
      />
    </div>
  );
}

function OfferedRow({
  row,
  digit,
  label,
  chosen,
  expanded,
  dashed = false,
  trailing = null,
}: {
  row: string;
  digit: number;
  label: string;
  chosen: boolean;
  expanded: boolean;
  dashed?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      // Read back by the board's own pointer hit test rather than by a React
      // handler: the board already reads the pointer once per move to find the
      // hovered column, and one read cannot disagree with itself about where
      // the pointer is. It is also why the rows never need `pointerenter` —
      // the column grows UNDER a stationary cursor, and an enter fired by the
      // interface moving would steal the preselected choice from a hand that
      // never moved.
      {...{ [OFFERED_ROW_ATTRIBUTE]: expanded ? row : undefined }}
      aria-current={chosen ? "true" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md border text-left text-ui",
        "transition-[background-color,border-color,color,padding] duration-150 ease-out motion-reduce:transition-none",
        expanded ? "px-2 py-2" : "px-1 py-0",
        dashed && !chosen ? "border-dashed border-border" : "border-transparent",
        chosen
          ? expanded
            ? "border-solid border-ring bg-accent text-foreground"
            : "text-foreground"
          : "text-muted-foreground",
      )}
    >
      <kbd
        className={cn(
          "shrink-0 rounded-sm border px-1 font-mono text-label",
          chosen ? "border-primary text-primary" : "border-border text-muted-foreground",
        )}
      >
        {digit}
      </kbd>
      <span className={cn("min-w-0 flex-1 truncate", expanded && "font-medium")}>{label}</span>
      {trailing}
    </div>
  );
}
