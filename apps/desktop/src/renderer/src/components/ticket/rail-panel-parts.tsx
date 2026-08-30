/**
 * The pieces the Calm Stack's pages share
 * (the retired ticket-right-sidebar lab scratch: `RowActions`, `PausedBanner`,
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
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowUUpLeft";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { FilePlusIcon } from "@phosphor-icons/react/dist/csr/FilePlus";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { errorMessage, type DiffStat } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Notice } from "@renderer/components/ui/notice";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

/**
 * Every rail page insets to the column's edge, and tightens at the 240px floor.
 *
 * THE NARROW STEP IS 12px, and it is a recorded exception to the 0/4/8/16/24
 * spacing collapse. The step exists to buy content width back on a rail the user
 * has dragged narrow, so it has to be SMALLER than 16 and still be an inset; the
 * collapsed ladder's next rung down is 8, which halves the edge and reads as a
 * different surface rather than a tighter one. Run mechanically the sweep made
 * both halves 16 and the narrow variant became a no-op — the rail simply stopped
 * responding to its own width, silently. `ticket-sessions-panel-rows.test.tsx`
 * asserts the pair, which is how that was caught; keep it asserting.
 */
export const RAIL_PANEL_INSET = "px-4 group-data-[narrow=true]/rail:px-3";

/** The same inset expressed as a horizontal MARGIN, for blocks that float inside a page. */
export const RAIL_PANEL_MARGIN = "mx-4 group-data-[narrow=true]/rail:mx-3";

/**
 * One repository-card row's shared frame: full-width, quiet hover, seam above
 * every row but the first.
 *
 * NOT `ui/list-row.tsx`, and the difference is the card. These are edge-to-edge
 * rows inside a framed surface, separated by seams and inset to the card's own
 * 16 — a list row is a floating 12px-radius object inset to its list's 8, and
 * one drawn in here would sit a rounded rectangle inside a rounded rectangle
 * with two different insets. What they DID share was the omission: both were
 * `<button>`s with no `focus-visible` treatment at all, which is a keyboard
 * user with no idea which of the card's rows they are on. That is the
 * primitive's recipe, spelled here because the row is not.
 *
 * It lives out here, with the rail's other shared pieces, because the card is
 * no longer one file: the CI row (`pr-checks-row.tsx`) is a peer of the changes
 * and branch rows and has to be indistinguishable from them, and a second copy
 * of this string is how one row silently keeps an old hover after its
 * neighbours are fixed.
 */
export const RAIL_CARD_ROW =
  "flex w-full items-center gap-2 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/45";

/**
 * The framed card those rows sit in, and the hairline between them.
 *
 * SPELLED HERE FOR THE REASON {@link RAIL_CARD_ROW} IS. The repository card
 * declared both inline; then the CI row took a copy of the seam; then the usage
 * card (VC-203) took a copy of both, in a file whose own comment said that a
 * second hand-typed copy of `border-sidebar-border/70` is how one surface
 * silently keeps an old border after the other is retuned. Three copies of a
 * recipe whose entire purpose is that two cards are INDISTINGUISHABLE as
 * objects is the drift path already open, not a hypothetical one.
 *
 * The frame carries no margin. A card floating in a rail page wants
 * {@link RAIL_PANEL_MARGIN}; one nested inside an already-inset block wants
 * nothing, and baking a margin in here would make the second case override the
 * first rather than compose with it.
 */
export const RAIL_CARD_FRAME =
  "overflow-hidden rounded-xl border border-sidebar-border/70 bg-background/50 dark:bg-accent/50";

/** The seam above every card row but the first. */
export const RAIL_CARD_SEAM = "border-t border-sidebar-border/70";

/**
 * Insertions and deletions as one pair — the repository card's changes row, the
 * Diffs header, and the commit gate all wear it.
 *
 * On the canvas's own semantics now, not raw palette. The old exception —
 * "added and removed are a fixed, universally-read pair, not a canvas-derived
 * surface" — had the first half right and drew the wrong conclusion from it:
 * `--positive` is hue-locked precisely so that green stays green on a cool
 * workspace, which is what makes the pair readable AND themed instead of one
 * or the other.
 */
