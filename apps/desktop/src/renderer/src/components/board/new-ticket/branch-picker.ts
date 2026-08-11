/**
 * The composer base-branch chip's reading of a project's refs, hoisted out of
 * the React layer so the branching lives in tested, plain TypeScript.
 *
 * Three jobs, and all of them are about not lying to the user about what a base
 * is:
 *
 * - {@link defaultBaseBranch} opens on the base the project is CONFIGURED with,
 *   and only falls back to the branch the checkout is parked on. What this chip
 *   shows is written to `ticket.baseBranch`, which outranks the project setting
 *   for the rest of that ticket's life.
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

/** Whether the project still has `name`, as a local head or a remote-tracking ref. */
function listingHas(listing: WorktreeBranchListing, name: string): boolean {
  return listing.branches.includes(name) || listing.remotes.includes(name);
}

/**
 * The base a fresh composer opens on: the base configured for the project, and
 * failing that the project checkout's own branch — or, for a detached HEAD where
 * there is no "current", its most recently committed branch. `null` only for a
 * project with no branches at all.
 *
 * That order is the whole point, and it used to be the other way round.
 * `current` is whatever the checkout happens to be parked on, which for anyone
 * who leaves a feature branch checked out is not a base at all; the configured
 * value is a deliberate statement about where new work starts, and main resolves
 * bases in exactly that order too (`main/worktree/base.ts`: `ticket.baseBranch`
 * → `project.base_branch` → detection). Opening on `current` did not merely
 * disagree with the configured base, it PRE-EMPTED it durably — the composer's
 * guess is written to `ticket.baseBranch`, which outranks the project's setting
 * from then on.
 *
 * A configured base the project no longer has is skipped rather than shown: it
 * appears in no group of the picker, so it would sit in the chip looking chosen
 * while being unselectable, and fail only later at worktree creation.
 */
export function defaultBaseBranch(
  listing: WorktreeBranchListing | null,
  projectBaseBranch: string | null,
): string | null {
  if (listing === null) return null;
  if (projectBaseBranch !== null && listingHas(listing, projectBaseBranch)) {
    return projectBaseBranch;
  }
  return listing.current ?? listing.branches[0] ?? null;
}

/**
 * The base to show given a `chosen` value (restored from a draft, or picked
 * earlier in this composer) and the project's live refs.
 *
 * A null `listing` is "the refs have not arrived yet", NOT "the project has no
 * branches": the choice is held as-is rather than reset, so an in-flight read
 * can't blank a chip the user already set.
 *
 * With no choice to hold, the configured base stands in — and this is one value,
 * not two, because the composer both DISPLAYS it and SUBMITS it. A create that
 * beats the refs home would otherwise record a different base than the one the
 * user was looking at, which makes the same click write different durable data
 * depending on how fast a `for-each-ref` returned. The configured base is the
 * safe stand-in precisely because it is what main resolves anyway for a ticket
 * that records nothing; a project with no configured base has no honest answer
 * yet and keeps `null`, which is main's cue to resolve one itself rather than
 * this chip's cue to guess.
 */
export function resolveBaseBranch(
  chosen: string | null,
  listing: WorktreeBranchListing | null,
  projectBaseBranch: string | null,
): string | null {
  if (listing === null) return chosen ?? projectBaseBranch;
  if (chosen !== null && listingHas(listing, chosen)) return chosen;
  return defaultBaseBranch(listing, projectBaseBranch);
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
