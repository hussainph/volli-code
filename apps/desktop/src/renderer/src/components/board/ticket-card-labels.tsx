/**
 * A board card's label row, capped at one line with a `+n` chip for the rest.
 *
 * The card is the board's scanning unit, and a ticket wearing nine labels used
 * to draw a tile several times its neighbours' height — so a column stopped
 * being a list of comparable things and became a ragged wall. One line puts
 * every card back on the same rhythm, and the `+n` chip keeps the labels
 * reachable rather than hiding that anything was dropped.
 *
 * The packing decision is NOT here — it is `label-overflow.ts`, pure and
 * tested. What is here is the part that cannot be tested through jsdom, where
 * every width is zero: measuring the chips and watching the row resize.
 *
 * MEASURED ONCE PER NAME, not once per render. A chip's width depends on its
 * text, not on the card it sits in, so the first card to draw `frontend`
 * measures it and every later one reads the number back — which matters on a
 * board where one label is worn eighty times. The measure pass renders every
 * chip; once the widths are known the row renders only what fits, and a resize
 * re-splits from the cache without touching the DOM again.
 */

import * as React from "react";

import { TagChip } from "@renderer/components/board/tag-chip";
import { labelRowSplit } from "@renderer/components/board/label-overflow";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Badge } from "@renderer/components/ui/badge";
import { resolveLabelColor } from "@renderer/lib/labels";
import { cn } from "@renderer/lib/utils";
import type { Label } from "@volli/shared";

/**
 * The row's flex gap in px, and the one number here that must agree with a
 * class name (`gap-1` below is Tailwind's 0.25rem). Kept beside the class it
 * mirrors rather than read back through `getComputedStyle` on every card: the
 * read costs a layout flush per card on a board that may hold hundreds, to
 * recover a constant that changes only when the line above it changes.
 */
const ROW_GAP_PX = 4;

/** Chip widths by label name, shared across every card on the board. */
const measuredChipWidths = new Map<string, number>();

/** The `+n` chip. A button because it opens something and takes focus. */
const OverflowChip = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & { count: number }
>(function OverflowChip({ count, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      // The card underneath is a drag handle and a selection target; opening
      // the label list is neither, so the gesture stops here.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
      }}
      className={cn("shrink-0 rounded-full outline-hidden focus-visible:ring-2", className)}
      {...props}
    >
      <Badge variant="outline" className="px-1 py-px">
        {`+${count}`}
      </Badge>
    </button>
  );
});

export function TicketCardLabels({
  labels,
  projectLabels,
}: {
  labels: readonly string[];
  projectLabels: readonly Label[];
}) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const [available, setAvailable] = React.useState<number | null>(null);
  // Never read: bumping it is how a measure pass that filled the shared cache
  // asks for the re-render where `needsMeasuring` below comes out false.
  const [, setMeasuredAt] = React.useState(0);
  const [open, setOpen] = React.useState(false);

  // Every name whose width is already known needs no measure pass. The
  // overflow chip is measured under the widest count it could ever show, so
  // the reservation is never an underestimate that clips a chip.
  const overflowKey = `\u0000+${labels.length}`;
  const needsMeasuring =
    labels.some((name) => !measuredChipWidths.has(name)) || !measuredChipWidths.has(overflowKey);

  React.useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width;
      if (width !== undefined) setAvailable(width);
    });
    observer.observe(row);
    setAvailable(row.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Runs in the same commit as the measure pass, BEFORE paint, so the full row
  // it renders is never shown — the split row replaces it in the same frame.
  //
  // It re-runs when the labels change, which is exactly when a name this board
  // has never drawn can appear. The bump is guarded on having LEARNED
  // something, so the re-render it causes cannot re-enter: the second pass
  // finds every width cached and sets no state.
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    let learned = false;
    for (const element of row.querySelectorAll<HTMLElement>("[data-measure-key]")) {
      const key = element.dataset["measureKey"];
      if (key === undefined || measuredChipWidths.has(key)) continue;
      measuredChipWidths.set(key, element.getBoundingClientRect().width);
      learned = true;
    }
    if (learned) setMeasuredAt((version) => version + 1);
  }, [labels, overflowKey]);

  const split = React.useMemo(() => {
    if (needsMeasuring || available === null) return null;
    return labelRowSplit({
      widths: labels.map((name) => measuredChipWidths.get(name) ?? 0),
      available,
      gap: ROW_GAP_PX,
      overflow: measuredChipWidths.get(overflowKey) ?? 0,
    });
    // `needsMeasuring` carries the cache's state into this list: the effect
    // above bumps `measuredAt` only when it filled a gap, and that re-render
    // is where `needsMeasuring` flips false. Naming the counter here as well
    // would be a second spelling of the same fact.
  }, [labels, available, needsMeasuring, overflowKey]);

  if (labels.length === 0) return null;

  const chip = (name: string) => (
    <TagChip tag={name} color={resolveLabelColor(projectLabels, name)} />
  );

  // The measure pass: every chip, laid out but not yet split. `invisible`
  // rather than unmounted, because a width can only be read from a node the
  // browser has laid out.
  if (split === null) {
    return (
      <div ref={rowRef} className="flex min-w-0 flex-nowrap gap-1 overflow-hidden pt-1">
        {labels.map((name) => (
          <span key={name} data-measure-key={name} className="invisible shrink-0">
            {chip(name)}
          </span>
        ))}
        <span data-measure-key={overflowKey} className="invisible shrink-0">
          <OverflowChip count={labels.length} tabIndex={-1} />
        </span>
      </div>
    );
  }

  const visible = labels.slice(0, split.visible);
  const hidden = labels.slice(split.visible);

  return (
    <div ref={rowRef} className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden pt-1">
      {visible.map((name) => (
        <span key={name} className="shrink-0">
          {chip(name)}
        </span>
      ))}
      {hidden.length > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <OverflowChip
              count={hidden.length}
              aria-label={`${hidden.length} more label${hidden.length === 1 ? "" : "s"}`}
              // Hover opens it, which is what a chip standing for hidden
              // content should do; focus opens it too, so the keyboard reaches
              // the same answer as the pointer.
              onMouseEnter={() => setOpen(true)}
              onMouseLeave={() => setOpen(false)}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
            />
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-auto max-w-72 p-2"
            // The pointer travelling from chip to content must not close it,
            // and the card underneath must not take the hover as its own.
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <div className="flex flex-wrap gap-1">
              {labels.map((name) => (
                <TagChip key={name} tag={name} color={resolveLabelColor(projectLabels, name)} />
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
