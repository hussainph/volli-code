/**
 * The token bar: how a metered total divided between the four classes a
 * provider prices apart.
 *
 * IT IS NOT THE CONTEXT GRID, and the difference is the reason it is a
 * different object rather than a reuse. That grid is a hundred cells because
 * the context window is BOUNDED — `free` is the number it exists to protect,
 * and every cell is one percent of a ceiling. Cumulative usage has no ceiling
 * and no free space: a Session can always spend more. Drawing it as the same
 * hundred cells would promise a limit that is not there, and the first thing a
 * reader would ask is what the empty cells mean.
 *
 * So it is a stacked bar, sized by flex-grow, which fills its track exactly
 * whatever the numbers are. A donut was the other candidate and loses on the
 * same point plus one more: four unbounded quantities in a ring read as shares
 * of something, and there is no something.
 *
 * THE COLOURS ARE THE CONTEXT GRID'S, and that is the reuse worth having.
 * `chat/context-usage-ui.tsx` already maps a non-status breakdown onto the
 * semantic family, so this bar inherits an established reading rather than
 * teaching a second palette one surface away. Cache read takes `--info`
 * because it is the cheap majority and the good news; uncached input takes the
 * accent because it is full price and the part a prompt author controls; cache
 * write takes `--attention` for its 1.25–2x premium; output takes `--positive`
 * as the thing the spend actually bought.
 *
 * IT IS LABELLED IN TOKENS AND ONLY TOKENS. Cost cannot be divided this way —
 * see `usage/usage-format.ts` — so no caller may put a dollar figure on this
 * bar's line.
 */
import * as React from "react";

import type { SessionUsageSummary } from "@volli/shared";

import { cn } from "@renderer/lib/utils";
import { formatTokens } from "@volli/session-presentation";
import { usageBarSegments, type UsageClassId } from "@renderer/usage/usage-format";

/** Semantic tokens, never raw palette — `check-design-tokens.mjs` bans the latter. */
const CLASS_FILL: Record<UsageClassId, string> = {
  cacheRead: "bg-info",
  input: "bg-primary",
  cacheWrite: "bg-attention",
  output: "bg-positive",
};

export const UsageBar = React.memo(function UsageBar({
  summary,
  className,
}: {
  summary: SessionUsageSummary;
  className?: string;
}) {
  const segments = React.useMemo(() => usageBarSegments(summary), [summary]);
  if (segments.length === 0) return null;

  // One sentence for a screen reader, in the same order the bar draws. The bar
  // is `role="img"` rather than a list: it is one picture of a division, and
  // four focusable children would put four stops in a rail's tab order for
  // information the caption below already carries in words.
  const label = segments
    .map((segment) => `${segment.label} ${formatTokens(segment.tokens)}`)
    .join(", ");

  return (
    <div
      role="img"
      aria-label={`Token classes: ${label}`}
      className={cn("flex h-2 w-full gap-px overflow-hidden rounded-full", className)}
    >
      {segments.map((segment) => (
        <span
          key={segment.id}
          // `flexGrow` by token count is what makes the parts sum to the whole
          // exactly, at any width, with no percentage arithmetic to round. A
          // class contributing a fraction of a percent renders as a sliver,
          // which is the honest drawing of a negligible quantity.
          style={{ flexGrow: segment.tokens }}
          className={cn("min-w-px", CLASS_FILL[segment.id])}
          // Native title rather than a Tooltip: this is a decorative
          // reinforcement of the caption, and mounting four tooltip triggers
          // per bar would put Radix portals in every rail row that draws one.
          title={`${segment.label} · ${formatTokens(segment.tokens)}`}
        />
      ))}
    </div>
  );
});

/**
 * The bar's legend, as rows — used inside popovers where there is room to name
 * every class and its count.
 *
 * Rows rather than an inline legend under the bar: at a rail's width an inline
 * legend wraps to three lines and stops being readable as a key, and the
 * popover is the surface that has the height to spend.
 */
export function UsageClassRows({ summary }: { summary: SessionUsageSummary }) {
  const segments = usageBarSegments(summary);
  if (segments.length === 0) return null;
  return (
    <dl className="flex flex-col gap-2">
      {segments.map((segment) => (
        <div key={segment.id} className="flex items-center gap-2">
          {/* A dot, not the context grid's 2px-softened square. That radius is
              a recorded exception tied to a grid of CELLS; this legend explains
              a bar, so it has no cell to echo and needs no exception. At 8px a
              circle also carries more colour than a 4px slice would, which is
              what a colour key is for. */}
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", CLASS_FILL[segment.id])}
          />
          <dt className="min-w-0 flex-1 truncate text-ui text-muted-foreground">{segment.label}</dt>
          <dd className="shrink-0 text-ui tabular-nums text-foreground">
            {formatTokens(segment.tokens)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
