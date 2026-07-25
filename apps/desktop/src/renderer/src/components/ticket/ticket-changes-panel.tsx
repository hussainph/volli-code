/**
 * Changes navigator — compact flat Change Set list (decision #53).
 *
 * Selecting a row opens/focuses a ticket file tab via the host callback
 * (`openTicketFile` today; #109 swaps that one call to a diff tab). Debounced
 * worktree events only refresh rows — never open, close, or focus a tab.
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
}: {
  rows: readonly ChangeRowPresentation[];
  focusPath: string | null;
  onSelectRow(path: string): void;
  error?: string | null;
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
    </ul>
  );
}

/**
 * Loads the Change Set, watches the worktree, and refreshes on debounced
 * `onChanged` events. Row click is the only path that asks the host to open a
 * tab — refresh handlers never call `onOpenFile`.
 */
export function TicketChangesPanel({
  ticket,
  activeTabId,
  onOpenFile,
}: {
  ticket: Ticket;
  /** Observed so refresh can be proven never to mutate it (decision #46/#48). */
  activeTabId: string;
  /**
   * Deliberate open. Host wires `openTicketFile` for #108; #109 swaps this to
   * the Monaco diff-tab opener — a one-line change at the call site.
   */
  onOpenFile(relPath: string): void;
}) {
  const [nav, setNav] = React.useState<ChangesNavigatorState>(() => ({
    revision: null,
    files: [] as ChangeSetFile[],
    activeTabId,
    listFocusPath: null,
  }));
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);

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

  const loadChangeSet = React.useCallback(async () => {
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
        toastError(`Couldn't load changes: ${result.error}`);
        return;
      }
      setError(null);
      setNav((prev) => applyChangeSetRefresh(prev, result.changeSet));
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      toastError(`Couldn't load changes: ${message}`);
    } finally {
      loading.current = false;
      setLoaded(true);
    }
    if (reloadPending.current) {
      reloadPending.current = false;
      await loadRef.current();
    }
  }, [ticket.id, ticket.worktreePath]);

  React.useEffect(() => {
    loadRef.current = loadChangeSet;
  }, [loadChangeSet]);

  React.useEffect(() => {
    void loadChangeSet();
  }, [loadChangeSet]);

  // Watch lifecycle: start when the ticket has a live worktree; the returned
  // teardown always unwatches, so watches cannot leak.
  React.useEffect(() => {
    if (ticket.worktreePath === null) return;
    return subscribeWorktreeChanges(window.api.worktree, ticket.id, {
      // Refresh ONLY — never open/focus a tab from a filesystem event.
      onChanged: () => void loadChangeSet(),
      onWatchError: (message) => toastError(`Couldn't watch changes: ${message}`),
    });
  }, [ticket.id, ticket.worktreePath, loadChangeSet]);

  const handleSelect = React.useCallback(
    (path: string) => {
      setNav((prev) => selectChangeRow(prev, path).state);
      // Deliberate click — the only place we ask the host to open a tab.
      onOpenFile(path);
    },
    [onOpenFile],
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
      <TicketChangesList
        rows={rows}
        focusPath={nav.listFocusPath}
        onSelectRow={handleSelect}
        error={error}
      />
    </div>
  );
}
