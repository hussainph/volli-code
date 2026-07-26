/**
 * Changes navigator — compact flat Change Set list (decision #53).
 *
 * Selecting a row asks the host to open/focus a Monaco diff tab via
 * `onOpenDiff` (`openTicketDiff`, CONCEPT #48/#51). Refresh handlers never
 * open, close, or focus a tab. Files navigator uses preview/pin (decision #56).
 */
import * as React from "react";
import { errorMessage, type ChangeSetFile, type Ticket } from "@volli/shared";

import {
  applyChangeSetRefresh,
  presentChangeRow,
  selectChangeRow,
  type ChangeRowPresentation,
  type ChangesNavigatorState,
} from "@renderer/components/ticket/ticket-changes-model";
import { subscribeWorktreeChanges } from "@renderer/components/ticket/worktree-change-watch";
import { cn } from "@renderer/lib/utils";
import { toastError } from "@renderer/lib/toast";

/** Presentational flat list — unit-tested via renderToStaticMarkup. */
export function TicketChangesList({
  rows,
  focusPath,
  onSelectRow,
  error,
  hiddenCount = 0,
}: {
  rows: readonly ChangeRowPresentation[];
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
        className="flex min-h-0 flex-1 flex-col px-4 py-5"
        role="alert"
      >
        <p className="text-ui text-destructive">{error}</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        data-testid="ticket-changes-empty"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center"
      >
        <p className="text-ui font-medium text-muted-foreground">No changes vs base</p>
      </div>
    );
  }

  return (
    <ul
      data-testid="ticket-changes-list"
      className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2"
      role="listbox"
      aria-label="Change Set"
    >
      {rows.map((row) => {
        const focused = focusPath === row.path;
        return (
          <li key={row.path} role="option" aria-selected={focused}>
            <button
              type="button"
              data-testid={`ticket-changes-row`}
              data-path={row.path}
              data-focused={focused ? "true" : undefined}
              onClick={() => onSelectRow(row.path)}
              className={cn(
                "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
                "hover:bg-accent",
                focused && "bg-accent",
              )}
            >
              <span className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="truncate text-ui font-medium text-foreground">{row.filename}</span>
                <span className="flex shrink-0 items-baseline gap-1.5 text-xs text-muted-foreground">
                  <span>{row.statusLabel}</span>
                  {row.countsLabel !== null ? (
                    <span className="font-mono tabular-nums">{row.countsLabel}</span>
                  ) : null}
                </span>
              </span>
              {row.parentPath !== "" ? (
                <span className="truncate text-xs text-muted-foreground/80">{row.parentPath}</span>
              ) : null}
              {row.renameFrom !== null ? (
                <span className="truncate text-xs text-muted-foreground/70">
                  ← {row.renameFrom}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
      {hiddenCount > 0 ? (
        <li
          data-testid="ticket-changes-truncated"
          data-hidden-count={hiddenCount}
          className="px-2 py-1.5 text-xs text-muted-foreground/80"
          role="presentation"
        >
          {hiddenCount.toLocaleString()} more {hiddenCount === 1 ? "file" : "files"} not shown
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The watch is dead — the list below is a frozen snapshot, not a live one. An
 * inline banner rather than a replacement: the rows shown are still accurate as
 * of the last refresh, so hiding them would lose real information. Retry
 * re-subscribes and re-reads.
 */
function ChangesWatchErrorBanner({ error, onRetry }: { error: string; onRetry(): void }) {
  return (
    <div
      data-testid="ticket-changes-watch-error"
      role="alert"
      className="flex shrink-0 items-baseline justify-between gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-2"
    >
      <span className="min-w-0 text-xs text-destructive">Changes stopped updating: {error}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 text-xs text-primary-text hover:underline"
      >
        Retry
      </button>
    </div>
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
  onOpenDiff,
}: {
  ticket: Ticket;
  /** Observed so refresh can be proven never to mutate it (decision #46/#48). */
  activeTabId: string;
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
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [watchError, setWatchError] = React.useState<string | null>(null);
  // Bumped by Retry to re-run the watch effect after a fault tore it down.
  const [watchAttempt, setWatchAttempt] = React.useState(0);

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
    return (
      <div
        data-testid="ticket-changes-loading"
        className="flex min-h-0 flex-1 items-center justify-center px-4 py-8"
      >
        <p className="text-ui text-muted-foreground">Loading changes…</p>
      </div>
    );
  }

  if (ticket.worktreePath === null) {
    return (
      <div
        data-testid="ticket-changes-no-worktree"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center"
      >
        <p className="text-ui font-medium text-muted-foreground">No worktree yet</p>
        <p className="text-xs text-muted-foreground/80">Move this ticket to Doing to start one</p>
      </div>
    );
  }

  const rows = nav.files.map(presentChangeRow);
  return (
    <div data-testid="ticket-changes-panel" className="flex min-h-0 flex-1 flex-col">
      {watchError !== null ? (
        <ChangesWatchErrorBanner error={watchError} onRetry={retryWatch} />
      ) : null}
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
