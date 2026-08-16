/**
 * The context meter: how much of the model's window this Session is holding.
 *
 * A pill in the composer footer, because that is where the Session's other
 * standing facts (model, effort) already live — and like them it is chrome, so
 * it rests dim with the row and comes up under focus. The pill answers the
 * one-glance question (a ring and a percentage); the popover behind it answers
 * the follow-up: a hundred-cell grid of the window, one cell per percent,
 * colored by who is holding it, with the exact split as a legend. Hovering a
 * cell names its bucket, which is the grid's whole reason to be a grid.
 *
 * The split is an estimate (see `chat/context-usage.ts`) and the popover says
 * so; the total is the provider's own measurement and is shown without hedging.
 */
import * as React from "react";

import {
  contextGridCells,
  formatTokens,
  type ContextSegmentId,
  type SessionContextUsage,
} from "@renderer/chat/context-usage";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

/** One cell per percent of the window: enough to see, few enough to hover. */
const GRID_CELLS = 100;

/**
 * Semantic theme colors rather than a bespoke palette, so the grid reads in
 * both appearances and stays normalized against every other status surface.
 * `free` is deliberately the quietest thing in the picture: the story is what
 * is spent, and unspent window is background.
 */
const SEGMENT_CELL: Record<ContextSegmentId | "free", string> = {
  system: "bg-info",
  user: "bg-primary",
  assistant: "bg-positive",
  reasoning: "bg-attention",
  tools: "bg-muted-foreground",
  free: "bg-muted",
};

export const ContextUsagePill = React.memo(function ContextUsagePill({
  usage,
}: {
  usage: SessionContextUsage;
}) {
  const percent = usage.fraction === null ? null : formatPercent(usage.fraction);
  const summary =
    usage.contextWindow === null
      ? `Context: ${formatTokens(usage.usedTokens)} tokens used`
      : `Context: ${formatTokens(usage.usedTokens)} of ${formatTokens(usage.contextWindow)} tokens (${percent})`;
  const cells = React.useMemo(() => contextGridCells(usage, GRID_CELLS), [usage]);
  const byId = React.useMemo(
    () => new Map(usage.segments.map((segment) => [segment.id as string, segment])),
    [usage.segments],
  );
  const free = usage.contextWindow === null ? null : usage.contextWindow - usage.usedTokens;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={summary}
          title={summary}
          className={cn("gap-1.5 px-1.5 tabular-nums", toneClass(usage.fraction))}
        >
          <UsageRing fraction={usage.fraction} />
          {/* The number a glance needs: share of the window when the window is
              known, the raw spend when it is not. Label-sized — this is the
              quietest fact in the row until it stops being small. */}
          <span className="text-label">{percent ?? formatTokens(usage.usedTokens)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-64 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ui font-medium">Context</span>
          <span className="text-label tabular-nums text-muted-foreground">
            {usage.contextWindow === null
              ? `${formatTokens(usage.usedTokens)} tokens`
              : `${formatTokens(usage.usedTokens)} of ${formatTokens(usage.contextWindow)} · ${percent}`}
          </span>
        </div>

        {/* The window as a surface. Each cell is 1% and carries its bucket's
            name on hover; the cells run in segment order so a bucket is one
            contiguous region rather than confetti. */}
        <div role="img" aria-label={summary} className="mt-2.5 grid grid-cols-10 gap-0.5">
          {keyedCells(cells).map((cell) => (
            <div
              key={cell.key}
              title={cellTitle(cell.id, byId, free)}
              className={cn("aspect-square rounded-[2px]", SEGMENT_CELL[cell.id])}
            />
          ))}
        </div>

        <ul className="mt-2.5 space-y-1">
          {usage.segments.map((segment) => (
            <li key={segment.id} className="flex items-center gap-2 text-ui">
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-[2px]", SEGMENT_CELL[segment.id])}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{segment.label}</span>
              <span className="shrink-0 text-label tabular-nums text-muted-foreground">
                {formatTokens(segment.tokens)}
              </span>
            </li>
          ))}
          {free !== null && free > 0 ? (
            <li className="flex items-center gap-2 text-ui">
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-[2px]", SEGMENT_CELL.free)}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">Free</span>
              <span className="shrink-0 text-label tabular-nums text-muted-foreground">
                {formatTokens(free)}
              </span>
            </li>
          ) : null}
        </ul>

        {/* The hedge, said once and where the numbers are: the total is the
            provider's, the split is ours. */}
        <p className="mt-2 text-label text-muted-foreground/70">
          Total measured by the provider; split estimated from the transcript.
        </p>
      </PopoverContent>
    </Popover>
  );
});

/**
 * A 12px donut, drawn in `currentColor` so the pill's tone escalation carries
 * it. Windowless usage draws the track alone — a full ring would claim a
 * fraction nobody measured.
 */
function UsageRing({ fraction }: { fraction: number | null }) {
  const radius = 4.5;
  const circumference = 2 * Math.PI * radius;
  const filled = fraction === null ? 0 : Math.max(0.02, Math.min(1, fraction));
  return (
    <svg viewBox="0 0 12 12" aria-hidden className="size-3 shrink-0">
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      {fraction !== null ? (
        <circle
          cx="6"
          cy="6"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${circumference * filled} ${circumference}`}
          transform="rotate(-90 6 6)"
        />
      ) : null}
    </svg>
  );
}

/**
 * Quiet until it matters: muted through most of a Session, attention once the
 * window is four-fifths spent, destructive when the next long turn may not
 * fit. The thresholds are coarse on purpose — this is a weather report, not an
 * alarm with a contract.
 */
function toneClass(fraction: number | null): string {
  if (fraction === null) return "text-muted-foreground";
  if (fraction >= 0.95) return "text-destructive";
  if (fraction >= 0.8) return "text-attention";
  return "text-muted-foreground";
}

function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

/**
 * A cell's identity is its ordinal within its bucket — "the third user cell"
 * — which is stable as the split shifts between turns, where a bare grid
 * index would repaint every cell to the right of any boundary that moved.
 */
function keyedCells(
  cells: readonly (ContextSegmentId | "free")[],
): readonly { key: string; id: ContextSegmentId | "free" }[] {
  const seen = new Map<string, number>();
  return cells.map((id) => {
    const ordinal = (seen.get(id) ?? 0) + 1;
    seen.set(id, ordinal);
    return { key: `${id}:${ordinal}`, id };
  });
}

function cellTitle(
  id: ContextSegmentId | "free",
  segments: ReadonlyMap<string, { label: string; tokens: number }>,
  free: number | null,
): string {
  if (id === "free") return `Free — ${formatTokens(free ?? 0)} tokens`;
  const segment = segments.get(id);
  return segment === undefined ? "" : `${segment.label} — ~${formatTokens(segment.tokens)} tokens`;
}
