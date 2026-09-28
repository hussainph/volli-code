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
 *
 * WHAT VC-406 CHANGED, and it is all one idea: a result on screen is an answer
 * to a QUESTION, and the page never lets the two drift apart.
 *
 *  - A failed re-search used to throw the previous answer away and draw a
 *    banner in its place. It keeps the rows now and says the read failed on the
 *    heading, because the rows were true for the query they name and a
 *    transport fault does not make them false.
 *  - A first read that FAILED used to be able to draw "No matches" beside its
 *    error — a refused search claiming it had proved the checkout clean. Empty
 *    is a claim about a LANDED read now (`railReadCanClaimEmpty`).
 *  - While a new query is in flight over old results, the summary names BOTH:
 *    what is being searched for, and which query the rows below answer.
 *  - The typed query survives the rail switching pages, per scope, through
 *    `files/navigator-scope-state.ts` — ephemeral, bounded, and holding nothing
 *    but the words, so no unmounted page keeps a search alive.
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
import {
  navigatorScopeKey,
  useRememberedNavigatorView,
} from "@renderer/components/files/navigator-scope-state";
import {
  RailHeadingReadStatus,
  RailReadFaultBody,
  RAIL_PANEL_INSET,
  RAIL_PANEL_MARGIN,
} from "@renderer/components/ticket/rail-panel-parts";
import {
  railReadCanClaimEmpty,
  railReadFeedback,
} from "@renderer/components/ticket/rail-read-feedback";
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
export interface SearchOutcome {
  query: string;
  files: readonly FileSearchFile[];
  matches: number;
  limit: FileSearchLimit;
}

/**
 * The one line under the input, which has to answer two questions at once.
 *
 * The audit's medium finding was that retained results SWALLOWED the pending
 * state: type a second query over a first answer and the page looked settled on
 * an answer to a question nobody had asked any more. So when a search is in
 * flight over retained rows, the sentence names both queries and says which of
 * them the rows belong to. When the last attempt failed, it says the rows are
 * the LAST read rather than the current one — the heading carries the fault and
 * its retry, and this line carries what the rows actually are.
 *
 * `null` is the resting page: nothing typed, nothing read, nothing to say.
 */
export function searchSummaryLine(state: {
  /** The query currently in flight, if any. */
  pending: string | null;
  /** The last search that LANDED, whose rows are on screen. */
  outcome: SearchOutcome | null;
  /** Whether the most recent attempt failed. */
  failed: boolean;
}): string | null {
  const { pending, outcome, failed } = state;
  if (outcome === null) return pending === null ? null : `Searching “${pending}”…`;
  const found = searchSummary(outcome);
  if (pending !== null && pending !== outcome.query) {
    return `Searching “${pending}” · results below are for “${outcome.query}”`;
  }
  if (failed) return `Last read for “${outcome.query}” · ${found}`;
  return found;
}

export interface FileSearchPanelProps {
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
}

export function FileSearchPanel(props: FileSearchPanelProps) {
  // THE SCOPE IS THE IDENTITY, and it is spent as a `key` so a scope change is
  // one SYNCHRONOUS swap. Both rails mount this page once and hand it a new
  // scope (Home when the project changes, a workspace when the ticket does), so
  // discarding the old answer in an effect left one frame where the previous
  // checkout's matches stood under the new checkout's name — and a click on one
  // of those rows opens a path in the wrong tree. A new key is a new instance:
  // no rows, no error and no pending flag survive the commit, and the old
  // instance's teardown runs in it, so a search still out cannot land here.
  return <FileSearchScope key={searchScopeKey(props.scope)} {...props} />;
}

/** The remembered-view key, which is also this page's scope identity. */
function searchScopeKey(scope: SearchScope): string {
  return navigatorScopeKey("search", {
    projectId: scope.projectId,
    ticketId: scope.kind === "ticket" ? scope.ticketId : undefined,
  });
}

