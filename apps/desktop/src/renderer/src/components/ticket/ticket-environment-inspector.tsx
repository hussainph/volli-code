import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import { GitPullRequestIcon } from "@phosphor-icons/react/dist/csr/GitPullRequest";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { type ChangeSetSnapshot, type Ticket } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  beginTicketEnvironmentRead,
  buildTicketEnvironmentInspector,
  hasChangeSetRow,
  readTicketEnvironmentChangeSet,
  settleTicketEnvironmentRead,
  shouldRevalidateTicketEnvironment,
  type TicketEnvironmentConsultation,
  type TicketEnvironmentDestination,
  type TicketEnvironmentRow,
  ticketEnvironmentConsultationFor,
} from "@renderer/components/ticket/ticket-environment-inspector-model";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";

/**
 * Keyed by the model's own row union rather than re-listing it, so a new row
 * kind is a compile error here instead of silently taking a default glyph.
 */
const ENVIRONMENT_ICONS: Record<TicketEnvironmentRow["id"], PhosphorIcon> = {
  changes: GitDiffIcon,
  worktree: TerminalWindowIcon,
  branch: GitBranchIcon,
  "pull-request": GitPullRequestIcon,
};

function EnvironmentIcon({ id }: { id: TicketEnvironmentRow["id"] }) {
  const Icon = ENVIRONMENT_ICONS[id];
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
  onOpenSource,
}: {
  ticket: Ticket;
  /** Optional fixture/static snapshot. Live use reads one snapshot on mount. */
  changeSet?: ChangeSetSnapshot;
  onNavigate(destination: TicketEnvironmentDestination): void;
  /** Open one referenced file — a Sources row promises the file, not the list. */
  onOpenSource(relPath: string): void;
}) {
  const [consultation, setConsultation] = React.useState<TicketEnvironmentConsultation>(() => ({
    ticketId: ticket.id,
  }));
  // The rail reuses this Inspector across tickets, so a read is only ever
  // applied while it is still the newest one — a swap mid-read supersedes it
  // rather than letting the previous ticket's counts land under the new one.
  const changeSetRead = useLatestAsync();
  const loading = React.useRef(false);
  const lastReadAt = React.useRef<number | null>(changeSet === undefined ? null : Date.now());

  const ticketId = ticket.id;
  const refresh = React.useCallback(async () => {
    if (ticket.worktreePath === null || loading.current) return;
    const token = changeSetRead.claim();
    loading.current = true;
    setConsultation((previous) => beginTicketEnvironmentRead(previous, ticketId));
    try {
      const result = await readTicketEnvironmentChangeSet(() =>
        window.api.worktree.changeSet(ticketId),
      );
      if (!changeSetRead.isCurrent(token)) return; // superseded — drop the stale result
      setConsultation((previous) => settleTicketEnvironmentRead(previous, ticketId, result));
    } finally {
      if (changeSetRead.isCurrent(token)) {
        lastReadAt.current = Date.now();
        loading.current = false;
      }
    }
  }, [changeSetRead, ticketId, ticket.worktreePath]);

  React.useEffect(() => {
    if (changeSet !== undefined || ticket.worktreePath === null) return;
    void refresh();
    // A ticket swap (or unmount) retires the read in flight: its late resolve
    // drops itself, and the freshness clock and in-flight gate reset so the
    // next ticket's own read is never held behind the one it replaced.
    return () => {
      changeSetRead.invalidate();
      loading.current = false;
      lastReadAt.current = null;
    };
  }, [changeSet, changeSetRead, refresh, ticket.worktreePath]);

  // Counts read for another ticket describe nothing here, so the swap shows a
  // pending read rather than a frame of the previous ticket's Inspector.
  const consulted = ticketEnvironmentConsultationFor(consultation, ticketId);

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
      changeSet={changeSet ?? consulted.changeSet}
      changeSetError={consulted.error}
      onNavigate={onNavigate}
      onOpenSource={onOpenSource}
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
  onOpenSource,
  onRetry,
  onConsult,
}: {
  ticket: Ticket;
  changeSet?: ChangeSetSnapshot;
  changeSetError?: string;
  onNavigate(destination: TicketEnvironmentDestination): void;
  onOpenSource(relPath: string): void;
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
            <div
              role="alert"
              data-testid="ticket-environment-change-set-error"
              className="mt-1 flex items-center gap-2 text-xs text-destructive"
            >
              <span title={changeSetError} className="min-w-0 flex-1 truncate">
                {hasChangeSetRow(inspector)
                  ? `Changes may be out of date: ${changeSetError}`
                  : `Couldn’t load changes: ${changeSetError}`}
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
              data-testid="ticket-environment-source"
              data-rel-path={source.relPath}
              title={source.relPath}
              onClick={() => onOpenSource(source.relPath)}
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
