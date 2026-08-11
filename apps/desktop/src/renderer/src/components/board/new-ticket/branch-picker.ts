/**
 * The composer base-branch chip's reading of a project's refs, hoisted out of
 * the React layer so the branching lives in tested, plain TypeScript.
 *
 * Two jobs, and both are about not lying to the user about what a base is:
 *
 * - {@link groupBranchOptions} keeps local heads and remote-tracking refs in
 *   SEPARATE groups, and the remote group's heading carries the age of the
 *   snapshot it holds. A remote-tracking ref only moves on a fetch, and nothing
 *   in the worktree pipeline fetches on the user's behalf before branching — so
 *   an unlabeled `origin/main` in the same list as `main` would be presenting a
 *   ref that could be weeks old as the remote's tip.
 * - {@link resolveBaseBranch} refuses to hand back a branch the project no
 *   longer has. The composer restores its draft across app launches, and a
 *   branch that was deleted meanwhile would otherwise sit in the chip looking
 *   chosen until worktree creation failed on it.
 */
import type { WorktreeBranchListing } from "@volli/shared";

import { relativeTime } from "@renderer/lib/relative-time";

/** One pickable ref. `name` is the string git takes: `main` or `origin/main`. */
export interface BranchOption {
  name: string;
  /** A remote-tracking snapshot rather than a local head — the picker marks these. */
  remote: boolean;
}

/** A titled run of options. Headings are sentence case; the view decides casing. */
export interface BranchGroup {
  key: "local" | "remote";
  heading: string;
  options: BranchOption[];
}

/**
 * How old the remote-tracking refs are. `null` reads as "never fetched" rather
 * than as an absence, because "we have no origin snapshot at all" is the more
 * alarming of the two answers and the one worth saying out loud.
 */
export function fetchedLabel(fetchedAt: number | null, now: number = Date.now()): string {
  return fetchedAt === null ? "never fetched" : `fetched ${relativeTime(fetchedAt, now)}`;
}

/**
 * The base a fresh composer opens on: the project checkout's own branch, or —
 * for a detached HEAD, where there is no "current" — its most recently
 * committed branch. `null` only for a project with no branches at all.
 */
export function defaultBaseBranch(listing: WorktreeBranchListing | null): string | null {
  if (listing === null) return null;
  return listing.current ?? listing.branches[0] ?? null;
}

/**
 * The base to show given a `chosen` value (restored from a draft, or picked
 * earlier in this composer) and the project's live refs.
 *
 * A null `listing` is "the refs have not arrived yet", NOT "the project has no
 * branches": the choice is held as-is rather than reset, so an in-flight read
 * can't blank a chip the user already set.
 */
export function resolveBaseBranch(
  chosen: string | null,
  listing: WorktreeBranchListing | null,
): string | null {
  if (listing === null) return chosen;
  if (chosen !== null && (listing.branches.includes(chosen) || listing.remotes.includes(chosen))) {
    return chosen;
  }
  return defaultBaseBranch(listing);
}

/** Case-insensitive substring match — the picker filters, it does not rank. */
function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.trim().toLowerCase());
}

/**
 * The picker's list for `query`. Empty groups are dropped, so a repo with no
 * remote shows one group and a query matching only remotes shows only that one.
 */
export function groupBranchOptions(
  listing: WorktreeBranchListing | null,
  query: string,
  now: number = Date.now(),
): BranchGroup[] {
  if (listing === null) return [];
  const groups: BranchGroup[] = [];

  const local = listing.branches
    .filter((name) => matches(name, query))
    .map((name): BranchOption => ({ name, remote: false }));
  if (local.length > 0) groups.push({ key: "local", heading: "Branches", options: local });

  const remote = listing.remotes
    .filter((name) => matches(name, query))
    .map((name): BranchOption => ({ name, remote: true }));
  if (remote.length > 0) {
    groups.push({
      key: "remote",
      heading: `Remote · ${fetchedLabel(listing.fetchedAt, now)}`,
      options: remote,
    });
  }

  return groups;
}
