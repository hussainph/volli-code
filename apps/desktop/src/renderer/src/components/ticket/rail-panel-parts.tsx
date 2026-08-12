/**
 * The pieces the Calm Stack's pages share
 * (lab/scratches/ticket-right-sidebar.tsx: `RowActions`, `PausedBanner`,
 * `ScenarioState`, `DiffTotals`).
 *
 * They live here rather than in one panel because the scratch draws each of
 * them once and uses it from several pages — a row's hover actions, a fault
 * banner and the +/− pair are facts about a rail page, not about changes or
 * files or the repository card in particular. A copy per caller is how one
 * surface silently keeps an old minus glyph after the other is fixed.
 */
import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { errorMessage, type DiffStat } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

/** Every rail page insets to the column's edge, and tightens at the 240px floor. */
export const RAIL_PANEL_INSET = "px-4 group-data-[narrow=true]/rail:px-3";

/** The same inset expressed as a horizontal MARGIN, for blocks that float inside a page. */
export const RAIL_PANEL_MARGIN = "mx-4 group-data-[narrow=true]/rail:mx-3";

/**
 * Insertions and deletions as one pair — the repository card's changes row, the
 * Diffs header, and the commit gate all wear it. Raw palette colors rather than
 * theme tokens, the same exception the session status dots already take: added
 * and removed are a fixed, universally-read pair, not a canvas-derived surface.
 */
export function DiffTotals({ diff }: { diff: DiffStat }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs font-medium tabular-nums">
      <span className="text-emerald-900 dark:text-emerald-400">+{diff.insertions}</span>
      <span className="text-red-900 dark:text-red-400">−{diff.deletions}</span>
    </span>
  );
}

/**
 * A row's hover affordances: copy the path, open it as a persistent tab. Hidden
 * until the row is hovered or something inside it takes focus, so a list of
 * twenty files is twenty filenames rather than forty buttons.
 *
 * The copy button swaps its glyph to a check for 900ms — the only feedback a
 * clipboard write can honestly give, since there is nothing on screen to show
 * for it.
 */
export function RailRowActions({
  path,
  onOpen,
  className,
}: {
  path: string;
  onOpen(path: string): void;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  // Held so the timer can be cleared if the row unmounts mid-flash (a refresh
  // can drop the file out of the list) — setting state on a gone component is
  // the one way this tiny affordance can throw.
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 900);
    } catch (error) {
      toastError(`Couldn't copy the path: ${errorMessage(error)}`);
    }
  }

  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none",
        className,
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Copy ${path}`}
            onClick={(event) => {
              event.stopPropagation();
              void copy();
            }}
          >
            {copied ? <CheckCircleIcon /> : <CopyIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{copied ? "Path copied" : "Copy path"}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Open ${path} in tab`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen(path);
            }}
          >
            <ArrowSquareOutIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Open in tab</TooltipContent>
      </Tooltip>
    </span>
  );
}

/**
 * A read stopped landing, so what is on screen below is a frozen snapshot.
 * Inline rather than a replacement: the rows already drawn were accurate as of
 * the last refresh, and hiding them would throw away real information to report
 * a transport fault.
 *
 * ONE banner for every such fault in the rail — the Diffs watch, the repository
 * card's watch, and a directory read the Files page could not complete. Three
 * shapes for one sentence was how the rail ended up printing raw watcher text on
 * one page and not another.
 *
 * `label` is the sentence a person needs; the underlying error text goes to
 * `title` and never onto the row, because at the rail's width it pushes Retry
 * off the end.
 */
export function RailFaultBanner({
  label = "Updates paused",
  error,
  onRetry,
  inset = true,
  testId,
  className,
}: {
  /** What stopped, in the reader's terms. Defaults to the watch's own wording. */
  label?: string;
  error: string;
  onRetry(): void;
  /** OFF where the banner already sits inside a padded block (the repository card). */
  inset?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      title={error}
      data-testid={testId}
      className={cn(
        "flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-2.5 py-2 text-xs text-destructive",
        inset && cn("mb-2 shrink-0", RAIL_PANEL_MARGIN),
        className,
      )}
    >
      <WarningIcon weight="fill" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{label}</span>
      <button
        type="button"
        onClick={onRetry}
        className="flex shrink-0 items-center gap-1 font-medium hover:underline"
      >
        <ArrowClockwiseIcon />
        Retry
      </button>
    </div>
  );
}

/**
 * The first-load placeholder: three pulsing bars at row height, rather than a
 * centred "Loading…" line. A rail page is a list, so the honest shape of the
 * wait is a list — and it holds the column's width steady instead of collapsing
 * to a sentence and snapping back.
 */
export function RailPanelSkeleton({ label, testId }: { label: string; testId: string }) {
  return (
    <div className="flex flex-col gap-2 p-3" data-testid={testId} aria-label={`Loading ${label}`}>
      {["w-4/5", "w-3/5", "w-full"].map((width) => (
        <div
          key={width}
          className={cn(
            "h-8 animate-pulse rounded-md bg-sidebar-accent/70 motion-reduce:animate-none",
            width,
          )}
        />
      ))}
    </div>
  );
}
