import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import { GitPullRequestIcon } from "@phosphor-icons/react/dist/csr/GitPullRequest";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { type ChangeSetSnapshot, errorMessage, type Ticket } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  buildTicketEnvironmentInspector,
  type TicketEnvironmentDestination,
  type TicketEnvironmentRow,
} from "@renderer/components/ticket/ticket-environment-inspector-model";

const INSPECTOR_REVALIDATE_AFTER_MS = 5_000;

/** The rail re-reads only when a person returns to it, never as a second live watcher. */
export function shouldRevalidateTicketEnvironment({
  lastReadAt,
  now,
  loading,
}: {
  lastReadAt: number | null;
  now: number;
  loading: boolean;
}): boolean {
  return !loading && (lastReadAt === null || now - lastReadAt >= INSPECTOR_REVALIDATE_AFTER_MS);
}

type TicketEnvironmentChangeSetResult =
  | { ok: true; changeSet: ChangeSetSnapshot }
  | { ok: false; error: string };

/** Pure read outcome: the Retry button and initial load share these exact semantics. */
export async function readTicketEnvironmentChangeSet(
  read: () => Promise<TicketEnvironmentChangeSetResult>,
): Promise<{ changeSet: ChangeSetSnapshot } | { error: string }> {
  try {
    const result = await read();
    return result.ok ? { changeSet: result.changeSet } : { error: result.error };
  } catch (cause) {
    return { error: errorMessage(cause) };
  }
}

function EnvironmentIcon({ id }: { id: TicketEnvironmentRow["id"] }) {
  const Icon =
    id === "changes"
      ? GitDiffIcon
      : id === "worktree"
        ? TerminalWindowIcon
        : id === "pull-request"
          ? GitPullRequestIcon
          : GitBranchIcon;
  return <Icon weight="fill" className="size-4 shrink-0 text-muted-foreground" />;
}

/**
 * The Ticket Session's pinned rail summary. It reads on mount and only
 * revalidates when a person returns after a short interval, so the fuller
 * Changes navigator remains the sole live watch owner. Every row is a
 * deliberate route into that existing navigator; this surface owns no worktree
 * or attachment state.
 */
export function TicketEnvironmentInspector({
  ticket,
  changeSet,
  onNavigate,
}: {
  ticket: Ticket;
  /** Optional fixture/static snapshot. Live use reads one snapshot on mount. */
  changeSet?: ChangeSetSnapshot;
  onNavigate(destination: TicketEnvironmentDestination): void;
}) {
  const [loadedChangeSet, setLoadedChangeSet] = React.useState<ChangeSetSnapshot | undefined>(
    changeSet,
  );
  const [error, setError] = React.useState<string | null>(null);
  const loading = React.useRef(false);
  const lastReadAt = React.useRef<number | null>(changeSet === undefined ? null : Date.now());

  const refresh = React.useCallback(async () => {
    if (ticket.worktreePath === null || loading.current) return;
    loading.current = true;
    setError(null);
    try {
      const result = await readTicketEnvironmentChangeSet(() =>
        window.api.worktree.changeSet(ticket.id),
      );
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setLoadedChangeSet(result.changeSet);
    } finally {
      lastReadAt.current = Date.now();
      loading.current = false;
    }
  }, [ticket.id, ticket.worktreePath]);

  React.useEffect(() => {
    if (changeSet !== undefined || ticket.worktreePath === null) return;
    void refresh();
  }, [changeSet, refresh, ticket.worktreePath]);

  const revalidateOnConsult = React.useCallback(() => {
    if (
      shouldRevalidateTicketEnvironment({
        lastReadAt: lastReadAt.current,
        now: Date.now(),
        loading: loading.current,
      })
    ) {
      void refresh();
    }
  }, [refresh]);

  return (
    <TicketEnvironmentInspectorContent
      ticket={ticket}
      changeSet={changeSet ?? loadedChangeSet}
      changeSetError={error ?? undefined}
      onNavigate={onNavigate}
      onRetry={() => void refresh()}
      onConsult={revalidateOnConsult}
    />
  );
}

/**
 * Pure Inspector presentation, kept separate from its one-shot read so the
 * loading, failure, narrow-content, and empty states share the same public
 * surface in tests and at runtime.
 */
export function TicketEnvironmentInspectorContent({
  ticket,
  changeSet,
  changeSetError,
  onNavigate,
  onRetry,
  onConsult,
}: {
  ticket: Ticket;
  changeSet?: ChangeSetSnapshot;
  changeSetError?: string;
  onNavigate(destination: TicketEnvironmentDestination): void;
  /** Required because an exposed failure must always have a recovery path. */
  onRetry(): void;
  /** Entering the summary is the only passive freshness trigger. */
  onConsult?(): void;
}) {
  const inspector = buildTicketEnvironmentInspector({
    ticket,
    changeSet,
    changeSetError,
  });
  if (inspector.environment.length === 0 && inspector.sources.length === 0) return null;

  const visibleSources = inspector.sources.slice(0, 3);
  return (
    <section
      data-testid="ticket-environment-inspector"
      className="shrink-0 border-b border-sidebar-border px-4 py-4"
      onFocusCapture={onConsult}
      onPointerEnter={onConsult}
    >
      {inspector.environment.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h2 className="text-label font-medium text-muted-foreground uppercase">Environment</h2>
          {inspector.environment.map((row) => (
            <button
              key={row.id}
              type="button"
              data-testid={`ticket-environment-destination-${row.destination}`}
              title={row.detail}
              onClick={() => onNavigate(row.destination)}
              className="-mx-1 flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent motion-reduce:transition-none"
            >
              <EnvironmentIcon id={row.id} />
              <span className="min-w-0 flex-1 truncate text-ui text-foreground">{row.label}</span>
              <span className="max-w-32 shrink truncate text-xs text-muted-foreground">
                {row.detail}
              </span>
            </button>
          ))}
          {changeSetError !== undefined ? (
            <div role="alert" className="mt-1 flex items-center gap-2 text-xs text-destructive">
              <span title={changeSetError} className="min-w-0 flex-1 truncate">
                Couldn’t load changes: {changeSetError}
              </span>
              <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
                <ArrowClockwiseIcon weight="fill" />
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {inspector.environment.length > 0 && inspector.sources.length > 0 ? (
        <div className="my-3 border-t border-sidebar-border" />
      ) : null}
      {inspector.sources.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h2 className="text-label font-medium text-muted-foreground uppercase">Sources</h2>
          {visibleSources.map((source) => (
            <button
              key={source.relPath}
              type="button"
              data-testid={`ticket-environment-destination-${source.destination}`}
              title={source.relPath}
              onClick={() => onNavigate(source.destination)}
              className="-mx-1 flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent motion-reduce:transition-none"
            >
              <FoldersIcon weight="fill" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                {source.label}
              </span>
            </button>
          ))}
          {inspector.sources.length > visibleSources.length ? (
            <button
              type="button"
              data-testid="ticket-environment-destination-files"
              onClick={() => onNavigate("files")}
              className="-mx-1 flex items-center gap-2 rounded-md px-1 py-1 text-left text-ui text-muted-foreground transition-colors hover:bg-accent hover:text-foreground motion-reduce:transition-none"
            >
              <FoldersIcon weight="fill" className="size-4" />
              View all
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