function FileSearchScope({ scope, root, onOpenMatch }: FileSearchPanelProps) {
  const projectId = scope.projectId;
  const ticketId = scope.kind === "ticket" ? scope.ticketId : null;

  // The typed query outlives the page's unmount, per checkout. A rail draws one
  // page at a time, so glancing at Now used to delete the words a person had
  // just typed — and the words were the work.
  const [view, setView] = useRememberedNavigatorView(searchScopeKey(scope));
  const raw = view.query;
  const setRaw = React.useCallback(
    (next: string) => setView({ cwd: "", filtering: false, query: next }),
    [setView],
  );

  const [outcome, setOutcome] = React.useState<SearchOutcome | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [searching, setSearching] = React.useState(false);
  // Only the newest request may write results: typing fires more searches than
  // it finishes, and rg's answer for "nee" can easily land after "needle"'s.
  const requestId = React.useRef(0);
  // ...and a page that has gone away writes nothing at all: the rail unmounts
  // this on a tab switch, which is exactly when a slow search is still out.
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = React.useCallback(
    async (query: string) => {
      const request = ++requestId.current;
      setSearching(true);
      try {
        const target: SearchScope =
          ticketId === null ? { kind: "home", projectId } : { kind: "ticket", projectId, ticketId };
        const result = await window.api.files.search(searchInput(target, query));
        if (!mounted.current || request !== requestId.current) return;
        if (!result.ok) {
          // The rows stay. They answer the query they name, and a refused
          // re-search is not evidence against them.
          setError(result.error);
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
        if (!mounted.current || request !== requestId.current) return;
        setError(errorMessage(searchError));
      } finally {
        if (mounted.current && request === requestId.current) setSearching(false);
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

  const feedback = railReadFeedback(
    { hasData: outcome !== null, pending: searching, failed: error !== null },
    "The search",
  );
  const retry = React.useCallback(() => {
    if (query !== null) void run(query);
  }, [query, run]);
  // THE PENDING QUESTION, WHICH STARTS WHEN THE TYPING DOES. `searching` is the
  // IPC's own state and does not begin until the debounce elapses — so for those
  // 200ms a freshly typed query sat over the previous answer's count with
  // nothing saying the two were about different questions. A query that differs
  // from the answer on screen is pending from the keystroke, whether or not a
  // request has left yet; the heading above still reports the READ, which really
  // is idle until then.
  //
  // A FAILED attempt is the exception, and it is the same honesty the other way
  // round: nothing is on its way, so the line stays with what the rows ARE (the
  // last read of their own query) while the heading carries the fault and the
  // retry that clears it.
  const pendingQuery =
    query !== null && (searching || (error === null && query !== (outcome?.query ?? null)))
      ? query
      : null;
  const summary = searchSummaryLine({
    pending: pendingQuery,
    outcome,
    failed: error !== null,
  });

  return (
    <div data-testid="file-search-panel" className="flex min-h-0 flex-1 flex-col">
      <header className={cn("flex shrink-0 flex-col gap-2 pt-1 pb-4", RAIL_PANEL_INSET)}>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="text-ui font-medium">Search</p>
              {/* The read's own state rides this row rather than a strip below
                  it, and brings the retry a stale list needs. */}
              <RailHeadingReadStatus
                word
                feedback={feedback}
                onRetry={retry}
                testId="file-search-read-status"
              />
            </div>
            {/* The navigator's own mono sub-line, saying which checkout these
                results come from — the branch in a Ticket workspace, the
                project in Home. */}
            <p
              data-testid="file-search-scope"
              className="truncate font-mono text-ui text-muted-foreground"
            >
              {root}
            </p>
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
        {summary === null ? null : (
          <p
            data-testid="file-search-summary"
            role="status"
            title={summary}
            className="text-ui text-muted-foreground"
          >
            {summary}
          </p>
        )}
      </header>

      {/* A search that has never landed has no rows to caveat, so the failure IS
          the body — and nothing beside it may claim the checkout holds no
          matches. */}
      <RailReadFaultBody
        feedback={feedback}
        detail={error}
        onRetry={retry}
        testId="file-search-error"
        className={cn("shrink-0", RAIL_PANEL_MARGIN)}
      />

      <SearchResults
        groups={groups}
        query={outcome?.query ?? null}
        limit={outcome?.limit ?? "none"}
        idle={query === null}
        searching={pendingQuery !== null}
        canClaimEmpty={railReadCanClaimEmpty({
          hasData: outcome !== null,
          pending: searching,
          failed: error !== null,
        })}
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
  canClaimEmpty,
  projectId,
  ticketId,
  onOpenMatch,
}: {
  groups: readonly SearchGroup[];
  query: string | null;
  limit: FileSearchLimit;
  idle: boolean;
  searching: boolean;
  /**
   * Whether a search has actually LANDED and returned nothing. "No matches" is
   * a claim about a completed read; a refused one has proved nothing about this
   * checkout and the fault above says so instead.
   */
  canClaimEmpty: boolean;
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
    if (searching) {
      return (
        <p data-testid="file-search-pending" className={EMPTY_INLINE}>
          Searching…
        </p>
      );
    }
    if (!canClaimEmpty) return null;
    return (
      <p data-testid="file-search-empty" className={EMPTY_INLINE}>
        No matches
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
      // A FIXED 32px column, so every quoted line starts at the same x down the
      // page and the code reads as a column of code rather than a ragged edge
      // that moves with the line numbers' digit count.
      leading={
        <span className="w-8 shrink-0 text-right font-mono text-ui text-muted-foreground/70 tabular-nums">
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
