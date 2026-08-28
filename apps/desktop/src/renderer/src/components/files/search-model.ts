/**
 * The Search page's decisions, as pure data (VC-193, plan §4.7).
 *
 * The panel above this module owns the input box, the request in flight and the
 * drawing. Everything that could be WRONG lives here: which scope pair a search
 * is sent under, which query is worth sending at all, how a result is grouped
 * into files, where in a file a click lands, and — the one this feature would
 * most easily lie about — what the page says when a cap ended the search.
 *
 * Nothing here fetches. The rail passes its own scope in (a Home rail is Home,
 * a Ticket rail is that ticket); unlike quick-open, this surface does not have
 * to work out which workspace it was invoked from, because it is INSIDE one.
 */
import { baseNameOf, dirNameOf } from "@volli/shared";

import type { RevealTarget } from "@renderer/editor/reveal-line";
import type {
  FileSearchFile,
  FileSearchInput,
  FileSearchLimit,
  FileSearchMatch,
} from "../../../../ipc/contract";

/**
 * Which checkout the page searches, and therefore where a result opens.
 *
 * The same pair `volli:search` takes, and the same one a read takes: `home`
 * sends `{ projectId }` and searches Main, `ticket` sends
 * `{ projectId, ticketId }` and searches that ticket's worktree.
 */
export type SearchScope =
  | { readonly kind: "home"; readonly projectId: string }
  | { readonly kind: "ticket"; readonly projectId: string; readonly ticketId: string };

/** How long typing settles before a search is sent. */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * The query actually worth sending, or `null` when there is none.
 *
 * Whitespace-only is nothing: an empty Search page is the resting state, not a
 * request to list the checkout. Trimming here rather than in the input keeps
 * what a person typed visible while deciding what is sent — and main trims
 * again, because a renderer is not where a boundary rule is enforced.
 */
export function searchQuery(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** The IPC request for one scope and one already-trimmed query. */
export function searchInput(scope: SearchScope, query: string): FileSearchInput {
  return scope.kind === "ticket"
    ? { projectId: scope.projectId, ticketId: scope.ticketId, query }
    : { projectId: scope.projectId, query };
}

/** One file's matches, as the page draws them: a heading, then the lines under it. */
export interface SearchGroup {
  readonly relPath: string;
  /** The file's own name — what the eye looks for down a column of results. */
  readonly name: string;
  /** Its folder, beside the name: a repository is full of same-named files. */
  readonly dir: string;
  readonly matches: readonly FileSearchMatch[];
}

/** Groups a result for display. Main already grouped by file; this names the parts. */
export function searchGroups(files: readonly FileSearchFile[]): readonly SearchGroup[] {
  return files.map((file) => ({
    relPath: file.relPath,
    name: baseNameOf(file.relPath),
    dir: dirNameOf(file.relPath),
    matches: file.matches,
  }));
}

/**
 * What the page says about a finished search — the count, and the cap that
 * ended it if one did.
 *
 * THE TRUNCATION HALF IS THE POINT (the 1 MiB read cap's posture). A capped
 * search that reported only "500 matches" would be stating a number that is not
 * the answer to the question asked, and the person reading it has no way to
 * tell. So a cap is named in the same sentence as the count, and the two caps
 * are named apart: "the first 500" is a list that stops, while a search that
 * ran out of time may have missed matches anywhere, including in files it never
 * reached.
 */
export function searchSummary(result: {
  matches: number;
  files: readonly unknown[];
  limit: FileSearchLimit;
}): string {
  const matches = `${result.matches} ${result.matches === 1 ? "match" : "matches"}`;
  const files = `${result.files.length} ${result.files.length === 1 ? "file" : "files"}`;
  const found = `${matches} in ${files}`;
  if (result.limit === "matches") return `First ${found}`;
  if (result.limit === "time") return `${found} before the search ran out of time`;
  return found;
}

/**
 * The one line a truncated search owes beyond its count, or `null` when nothing
 * was cut. Said as a consequence ("there may be more") rather than as a limit
 * ("cap: 500"), because the reader's question is whether they have seen
 * everything, not what the constant is.
 */
export function searchTruncationNote(limit: FileSearchLimit): string | null {
  if (limit === "matches") return "There may be more matches than these.";
  if (limit === "time") return "The search stopped early; there may be more matches.";
  return null;
}

/** One preview split around its match, so the page can emphasise the hit without re-finding it. */
export interface SearchHighlight {
  readonly before: string;
  readonly hit: string;
  readonly after: string;
}

/**
 * Splits a match's preview into the three pieces a row draws.
 *
 * The offsets are main's, computed against the same string it sent (windowing
 * included), so nothing is searched for a second time here — a renderer that
 * re-found the query in the preview would disagree with the engine the moment
 * smart-case matched a different capitalisation.
 *
 * Leading whitespace goes first: a match 20 spaces into an indented line would
 * otherwise draw as an empty row, and the offsets move with the trim.
 */
export function searchHighlight(match: FileSearchMatch): SearchHighlight {
  const indent = match.preview.length - match.preview.trimStart().length;
  const trimmed = match.preview.slice(indent);
  const start = Math.max(0, match.start - indent);
  const end = Math.max(start, match.end - indent);
  return {
    before: trimmed.slice(0, start),
    hit: trimmed.slice(start, end),
    after: trimmed.slice(end),
  };
}

/**
 * Where in the file a clicked match lands.
 *
 * `length` is the QUERY's, not the highlight's: v1 search is literal, so the
 * matched text is exactly as long as what was typed, and a preview windowed
 * around a long line can carry a clipped copy of it.
 */
export function searchRevealTarget(match: FileSearchMatch, query: string): RevealTarget {
  return { line: match.line, column: match.column, length: query.length };
}

/** A stable React key for one match row — a file may match the same line once. */
export function searchMatchKey(relPath: string, match: FileSearchMatch): string {
  return `${relPath}:${match.line}:${match.column}`;
}
