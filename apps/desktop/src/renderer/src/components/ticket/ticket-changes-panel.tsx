/**
 * Diffs navigator — the Calm Stack's changes page
 * (the retired ticket-right-sidebar lab scratch's `ChangesPanel`).
 *
 * A titled header over a flat list (decision #53 — never a tree). The header
 * carries the page's name, the file count, refresh, a filter toggle and the
 * branch's running total; each row carries a coloured status glyph, the
 * filename over its muted parent, and the two line counts in a fixed column so
 * the numbers line up down the list.
 *
 * Selecting a row asks the host to open/focus a Monaco diff tab via
 * `onOpenDiff` (`openTicketDiff`, CONCEPT #48/#51). Refresh handlers never
 * open, close, or focus a tab. Files navigator uses preview/pin (decision #56).
 *
 * THE LIST IS A LIST, NOT A LISTBOX (VC-311). A `role="option"` row may not
 * hold interactive descendants, and this one holds three — the activation
 * target plus Copy/Open — so the old `listbox`/`option` pair was an ARIA
 * content-model violation screen readers answer by flattening the row. A plain
 * `list` of `listitem`s permits named interactive children; the keyboard model
 * is the tab order itself (row button, then its actions, focus-ringed by
 * `ListRow`), and the row whose diff is on screen carries `aria-current`
 * rather than `aria-selected`, which without a listbox parent announced
 * nothing anyway.
 */
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import {
  changeSetToDiffStat,
  errorMessage,
  type ChangeSetFile,
  type ChangeSetFileStatus,
  type DiffStat,
  type Ticket,
} from "@volli/shared";

import {
  DiffTotals,
  RAIL_PANEL_INSET,
  RAIL_PANEL_MARGIN,
  RailFaultBanner,
  RailPanelSkeleton,
  RailRowActions,
} from "@renderer/components/ticket/rail-panel-parts";
import {
  applyChangeSetRefresh,
  presentChangeRowWithRecency,
  type ChangeRowPresentation,
  type ChangesNavigatorState,
} from "@renderer/components/ticket/ticket-changes-model";
import { parseDiffTabId } from "@renderer/components/ticket/ticket-diff-tab";
import type { ChangeRecencyState } from "@renderer/components/ticket/ticket-change-recency";
import {
  formatWorktreeState,
  type WorktreeStatusSnapshot,
} from "@renderer/components/ticket/worktree-done-flow-model";
import { subscribeWorktreeChanges } from "@renderer/components/ticket/worktree-change-watch";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { ListRow } from "@renderer/components/ui/list-row";
import { Notice } from "@renderer/components/ui/notice";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { isTextClipped } from "@renderer/components/ui/value-reveal";
import { cn } from "@renderer/lib/utils";
import { toastError } from "@renderer/lib/toast";

/**
 * A row plus the two count halves the design colours separately. The shared
 * presentation model pre-joins them into one `countsLabel` string, which is the
 * right shape for a single muted trailing span but the wrong one here: green
 * insertions and red deletions are two marks, and a string cannot be two
 * colours.
 */