export function DiffTotals({ diff }: { diff: DiffStat }) {
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-ui font-medium tabular-nums">
      <span className="text-positive">+{diff.insertions}</span>
      <span className="text-destructive">−{diff.deletions}</span>
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
        "flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none",
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
 *
 * The drawing is `ui/notice.tsx` now — this is the rail's inset around it, plus
 * the two things a fault in a dragged-narrow column needs and a general notice
 * does not: `truncate`, so a long label can never grow the row past the width
 * the user chose, and the retry itself. Retry is a real `Button`; it used to be
 * a bare `<button>` with `hover:underline` and no focus ring, which is a
 * keyboard user who can reach the only recovery on the surface and cannot see
 * that they have.
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
    <Notice
      announce
      truncate
      tone="error"
      icon={WarningIcon}
      title={label}
      hoverTitle={error}
      data-testid={testId}
      // The rail's own narrow step over the notice's 16, for the reason
      // RAIL_PANEL_INSET exists: at the 240px floor the label and Retry share
      // one line, and four pixels a side is the difference between a sentence
      // and an ellipsis.
      className={cn(RAIL_PANEL_INSET, inset && cn("mb-2 shrink-0", RAIL_PANEL_MARGIN), className)}
      actions={
        <Button size="xs" variant="outline" onClick={onRetry}>
          <ArrowClockwiseIcon />
          Retry
        </Button>
      }
    />
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
    <div className="flex flex-col gap-2 p-4" data-testid={testId} aria-label={`Loading ${label}`}>
      {["w-4/5", "w-3/5", "w-full"].map((width) => (
        <Skeleton key={width} className={cn("h-8", width)} />
      ))}
    </div>
  );
}

/**
 * The header both file navigators wear — the ticket's worktree listing and
 * Home's Main checkout (VC-121).
 *
 * Three parts, and every one of them is a fact about a flat directory
 * navigator rather than about which repository it is pointed at: the panel's
 * name, a mono sub-line that names the ROOT at the top level and becomes the
 * way back OUT once you walk into a folder, and a filter that toggles an input
 * open beside the list it narrows. The two panels had drawn all three
 * separately, differing only in which words they used and — accidentally — in
 * what the filter matched.
 *
 * `children` is the slot for what one panel has and the other does not: the
 * ticket's Attach control and its attachment strip.
 */
export function RailNavigatorHeader({
  title,
  root,
  cwd,
  upTestId,
  filtering,
  query,
  onToggleFilter,
  onQueryChange,
  onNavigateUp,
  actions,
  children,
}: {
  /** The panel's name — "Ticket files", "Project files". */
  title: string;
  /** The mono sub-line at the top level: a branch, a project name. */
  root: string;
  /** The folder being browsed, or `""` at the root. */
  cwd: string;
  upTestId: string;
  filtering: boolean;
  query: string;
  onToggleFilter(): void;
  onQueryChange(next: string): void;
  onNavigateUp(): void;
  /** Controls parked beside Filter — they act on the panel, not on a row. */
  actions?: React.ReactNode;
  /** Anything under the title row and above the filter input. */
  children?: React.ReactNode;
}) {
  return (
    <header className={cn("flex shrink-0 flex-col gap-2 pt-1 pb-4", RAIL_PANEL_INSET)}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-ui font-medium">{title}</p>
          {cwd === "" ? (
            <p className="truncate font-mono text-ui text-muted-foreground">{root}</p>
          ) : (
            <button
              type="button"
              data-testid={upTestId}
              onClick={onNavigateUp}
              aria-label={`Leave ${cwd}`}
              className="flex min-w-0 items-center gap-1 font-mono text-ui text-muted-foreground hover:text-foreground"
            >
              <ArrowUUpLeftIcon className="size-3 shrink-0" />
              <span className="truncate">{cwd}</span>
            </button>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Filter files"
              aria-pressed={filtering}
              onClick={onToggleFilter}
            >
              <MagnifyingGlassIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Filter files</TooltipContent>
        </Tooltip>
        {actions}
      </div>
      {children}
      {filtering ? (
        <Input
          autoFocus
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-label="Filter files"
          placeholder="Filter files…"
          className="h-7 text-ui"
        />
      ) : null}
    </header>
  );
}

/**
 * New File, in the navigator header, at BOTH scopes (VC-191).
 *
 * Beside Filter rather than on a row, for the reason Attach is there: it acts
 * on the FOLDER the navigator is standing in, not on whatever is under the
 * cursor — and it is the only door to creating a file in an EMPTY folder, where
 * there is no row to right-click. New Folder… deliberately has no twin here:
 * the header is a place for the one gesture a person reaches for constantly,
 * the row menu carries the rest, and two adjacent plus-glyphs read as one
 * control that someone drew twice.
 */
export function NewFileRailAction({ onNewFile }: { onNewFile(): void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="New file" onClick={onNewFile}>
          <FilePlusIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">New file</TooltipContent>
    </Tooltip>
  );
}

/**
 * What a navigator's filter matches: the whole project-relative path, not just
 * the basename.
 *
 * Spelled once because the two panels had answered it differently — one
 * matched `relPath`, the other the bare name — which made the same magnifier,
 * with the same placeholder, mean two things. The path is the useful answer:
 * typing `renderer` in a repository root should find the folder, and typing
 * `home-rail` inside a folder should still match a row named for its path.
 */
export function railNavigatorMatch(query: string, relPath: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || relPath.toLowerCase().includes(needle);
}
