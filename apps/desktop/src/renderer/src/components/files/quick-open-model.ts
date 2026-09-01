/**
 * Quick-open's three decisions, as pure data (plan §4.4).
 *
 * The overlay above this module owns presentation and one piece of ephemeral
 * view state a controlled input cannot derive (the typed query). Everything
 * that could be wrong lives here: WHICH checkout is being searched, WHAT the
 * query matches, and WHETHER an invocation previews or pins.
 *
 * Nothing about ranking is invented here either. {@link rankIndexedFiles} is
 * the `@` picker's own matcher (`editor/file-refs.ts` → `@volli/shared`'s
 * `scoreFileMatch`), so the list ⌘P shows and the list `@` shows are ordered by
 * one function. What quick-open does NOT take from that picker is its
 * `isExpressibleRefPath` filter or its "Create artifact" row: both belong to
 * writing a ref into text, and this surface writes nothing — it opens a tab.
 */
import { baseNameOf, dirNameOf, type FileWorkspaceTab, type IndexedFile } from "@volli/shared";

import { isHomeBoardTab } from "@renderer/components/home/home-tabs";
import { parseFileTabId } from "@renderer/components/ticket/ticket-file-tab";
import { rankIndexedFiles } from "@renderer/editor/file-refs";
import type { NavKey, WorkspaceUiState } from "@renderer/stores/workspace";

/**
 * Which checkout ⌘P searches, and therefore which surface a pick lands in.
 *
 * The pair IS the `volli:file-index` scope argument: `home` sends
 * `{ projectId }` and gets Main, `ticket` sends `{ projectId, ticketId }` and
 * gets that ticket's worktree — the same pair `volli:file-read` takes, resolved
 * by the same seam in main.
 */
export type QuickOpenScope =
  | { readonly kind: "home"; readonly projectId: string }
  | { readonly kind: "ticket"; readonly projectId: string; readonly ticketId: string };

/**
 * The scope for whatever is in front, or `null` when nothing is (no project
 * selected — there is no checkout to search and nowhere for a file to land).
 *
 * The ticket arm is exactly `home-surface.tsx`'s own render condition: a Ticket
 * workspace takes Home's Board tab over, so it is the surface only while that
 * tab is in front AND a ticket is open. Every other arrangement — a Home
 * Session tab, a Home File tab, the board itself — is Home, and so is
 * Configure: `previewHomeFile` navigates back to Home as part of opening, so a
 * pick made from there lands somewhere real, while `previewTicketFile` does not
 * navigate and would open a tab nobody is looking at.
 *
 * Settings is deliberately not consulted. It is chrome over a workspace, not a
 * workspace: the surface underneath is still the one you invoked from, and the
 * overlay closes Settings on the way out — the same move ⌘K already makes.
 */
export function quickOpenScope(input: {
  projectId: string | null;
  nav: NavKey;
  homeActiveTab: string;
  openTicketId: string | null;
}): QuickOpenScope | null {
  const { projectId, openTicketId } = input;
  if (projectId === null) return null;
  if (input.nav === "home" && isHomeBoardTab(input.homeActiveTab) && openTicketId !== null) {
    return { kind: "ticket", projectId, ticketId: openTicketId };
  }
  return { kind: "home", projectId };
}

/** A surface's File tabs, as {@link quickOpenIntent} needs to see them. */
export interface QuickOpenSurfaceFiles {
  readonly tabs: readonly FileWorkspaceTab[];
  /** The relPath of the tab in front, or `null` when a non-file tab is. */
  readonly activeFileRelPath: string | null;
}

/**
 * The scope's own File tabs, read out of the project's workspace record.
 *
 * Home and a Ticket workspace keep their tabs in different fields for a
 * durable reason (decision #54: the same relPath in two checkouts is two
 * different documents), and this is the one place that mapping is made — so
 * the scope that chose which index to search also chooses which strip is
 * consulted, and a Ticket workspace can never be answered about Home's tabs.
 */
export function quickOpenSurfaceFiles(
  scope: QuickOpenScope,
  ui: WorkspaceUiState,
): QuickOpenSurfaceFiles {
  if (scope.kind === "ticket") {
    const tabs = ui.ticketTabs[scope.ticketId];
    return {
      tabs: tabs?.files ?? [],
      activeFileRelPath: tabs === undefined ? null : parseFileTabId(tabs.active),
    };
  }
  return {
    tabs: ui.projectFiles.tabs,
    activeFileRelPath: parseFileTabId(ui.homeActiveTab),
  };
}

/** One offered file: the name to read, the folder that disambiguates it, and the path a pick opens. */
export interface QuickOpenRow {
  readonly relPath: string;
  /** Basename — the thing being searched for. */
  readonly label: string;
  /** Its directory, shown beside it: an index is full of same-named files. */
  readonly detail: string;
  /** A `.volli/artifacts/` file, which the shared ranking already favours. */
  readonly artifact: boolean;
}

/** How many ranked rows the overlay draws — a jump list, not a search result page (VC-193 owns that). */
export const MAX_QUICK_OPEN_RESULTS = 50;

/**
 * What one query offers, best match first.
 *
 * An empty query is not an empty list: `scoreFileMatch` scores it by shape
 * alone, so a freshly opened overlay shows the index's most plausible entries
 * rather than a blank box waiting to be typed into.
 */
export function quickOpenRows(input: {
  query: string;
  index: readonly IndexedFile[];
}): readonly QuickOpenRow[] {
  return rankIndexedFiles({
    query: input.query.trim(),
    index: input.index,
    limit: MAX_QUICK_OPEN_RESULTS,
  }).map((file) => ({
    relPath: file.relPath,
    label: baseNameOf(file.relPath),
    detail: dirNameOf(file.relPath),
    artifact: file.artifact,
  }));
}

/** The navigator's two file gestures, which quick-open speaks rather than inventing its own. */
export type QuickOpenIntent = "preview" | "pin";

/**
 * Whether invoking `relPath` previews it or pins it — the rail navigator's
 * grammar (decision #56), re-asked for a list with no rows to click twice.
 *
 * Two things pin, and they are the same act said two ways:
 *
 *  - **⌘Enter** — the explicit second action, stated at the moment of opening.
 *  - **A second invoke** — Enter on the file that is *already the active
 *    preview tab*, which is what "open it again" means here. The navigator
 *    spells that as a double-click on the row it just previewed; a list that
 *    closes on the first Enter has no second click to offer, so the repeat is
 *    the second ⌘P instead.
 *
 * The active check is what keeps the second arm honest. Without it, any file
 * sitting in the preview slot from an hour ago would be pinned by a first
 * invoke — which is not a repeat of anything.
 */
export function quickOpenIntent(input: {
  relPath: string;
  /** An explicit pin gesture (⌘Enter). */
  pin: boolean;
  /** The surface's open File tabs. */
  tabs: readonly FileWorkspaceTab[];
  /** The relPath of the surface's active tab, or `null` when a non-file tab is in front. */
  activeFileRelPath: string | null;
}): QuickOpenIntent {
  if (input.pin) return "pin";
  if (input.activeFileRelPath !== input.relPath) return "preview";
  const tab = input.tabs.find((candidate) => candidate.relPath === input.relPath);
  return tab !== undefined && !tab.pinned ? "pin" : "preview";
}
