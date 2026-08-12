/**
 * The composer base-branch chip's reading of a project's refs, hoisted out of
 * the React layer so the branching lives in tested, plain TypeScript.
 *
 * All of it is about not lying to the user about what a base is: what this chip
 * shows is written to `ticket.baseBranch`, which outranks `project.base_branch`
 * for the rest of that ticket's life.
 *
 * - {@link BranchListingState} keeps a read that has not landed YET apart from
 *   one that will never land. They were one `null` once, so a failed read looked
 *   like an in-flight one forever: the chip held a draft-restored base it could
 *   not check, drew it as chosen, and submit stamped it. Only the in-flight
 *   answer may hold an unverified choice, because only it is about to be
 *   settled.
 * - {@link defaultBaseBranch} opens on the base the project is CONFIGURED with,
 *   and only then on the branch the checkout is parked on.
 * - {@link resolveBaseBranch} refuses to hand back a branch the project turns
 *   out not to have — the composer restores its draft across app launches, and a
 *   branch deleted meanwhile would otherwise sit in the chip looking chosen
 *   until worktree creation failed on it. A `chosen` value belongs to ONE
 *   project; scoping it to that project is the caller's job (see its doc).
 * - {@link groupBranchOptions} keeps local heads and remote-tracking refs in
 *   SEPARATE groups, and the remote group's heading carries the age of the
 *   snapshot it holds. A remote-tracking ref only moves on a fetch, and nothing
 *   in the worktree pipeline fetches on the user's behalf before branching — so
 *   an unlabeled `origin/main` in the same list as `main` would be presenting a
 *   ref that could be weeks old as the remote's tip.
 * - {@link baseChipLabel} draws a pending answer and a final one differently. An
 *   empty repo resolves to no base at all, and rendering that as the same `…`
 *   the in-flight read draws would show a settled answer as a waiting one.
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
 * Where the read of a project's refs stands. Three answers, never two: "not yet"
 * and "not ever" differ in exactly the way that matters here — whether an
 * unverified choice is about to be checked or never will be.
 */
export type BranchListingState =
  | { status: "loading" }
  | { status: "loaded"; listing: WorktreeBranchListing }
  | { status: "failed"; error: string };

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
 * there is no "current", its most recently committed branch, or a
 * remote-tracking ref for a checkout that has no local heads at all. `null` only
 * for a project with no refs whatsoever.
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
 *
 * The residue, stated plainly: a project that configures NO base — or configures
 * one it no longer has — still opens on `current`, the very "whatever the
 * checkout is parked on" this order exists to stop. It stands because the
 * alternative is worse, not because it is right. `null` would be the honest
 * answer and would leave main to detect a base itself (origin/HEAD, then the
 * current branch), but the chip would then have to say "unknown" for a case
 * where a base certainly gets used, and it cannot compute main's answer to say
 * anything better: `listBranches` drops every ref whose name ends in `/HEAD`
 * from `remotes`, so origin's default is not in this payload at all. Adding a project detects a base for it
 * (`data-ipc.ts`, `volli:project-add`), so the residue is the project whose base
 * was cleared or deleted since.
 */
export function defaultBaseBranch(
  listing: WorktreeBranchListing,
  projectBaseBranch: string | null,
): string | null {
  if (projectBaseBranch !== null && listingHas(listing, projectBaseBranch)) {
    return projectBaseBranch;
  }
  return listing.current ?? listing.branches[0] ?? listing.remotes[0] ?? null;
}

/**
 * The base to show given a `chosen` value (restored from a draft, or picked
 * earlier in this composer) and the state of the project's refs.
 *
 * This is one value, not two, because the composer both DISPLAYS it and SUBMITS
 * it. A create that beats the refs home would otherwise record a different base
 * than the one the user was looking at, which makes the same click write
 * different durable data depending on how fast a `for-each-ref` returned.
 *
 * The three states answer differently, and the difference is the point:
 *
 * - `loading` holds `chosen` as-is: the read is about to settle it, and blanking
 *   a chip the user already set for the width of an IPC round trip would be its
 *   own lie. With no choice, the configured base stands in — it is the safe
 *   stand-in precisely because it is what main resolves anyway for a ticket that
 *   records nothing.
 * - `loaded` keeps `chosen` when the project still has it and falls to the
 *   default when it does not.
 * - `failed` drops `chosen` entirely. Nothing here can be checked against
 *   anything, and an unverifiable ref is not made true by being stamped: git
 *   takes the bare name at worktree time and errors, so the ticket would carry
 *   an unusable base forever with nothing at submit time saying so. The
 *   configured base — a live field of the project, not a remembered string —
 *   stands in, and `null` past that is main's cue to resolve one itself.
 *
 * `chosen` names a ref in ONE repo. Keeping it scoped to the project it was
 * chosen for is the caller's job (`composer-form` clears it on retarget and
 * restores it only for the draft's own project), and it has to be: two projects
 * that both have a `develop` would pass every check here while branching the
 * work off an unrelated commit.
 */
export function resolveBaseBranch(
  chosen: string | null,
  state: BranchListingState,
  projectBaseBranch: string | null,
): string | null {
  switch (state.status) {
    case "loading":
      return chosen ?? projectBaseBranch;
    case "failed":
      return projectBaseBranch;
    case "loaded":
      if (chosen !== null && listingHas(state.listing, chosen)) return chosen;
      return defaultBaseBranch(state.listing, projectBaseBranch);
  }
}

/** What the base chip draws, and what it says. */
export interface BaseChipLabel {
  /** The chip's visible text. */
  text: string;
  /** The same answer as words — `…` is a glyph, and a glyph reads as nothing aloud. */
  spoken: string;
}

/**
 * The chip's own reading of {@link resolveBaseBranch}'s answer. A base to show
 * is its own label; the three ways there can be none are not interchangeable,
 * and drawing them alike is what made a repo with no branches sit at `…`
 * forever, a settled answer wearing a pending one's clothes.
 */
export function baseChipLabel(value: string | null, state: BranchListingState): BaseChipLabel {
  if (value !== null) return { text: value, spoken: value };
  switch (state.status) {
    case "loading":
      return { text: "…", spoken: "reading branches" };
    case "failed":
      return { text: "unknown", spoken: "unknown" };
    case "loaded":
      return { text: "no branches", spoken: "no branches" };
  }
}

/** Case-insensitive substring match — the picker filters, it does not rank. */
function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.trim().toLowerCase());
}

/**
 * The picker's list for `query`. Empty groups are dropped, so a repo with no
 * remote shows one group and a query matching only remotes shows only that one.
 *
 * `now` is passed by the view at the moment the picker OPENS rather than read
 * here per render: the remote heading dates a snapshot, and a heading computed
 * once at mount would still read "fetched 2h ago" on a dialog left open all
 * afternoon.
 */
export function groupBranchOptions(
  state: BranchListingState,
  query: string,
  now: number = Date.now(),
): BranchGroup[] {
  if (state.status !== "loaded") return [];
  const listing = state.listing;
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
