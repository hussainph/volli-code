/**
 * Search — the rail's find-across-files page, at both scopes (VC-193, plan
 * §4.7).
 *
 * ONE COMPONENT FOR HOME AND A TICKET, because it is one surface at two scopes
 * exactly as the two file navigators are: the scope pair arrives as a prop, the
 * engine resolves it through the same seam a read resolves through, and the
 * only thing that differs between the two mountings is which store action a
 * click calls. A second copy of this page is how one scope would silently keep
 * searching Main from inside a worktree.
 *
 * FIND ONLY (v1). There is no replace here — replace-across-files beside a live
 * agent is a different risk class and the plan holds it out until it is wanted.
 *
 * WHAT A CLICK DOES: previews the file (the navigator's own single-click
 * grammar, decision #56) and lands on the match line through
 * `editor/reveal-line.ts`. The reveal is requested BEFORE the tab is opened, so
 * a file that has to mount its editor first finds the request waiting for it.
 *
 * The page is honest about its own bounds: a search that hit the match cap or
 * ran out of time says so under the results rather than presenting a cut list
 * as the whole answer.
 */
import * as React from "react";
import { FileCodeIcon } from "@phosphor-icons/react/dist/csr/FileCode";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { errorMessage } from "@volli/shared";

import {
  searchGroups,
  searchHighlight,
  searchInput,
  searchMatchKey,
  searchQuery,
  searchRevealTarget,
  searchSummary,
  searchTruncationNote,
  SEARCH_DEBOUNCE_MS,
  type SearchGroup,
  type SearchScope,
} from "@renderer/components/files/search-model";
import { CopyPathContextMenuItems } from "@renderer/components/files/copy-path-menu";
import { ExternalAppContextMenu } from "@renderer/components/files/external-app-menu";
import { RailFaultBanner, RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { ListRow } from "@renderer/components/ui/list-row";
import { fileRevealKey, requestFileReveal } from "@renderer/editor/reveal-line";
import { cn } from "@renderer/lib/utils";
import type { FileSearchFile, FileSearchLimit, FileSearchMatch } from "../../../../ipc/contract";

/** A finished search, as the page holds it. */
interface SearchOutcome {
  query: string;
  files: readonly FileSearchFile[];
  matches: number;
  limit: FileSearchLimit;
}

export function FileSearchPanel({
  scope,
  root,
  onOpenMatch,
}: {
  scope: SearchScope;
  /**
   * What is being searched, in the words the scope's own navigator uses for it
   * — Home's project name, a ticket's branch. Passed in rather than derived so
   * the two pages of one rail name the same thing the same way.
   */
  root: string;
  /**
   * Opens `relPath` as a PREVIEW tab in the surface that owns this rail. The
   * line is landed on separately (see the header), so a host wires only its own
   * store action here.
   */
  onOpenMatch(relPath: string): void;
}) {
  const [raw, setRaw] = React.useState("");
  const [outcome, setOutcome] = React.useState<SearchOutcome | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [searching, setSearching] = React.useState(false);
  // Only the newest request may write results: typing fires more searches than
  // it finishes, and rg's answer for "nee" can easily land after "needle"'s.
  const requestId = React.useRef(0);

  const projectId = scope.projectId;
  const ticketId = scope.kind === "ticket" ? scope.ticketId : null;

  const run = React.useCallback(
    async (query: string) => {
      const request = ++requestId.current;
      setSearching(true);
      try {
        const target: SearchScope =
          ticketId === null ? { kind: "home", projectId } : { kind: "ticket", projectId, ticketId };
        const result = await window.api.files.search(searchInput(target, query));
        if (request !== requestId.current) return;
        if (!result.ok) {
          setError(result.error);
          setOutcome(null);
          return;
        }
        setError(null);
        setOutcome({
          query,
          files: result.files,
          matches: result.matches,
          limit: result.limit,
        });
      } catch (searchError) {
        if (request !== requestId.current) return;
        setError(errorMessage(searchError));
        setOutcome(null);
      } finally {
        if (request === requestId.current) setSearching(false);
      }
    },
    [projectId, ticketId],
  );

  // Debounced, and cancelled on scope change: a rail that switched projects
  // mid-keystroke must not paint the previous checkout's matches.
  const query = searchQuery(raw);
  React.useEffect(() => {
    if (query === null) {
      requestId.current += 1;
      setOutcome(null);
      setError(null);
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(() => void run(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, run]);

  // A new scope is a new question; the old answer would be about another
  // checkout entirely.
  React.useEffect(() => {
    requestId.current += 1;
    setOutcome(null);
    setError(null);
    setSearching(false);
  }, [projectId, ticketId]);

  const groups = React.useMemo(
    () => (outcome === null ? [] : searchGroups(outcome.files)),
    [outcome],
  );

  const openMatch = React.useCallback(
    (relPath: string, match: FileSearchMatch, matchedQuery: string) => {
      // Requested first: an unopened file mounts its editor asynchronously and
      // claims the request when Monaco is ready, while an already-open one is
      // told immediately. Either way exactly one editor consumes it.
      requestFileReveal(
        fileRevealKey({ projectId, ticketId: ticketId ?? undefined, relPath }),
        searchRevealTarget(match, matchedQuery),
      );
      onOpenMatch(relPath);
    },
    [onOpenMatch, projectId, ticketId],
  );

  return (
    <div data-testid="file-search-panel" className="flex min-h-0 flex-1 flex-col">
      <header className={cn("flex shrink-0 flex-col gap-2 pt-1 pb-4", RAIL_PANEL_INSET)}>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-ui font-medium">Search</p>
            {/* The navigator's own mono sub-line, saying which checkout these
                results come from — the branch in a Ticket workspace, the
                project in Home. */}
            <p className="truncate font-mono text-ui text-muted-foreground">{root}</p>
          </div>
          <MagnifyingGlassIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </div>
        <Input
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          aria-label="Search files"
          placeholder="Find in files…"
          spellCheck={false}
          className="text-ui"
        />
        {outcome !== null ? (
          <p data-testid="file-search-summary" className="text-ui text-muted-foreground">
            {searchSummary(outcome)}
          </p>
        ) : null}
      </header>

      {error !== null ? (
        <RailFaultBanner
          testId="file-search-error"
          label="Search failed"
          error={error}
          onRetry={() => {
            if (query !== null) void run(query);
          }}
        />
      ) : null}

      <SearchResults
        groups={groups}
        query={outcome?.query ?? null}
        limit={outcome?.limit ?? "none"}
        idle={query === null}
        searching={searching && outcome === null}
        projectId={projectId}
        ticketId={ticketId}
        onOpenMatch={openMatch}
      />
    </div>
  );
}

/** The result list: one heading per file, its matched lines under it. */
function SearchResults({
  groups,
  query,
  limit,
  idle,
  searching,
  projectId,
  ticketId,
  onOpenMatch,
}: {
  groups: readonly SearchGroup[];
  query: string | null;
  limit: FileSearchLimit;
  idle: boolean;
  searching: boolean;
  projectId: string;
  ticketId: string | null;
  onOpenMatch(relPath: string, match: FileSearchMatch, query: string): void;
}) {
  if (idle) {
    return (
      <p data-testid="file-search-idle" className={EMPTY_INLINE}>
        Type to find text in these files
      </p>
    );
  }
  if (groups.length === 0) {
    return (
      <p data-testid="file-search-empty" className={EMPTY_INLINE}>
        {searching ? "Searching…" : "No matches"}
      </p>
    );
  }
  const note = searchTruncationNote(limit);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-8 [scroll-padding-bottom:2rem]">
      <ul data-testid="file-search-results" className="px-2">
        {groups.map((group) => (
          <li key={group.relPath}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <ListRow
                  data-testid="file-search-file"
                  data-path={group.relPath}
                  onActivate={null}
                  leading={<FileCodeIcon className="size-4 shrink-0 text-muted-foreground" />}
                  primary={group.name}
                  secondary={group.dir}
                  trailing={
                    <span className="shrink-0 text-label text-muted-foreground tabular-nums">
                      {group.matches.length}
                    </span>
                  }
                />
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ExternalAppContextMenu
                  target={{
                    kind: "file",
                    projectId,
                    ticketId: ticketId ?? undefined,
                    relPath: group.relPath,
                  }}
                />
                <ContextMenuSeparator />
                <CopyPathContextMenuItems
                  target={{ projectId, ticketId: ticketId ?? undefined, relPath: group.relPath }}
                />
              </ContextMenuContent>
            </ContextMenu>
            <ul>
              {group.matches.map((match) => (
                <li key={searchMatchKey(group.relPath, match)}>
                  <MatchRow
                    match={match}
                    onActivate={() => onOpenMatch(group.relPath, match, query ?? "")}
                  />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {note === null ? null : (
        <p
          data-testid="file-search-truncated"
          className={cn("pt-2 text-ui text-muted-foreground", RAIL_PANEL_INSET)}
        >
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * One matched line: its number, then the line with the match emphasised.
 *
 * Monospace, because this is code being quoted rather than a label — and the
 * line number is the fact that makes a result a place rather than a string.
 */
function MatchRow({ match, onActivate }: { match: FileSearchMatch; onActivate(): void }) {
  const { before, hit, after } = searchHighlight(match);
  return (
    <ListRow
      data-testid="file-search-match"
      data-line={match.line}
      onActivate={onActivate}
      leading={
        <span className="w-8 shrink-0 text-right font-mono text-label text-muted-foreground/70 tabular-nums">
          {match.line}
        </span>
      }
      primary={
        <span className="min-w-0 flex-1 truncate font-mono text-ui">
          <span className="text-muted-foreground">{before}</span>
          <mark className="rounded-xs bg-attention/25 text-foreground">{hit}</mark>
          <span className="text-muted-foreground">{after}</span>
        </span>
      }
    />
  );
}