export interface ChangeListRow extends ChangeRowPresentation {
  /** The raw status, which picks the row's glyph — `statusLabel` is its word. */
  statusKind: ChangeSetFileStatus;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

/** Compose a list row from a Change Set file and the ticket's recency state. */
export function toChangeListRow(file: ChangeSetFile, recency: ChangeRecencyState): ChangeListRow {
  return {
    ...presentChangeRowWithRecency(file, recency),
    statusKind: file.status,
    insertions: file.insertions,
    deletions: file.deletions,
    binary: file.binary,
  };
}

/**
 * The glyph and ink each status wears. The scratch names three — modified,
 * added, renamed — and the Change Set has three more it never had to draw:
 * `deleted` takes the removal mark in the deletions' own red, `untracked`
 * shares `added`'s green because both are "this file is new" (the status word
 * beside it is what separates staged from not), and `conflicted` is the one
 * failure among them, so it takes the warning glyph.
 *
 * ONE ink per status, where this was a `{iconClass, labelClass}` pair. The pair
 * only ever encoded a light-mode shade step (`-600` glyph, `-900` label) that
 * dark mode collapsed anyway — six statuses × two fields × two appearances of
 * hand-written Tailwind, saying what the canvas now solves once. The glyph and
 * its label are one object; they were never two decisions.
 *
 * `bold`, not `fill`: at 16px a status mark sits beside an 11px label, which is
 * the size tier where regular draws lighter than its own text (CLAUDE.md).
 * Filling them would make five different drawings rather than one heavier set.
 */
const CHANGE_STATUS: Record<ChangeSetFileStatus, { icon: PhosphorIcon; ink: string }> = {
  modified: { icon: GitDiffIcon, ink: "text-attention" },
  added: { icon: PlusIcon, ink: "text-positive" },
  untracked: { icon: PlusIcon, ink: "text-positive" },
  renamed: { icon: ArrowRightIcon, ink: "text-info" },
  deleted: { icon: MinusIcon, ink: "text-destructive" },
  conflicted: { icon: WarningIcon, ink: "text-destructive" },
};

/** The page's name and its count — the one line both the empty and full list wear. */
function ChangesTitle({ count }: { count: number }) {
  return (
    <>
      <p className="text-ui font-medium">Diffs</p>
      <Badge variant="count-pill">{count}</Badge>
    </>
  );
}

/**
 * One line of a change row's text, ellipsized at its START so the end a reader
 * tells two files apart by — the extension, the deepest directory — never
 * leaves the screen (VC-311).
 *
 * THREE PARTS, and all three are load-bearing. `dir="rtl"` moves the ellipsis
 * to the line's start edge, because that edge is the box's inline END. Alone it
 * would also park a short name against the right margin and reorder the
 * neutrals around a value like `(final) report.md`, so `text-left` puts a name
 * back where a name belongs and the inner `dir="ltr"` run keeps every
 * character in its own order. Measured in Chromium rather than assumed: a
 * clipped line keeps its tail against the right edge, and a short one starts
 * flush left, unmoved.
 *
 * ONE TEXT NODE, deliberately. The obvious middle-truncation — a truncating
 * head span beside a `shrink-0` tail span — draws correctly and then lies to
 * everything that READS the row: flex items are block-level boxes, so Chromium
 * answers `innerText` and a copy with `split-view-divider\n.test.tsx`.
 * Find-in-page, the clipboard and this repo's own Change Set smokes all go
 * through that text, and a value drawn in one run cannot break in the middle of
 * a filename. What start-truncation drops off the front, the row's reveal and
 * its accessible name still carry in full.
 */
function ChangeRowLine({
  value,
  lineRef,
  className,
}: {
  value: string;
  lineRef?: React.Ref<HTMLSpanElement>;
  className?: string;
}) {
  return (
    <span
      ref={lineRef}
      dir="rtl"
      data-slot="changes-row-line"
      className={cn("block truncate text-left", className)}
    >
      <span dir="ltr">{value}</span>
    </span>
  );
}

/**
 * THE ROW'S FULL-PATH VIEW, on the row rather than on a line.
 *
 * It has to be the row. A keyboard has one stop here — the activation target —
 * so a reveal hung off each line would open two identical bubbles at once when
 * both lines clip, and open nothing at all when the clipped line is the name
 * (the case a rail hits first, since the name line is the one that carries a
 * long filename). Radix opens this on the row's own hover and focus; all this
 * hook adds is the refusal: a row drawing everything it holds has nothing to
 * reveal, and a bubble over it is the noise that teaches people to ignore the
 * ones that matter. Measured at the moment of the ask, across every line the
 * row drew — the argument `ui/value-reveal.tsx` makes for one element, applied
 * to the pair.
 */
function useRowReveal(lines: readonly React.RefObject<HTMLElement | null>[]): {
  open: boolean;
  onOpenChange(next: boolean): void;
} {
  const [open, setOpen] = React.useState(false);
  const linesRef = React.useRef(lines);
  linesRef.current = lines;
  const onOpenChange = React.useCallback((next: boolean) => {
    setOpen(next && linesRef.current.some((line) => isTextClipped(line.current)));
  }, []);
  return { open, onOpenChange };
}

/** Working tree, local commits, and remote state — visible without opening another page. */
export function WorktreeStateStrip({ status }: { status: WorktreeStatusSnapshot }) {
  const state = formatWorktreeState(status);
  const items = [
    {
      label: "Working",
      value: state.working,
      ink: status.uncommitted ? "text-attention" : "text-muted-foreground",
    },
    {
      label: "Local",
      value: state.local,
      ink:
        status.aheadOfBase !== null && status.aheadOfBase > 0
          ? "text-foreground"
          : "text-muted-foreground",
    },
    {
      label: "Remote",
      value: state.remote,
      ink:
        status.unpushed === 0 && status.aheadOfBase !== 0
          ? "text-positive"
          : (status.unpushed !== null && status.unpushed > 0) ||
              (status.unpushed === null && status.aheadOfBase !== null && status.aheadOfBase > 0)
            ? "text-attention"
            : "text-muted-foreground",
    },
  ] as const;

  return (
    <div
      data-testid="ticket-changes-git-state"
      aria-label={`Working: ${state.working}; Local: ${state.local}; Remote: ${state.remote}`}
      className="grid grid-cols-3 gap-2 rounded-md bg-muted/50 px-2 py-1.5"
    >
      {items.map((item) => (
        <span key={item.label} className="flex min-w-0 flex-col">
          <span className="text-label text-muted-foreground">{item.label}</span>
          <span className={cn("truncate text-label font-medium", item.ink)}>{item.value}</span>
        </span>
      ))}
    </div>
  );
}

function HeaderAction({
  label,
  icon: Icon,
  pressed,
  onClick,
}: {
  label: string;
  icon: PhosphorIcon;
  pressed?: boolean;
  onClick(): void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One list item: the row, its two lines, its actions, and the reveal that
 * belongs to all of them. Its own component because a row owns hooks now (a
 * ref per line, and the reveal's state), and hooks cannot live in a `.map`.
 */
function ChangeRow({
  row,
  current,
  onSelectRow,
}: {
  row: ChangeListRow;
  /** This row's diff is the tab on screen. */
  current: boolean;
  onSelectRow(path: string): void;
}) {
  const nameRef = React.useRef<HTMLSpanElement>(null);
  const pathRef = React.useRef<HTMLSpanElement>(null);
  const lines = React.useMemo(() => [nameRef, pathRef], []);
  const reveal = useRowReveal(lines);
  const status = CHANGE_STATUS[row.statusKind];
  const StatusIcon = status.icon;
  const pathLine = row.renameFrom ?? row.parentPath;
  return (
    <li>
      <Tooltip open={reveal.open} onOpenChange={reveal.onOpenChange}>
        <TooltipTrigger asChild>
          <ListRow
            density="two-line"
            selected={current}
            data-testid="ticket-changes-row"
            data-path={row.path}
            data-current={current ? "true" : undefined}
            // One AX stop per row: the name carries status, the FULL path (the
            // visible lines truncate), counts in words, rename origin and
            // recency — everything VoiceOver must say, because the glyph, the
            // status word and the counts it can also see say it for sighted
            // readers in three different places.
            aria-label={row.accessibleName}
            // The list is not a selection widget, so the row on screen marks
            // itself CURRENT instead. `aria-selected` without a listbox parent
            // was announced by nothing.
            aria-current={current ? "true" : undefined}
            onActivate={() => onSelectRow(row.path)}
            leading={<StatusIcon className={cn("size-4 shrink-0", status.ink)} weight="bold" />}
            primary={
              <ChangeRowLine
                value={row.filename}
                lineRef={nameRef}
                className="min-w-0 flex-1 text-ui font-medium"
              />
            }
            primaryTrailing={
              <>
                {row.updatedLabel !== undefined && row.updatedDescription !== undefined ? (
                  <span
                    data-testid="ticket-changes-updated"
                    aria-label={row.updatedDescription}
                    className="shrink-0 text-label font-medium text-primary-text"
                  >
                    {row.updatedLabel}
                  </span>
                ) : null}
                {/* The status word yields to the row's hover actions — they
                    occupy the same strip, and the glyph on the left has
                    already said which kind of change this is. */}
                <span
                  className={cn(
                    "shrink-0 text-label font-medium transition-opacity duration-100 group-focus-within:opacity-0 group-hover:opacity-0 motion-reduce:transition-none",
                    "group-data-[narrow=true]/rail:sr-only",
                    status.ink,
                  )}
                >
                  {row.statusLabel}
                </span>
              </>
            }
            secondary={
              <span className="flex min-w-0 items-baseline text-ui text-muted-foreground/70">
                {/* The rename mark is a MARK, so it is pinned outside the line
                    the ellipsis eats into rather than riding in its text. */}
                {row.renameFrom === null ? null : <span className="shrink-0">←&nbsp;</span>}
                <ChangeRowLine value={pathLine} lineRef={pathRef} className="min-w-0 flex-1" />
              </span>
            }
            // A fixed column, so the numbers line up down the list and the
            // filename's truncation point never moves with them.
            trailing={
              <span className="flex w-[72px] shrink-0 justify-end gap-1 font-mono text-ui tabular-nums">
                {row.binary ? (
                  <span className="text-muted-foreground">Binary</span>
                ) : row.insertions === null || row.deletions === null ? null : (
                  <>
                    <span className="font-medium text-positive">+{row.insertions}</span>
                    <span className="font-medium text-destructive">−{row.deletions}</span>
                  </>
                )}
              </span>
            }
            // Overlaid rather than parked after the counts: the actions only
            // exist on hover, and a slot reserved for them would indent every
            // row's counts for the one row a pointer is over.
            actions={
              <RailRowActions
                path={row.path}
                onOpen={onSelectRow}
                className="absolute top-[5px] right-20 z-10 rounded-md bg-accent/90 px-1 shadow-raised"
              />
            }
          />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72 text-wrap font-mono">
          {row.renameFrom === null ? row.path : `${row.path} ← ${row.renameFrom}`}
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

/** Presentational flat list. */
export function TicketChangesList({
  rows,
  currentPath,
  onSelectRow,
  error,
  hiddenCount = 0,
}: {
  rows: readonly ChangeListRow[];
  /**
   * The path whose diff tab is on screen, or `null` for none. Derived from the
   * surface's active tab rather than remembered here, so it cannot outlive the
   * tab it names (VC-311).
   */
  currentPath: string | null;
  onSelectRow(path: string): void;
  error?: string | null;
  /** Paths the snapshot cap left out — surfaced as a trailing row, never hidden. */
  hiddenCount?: number;
}) {
  if (error) {
    return (
      <div
        data-testid="ticket-changes-error"
        className={cn("flex min-h-0 flex-1 flex-col py-4", RAIL_PANEL_INSET)}
        role="alert"
      >
        <p className="text-ui text-destructive">{error}</p>
      </div>
    );
  }

  if (rows.length === 0) {
    // A framed note rather than a centred sentence in an empty column: "nothing
    // changed" is a state the branch is IN, and a card says that the way the
    // repository card above says everything else about the worktree.
    return (
      <Notice
        tone="positive"
        layout="stack"
        icon={CheckCircleIcon}
        title="No changes vs base"
        detail="The branch is up to date."
        data-testid="ticket-changes-empty"
        className={RAIL_PANEL_MARGIN}
      />
    );
  }

  return (
    <ul
      data-testid="ticket-changes-list"
      className="min-h-0 flex-1 overflow-y-auto px-2 pb-8 [scroll-padding-bottom:2rem]"
      aria-label="Change Set"
    >
      {rows.map((row) => (
        <ChangeRow
          key={row.path}
          row={row}
          current={currentPath === row.path}
          onSelectRow={onSelectRow}
        />
      ))}
      {hiddenCount > 0 ? (
        <li
          data-testid="ticket-changes-truncated"
          data-hidden-count={hiddenCount}
          className="px-2 py-1 text-ui text-muted-foreground/70"
          role="presentation"
        >
          {hiddenCount.toLocaleString()} more {hiddenCount === 1 ? "file" : "files"} not shown
        </li>
      ) : null}
    </ul>
  );
}

/** Row payload the host needs to open a persistent diff tab. */
export type OpenChangeDiffTarget = Pick<
  ChangeSetFile,
  "path" | "previousPath" | "status" | "binary"
>;

/**
 * Loads the Change Set, watches the worktree, and refreshes on debounced
 * `onChanged` events. Row click is the only path that asks the host to open a
 * tab — refresh handlers never call `onOpenDiff`.
 */
export function TicketChangesPanel({
  ticket,
  activeTabId,
  recency,
  onOpenDiff,
}: {
  ticket: Ticket;
  /**
   * The surface's active tab. It is the ONE truthful answer to "which file is
   * the person looking at", so the list's current row is read off it rather
   * than remembered from the last click (decision #46/#48, VC-311).
   */
  activeTabId: string;
  /** Ticket-owned passive awareness shared by every File/Diff representation. */
  recency: ChangeRecencyState;
  /** Deliberate open — host wires `openTicketDiff` (CONCEPT #48/#51). */
  onOpenDiff(file: OpenChangeDiffTarget): void;
}) {
  const [nav, setNav] = React.useState<ChangesNavigatorState>(() => ({
    revision: null,
    files: [] as ChangeSetFile[],
    hiddenCount: 0,
  }));
  const [diff, setDiff] = React.useState<DiffStat | null>(null);
  const [status, setStatus] = React.useState<WorktreeStatusSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [watchError, setWatchError] = React.useState<string | null>(null);
  // Bumped by Retry to re-run the watch effect after a fault tore it down.
  const [watchAttempt, setWatchAttempt] = React.useState(0);
  const [filtering, setFiltering] = React.useState(false);
  const [query, setQuery] = React.useState("");

  // A refresh spans several git reads over the whole worktree, and a write storm
  // can outpace it. Never stack overlapping loads: a request arriving mid-load
  // just marks one trailing re-run, so the panel always settles on the latest
  // state without queueing a subprocess pile behind it.
  const loading = React.useRef(false);
  const reloadPending = React.useRef(false);
  const loadRef = React.useRef<() => Promise<void>>(async () => {});

  /**
   * `notify` toasts the failure, and ONLY the loads the user personally asked
   * for set it. A broken worktree fails identically on every filesystem event,
   * and a watch-driven refresh fires per debounce window — toasting those
   * buried the screen in the same sentence while the user was still reading
   * the first one. The inline error always updates either way, so nothing is
   * swallowed; it just says it once.
   */
  const loadChangeSet = React.useCallback(
    async (notify = false) => {
      if (ticket.worktreePath === null) {
        setError(null);
        setNav((prev) => ({ ...prev, revision: null, files: [] }));
        setDiff(null);
        setStatus(null);
        setLoaded(true);
        return;
      }
      if (loading.current) {
        reloadPending.current = true;
        return;
      }
      loading.current = true;
      try {
        const [result, statusResult] = await Promise.all([
          window.api.worktree.changeSet(ticket.id),
          window.api.worktree.status(ticket.id),
        ]);
        setStatus(statusResult.ok ? statusResult.status : null);
        if (!result.ok) {
          setError(result.error);
          if (notify) toastError(`Couldn't load changes: ${result.error}`);
          return;
        }
        setError(null);
        setNav((prev) => applyChangeSetRefresh(prev, result.changeSet));
        setDiff(changeSetToDiffStat(result.changeSet));
      } catch (err) {
        const message = errorMessage(err);
        setError(message);
        if (notify) toastError(`Couldn't load changes: ${message}`);
      } finally {
        loading.current = false;
        setLoaded(true);
      }
      if (reloadPending.current) {
        reloadPending.current = false;
        await loadRef.current();
      }
    },
    [ticket.id, ticket.worktreePath],
  );

  React.useEffect(() => {
    loadRef.current = loadChangeSet;
  }, [loadChangeSet]);

  React.useEffect(() => {
    void loadChangeSet(true);
  }, [loadChangeSet]);

  // Watch lifecycle: start when the ticket has a live worktree; the returned
  // teardown always unwatches, so watches cannot leak.
  React.useEffect(() => {
    if (ticket.worktreePath === null) return;
    setWatchError(null);
    return subscribeWorktreeChanges(window.api.worktree, ticket.id, {
      // Refresh ONLY — never open/focus a tab from a filesystem event.
      onChanged: () => void loadChangeSet(),
      // Inline, not a toast: this is a persistent condition ("the list you are
      // looking at has stopped updating"), and it needs its own retry.
      onWatchError: setWatchError,
    });
  }, [ticket.id, ticket.worktreePath, loadChangeSet, watchAttempt]);

  const retryWatch = React.useCallback(() => {
    setWatchError(null);
    setWatchAttempt((attempt) => attempt + 1);
    void loadChangeSet(true);
  }, [loadChangeSet]);

  const filesRef = React.useRef(nav.files);
  filesRef.current = nav.files;

  const handleSelect = React.useCallback(
    (path: string) => {
      const row = filesRef.current.find((file) => file.path === path);
      // Deliberate click — the only place we ask the host to open a tab.
      if (row !== undefined) onOpenDiff(row);
    },
    [onOpenDiff],
  );

  if (!loaded && ticket.worktreePath !== null) {
    return <RailPanelSkeleton label="changes" testId="ticket-changes-loading" />;
  }

  if (ticket.worktreePath === null) {
    return (
      <div data-testid="ticket-changes-no-worktree" className={cn("min-h-0 flex-1", EMPTY_PAGE)}>
        <p className="text-ui font-medium text-muted-foreground">No worktree yet</p>
        <p className="text-ui text-muted-foreground/70">Move this ticket to Doing to start one</p>
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const visible =
    needle === ""
      ? nav.files
      : nav.files.filter((file) => file.path.toLowerCase().includes(needle));
  const rows = visible.map((file) => toChangeListRow(file, recency));
  const total = nav.files.length + nav.hiddenCount;

  return (
    <div data-testid="ticket-changes-panel" className="flex min-h-0 flex-1 flex-col">
      <header className={cn("flex shrink-0 flex-col gap-2 pt-1 pb-4", RAIL_PANEL_INSET)}>
        {/* Nothing to refine or total up on a clean branch, so the first row
            keeps only its name and zero. The Git-state strip still distinguishes
            a clean pushed branch from a branch with nothing committed yet. */}
        <div className="flex min-h-7 items-center gap-1">
          <ChangesTitle count={total} />
          {total === 0 ? null : (
            <>
              <HeaderAction
                label="Refresh changes"
                icon={ArrowClockwiseIcon}
                onClick={() => void loadChangeSet(true)}
              />
              <HeaderAction
                label="Filter changed files"
                icon={MagnifyingGlassIcon}
                pressed={filtering}
                onClick={() =>
                  setFiltering((open) => {
                    // Closing the field must also clear it, or the list stays
                    // filtered by a query with nothing on screen explaining it.
                    if (open) setQuery("");
                    return !open;
                  })
                }
              />
              <span className="min-w-1 flex-1" />
              {diff === null ? null : <DiffTotals diff={diff} />}
            </>
          )}
        </div>
        {status === null ? null : <WorktreeStateStrip status={status} />}
        {filtering ? (
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter changed files"
            placeholder="Filter changed files…"
            className="h-7 text-ui"
          />
        ) : null}
      </header>
      {watchError !== null ? <RailFaultBanner error={watchError} onRetry={retryWatch} /> : null}
      <TicketChangesList
        rows={rows}
        // Never a remembered click: a diff the person closed stops being the
        // current row the moment its tab is gone.
        currentPath={parseDiffTabId(activeTabId)}
        onSelectRow={handleSelect}
        error={error}
        hiddenCount={nav.hiddenCount}
      />
    </div>
  );
}
