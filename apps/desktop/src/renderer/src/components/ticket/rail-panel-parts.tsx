/**
 * The pieces the Calm Stack's two navigators share
 * (lab/scratches/ticket-right-sidebar.tsx: `RowActions`, `PausedBanner`,
 * `ScenarioState`).
 *
 * They live here rather than in either panel because the scratch draws them
 * once and uses them from both Diffs and Files — a row's hover actions and a
 * "the watch died" banner are facts about a rail page, not about changes or
 * files in particular.
 */
import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { errorMessage } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

/** Every rail page insets to the column's edge, and tightens at the 240px floor. */
export const RAIL_PANEL_INSET = "px-4 group-data-[narrow=true]/rail:px-3";

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
 * The watch died, so the list below is a frozen snapshot. Inline rather than a
 * replacement: the rows on screen were accurate as of the last refresh, and
 * hiding them would throw away real information to report a transport fault.
 *
 * The banner says "Updates paused" and carries the fault in `title`. The
 * sentence a person needs is that the list stopped moving and there is a way to
 * restart it; the watcher's own error text is diagnostics, and at the rail's
 * width it pushed Retry off the row.
 */
export function RailPausedBanner({
  error,
  onRetry,
  className,
}: {
  error: string;
  onRetry(): void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      title={error}
      className={cn(
        "mb-2 flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-2.5 py-2 text-xs text-destructive",
        "mx-4 group-data-[narrow=true]/rail:mx-3",
        className,
      )}
    >
      <WarningIcon weight="fill" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">Updates paused</span>
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1 font-medium hover:underline"
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
