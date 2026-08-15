/**
 * Diffs navigator — the Calm Stack's changes page
 * (lab/scratches/ticket-right-sidebar.tsx `ChangesPanel`).
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
  selectChangeRow,
  type ChangeRowPresentation,
  type ChangesNavigatorState,
} from "@renderer/components/ticket/ticket-changes-model";
import type { ChangeRecencyState } from "@renderer/components/ticket/ticket-change-recency";
import { subscribeWorktreeChanges } from "@renderer/components/ticket/worktree-change-watch";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
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
      <span className="rounded-full bg-accent px-1 font-mono text-label text-muted-foreground">
        {count}
      </span>
    </>
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

/** Presentational flat list — unit-tested via renderToStaticMarkup. */
export function TicketChangesList({
  rows,
  focusPath,
  onSelectRow,
  error,
  hiddenCount = 0,
}: {
  rows: readonly ChangeListRow[];
  focusPath: string | null;
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
      <div
        data-testid="ticket-changes-empty"
        className={cn(
          "flex items-start gap-2 rounded-lg border border-sidebar-border/70 bg-background/30 p-4",
          RAIL_PANEL_MARGIN,
        )}
      >
        <CheckCircleIcon className="mt-1 size-4 shrink-0 text-positive" weight="fill" />
        <div>
          <p className="text-ui font-medium">No changes vs base</p>
          <p className="mt-1 text-ui text-muted-foreground">The branch is up to date.</p>
        </div>
      </div>
    );
  }

  return (
    <ul
      data-testid="ticket-changes-list"
      className="min-h-0 flex-1 overflow-y-auto px-2 pb-8 [scroll-padding-bottom:2rem]"
      role="listbox"
      aria-label="Change Set"
    >
      {rows.map((row) => {
        const focused = focusPath === row.path;
        const status = CHANGE_STATUS[row.statusKind];
        const StatusIcon = status.icon;
        return (
          <li key={row.path} role="option" aria-selected={focused}>
            <div
              className={cn(
                "group relative w-full rounded-lg text-left",
                focused ? "bg-accent/70" : "hover:bg-accent/50",
              )}
            >
              <button
                type="button"
                data-testid="ticket-changes-row"
                data-path={row.path}
                data-focused={focused ? "true" : undefined}
                aria-label={`${row.statusLabel}: ${row.path}`}
                onClick={() => onSelectRow(row.path)}
                // Two `text-ui` line boxes (20 each) plus `py-1.5` is the 52px
                // row — the height is the content, not a number. `min-h-13` is
                // the same 52 as a floor, and it binds for exactly one case: a
                // repository-root file has no parent path, so its second line
                // draws no box at all and the row would otherwise sit 20px
                // shorter than every neighbour. `py-1.5` is a RECORDED spacing
                // exception (docs/DESIGN.md): `py-2` would grow every row of a
                // dense list to 56 and orphan the floor.
                className="grid min-h-13 w-full grid-cols-[16px_minmax(0,1fr)_72px] items-center gap-x-2 px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
              >
                <StatusIcon className={cn("size-4 shrink-0", status.ink)} weight="bold" />
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate text-ui font-medium">{row.filename}</span>
                    {row.updatedLabel !== undefined && row.updatedDescription !== undefined ? (
                      <span
                        data-testid="ticket-changes-updated"
                        aria-label={row.updatedDescription}
                        className="shrink-0 text-label font-medium text-primary-text"
                      >
                        {row.updatedLabel}
                      </span>
                    ) : null}
                    {/* The status word yields to the row's hover actions —
                        they occupy the same strip, and the glyph on the left
                        has already said which kind of change this is. */}
                    <span
                      className={cn(
                        "shrink-0 text-label font-medium transition-opacity duration-100 group-focus-within:opacity-0 group-hover:opacity-0 motion-reduce:transition-none",
                        "group-data-[narrow=true]/rail:sr-only",
                        status.ink,
                      )}
                    >
                      {row.statusLabel}
                    </span>
                  </span>
                  <span className="block truncate text-ui text-muted-foreground/70">
                    {row.renameFrom !== null ? `← ${row.renameFrom}` : row.parentPath}
                  </span>
                </span>
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
              </button>
              {/* Overlaid rather than a fourth grid column: the actions only
                  exist on hover, and a column reserved for them would indent
                  every row's counts for the one row a pointer is over. */}
              <RailRowActions
                path={row.path}
                onOpen={onSelectRow}
                className="absolute top-[5px] right-20 z-10 rounded-md bg-accent/90 px-1 shadow-raised"
              />
            </div>
          </li>
        );
      })}
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
  /** Observed so refresh can be proven never to mutate it (decision #46/#48). */
  activeTabId: string;
  /** Ticket-owned passive awareness shared by every File/Diff representation. */
  recency: ChangeRecencyState;
  /** Deliberate open — host wires `openTicketDiff` (CONCEPT #48/#51). */
  onOpenDiff(file: OpenChangeDiffTarget): void;
}) {
  const [nav, setNav] = React.useState<ChangesNavigatorState>(() => ({
    revision: null,
    files: [] as ChangeSetFile[],
    activeTabId,
    listFocusPath: null,
    hiddenCount: 0,
  }));
  const [diff, setDiff] = React.useState<DiffStat | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [watchError, setWatchError] = React.useState<string | null>(null);
  // Bumped by Retry to re-run the watch effect after a fault tore it down.
  const [watchAttempt, setWatchAttempt] = React.useState(0);
  const [filtering, setFiltering] = React.useState(false);
  const [query, setQuery] = React.useState("");

  // Mirror the host's active tab into navigator state for the refresh contract
  // without ever letting a refresh write it back.
  React.useEffect(() => {
    setNav((prev) => (prev.activeTabId === activeTabId ? prev : { ...prev, activeTabId }));
  }, [activeTabId]);

  // A snapshot is five git commands over the whole worktree, and a write storm
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
        setLoaded(true);
        return;
      }
      if (loading.current) {
        reloadPending.current = true;
        return;
      }
      loading.current = true;
      try {
        const result = await window.api.worktree.changeSet(ticket.id);
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
      setNav((prev) => selectChangeRow(prev, path).state);
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
        {/* Nothing to refine or total up on a clean branch, so the header
            keeps only its name and its zero — the controls would be three
            no-ops over an empty list. */}
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
        focusPath={nav.listFocusPath}
        onSelectRow={handleSelect}
        error={error}
        hiddenCount={nav.hiddenCount}
      />
    </div>
  );
}
