/**
 * The VENUE: the checkout a Session runs in, measured (VC-55).
 *
 * A Project Session runs in the project's own main checkout — the user's
 * working tree — and a Ticket Session runs in a throwaway worktree. That
 * difference is "safe to let it run" against "it is editing my working tree",
 * and nothing on a chat surface used to say which one you were looking at. The
 * answer is not a label: it is this measurement, drawn.
 *
 * NOT {@link import("./session-ledger").SessionLocation}'s `venue`, which names
 * the HOST a Session executes on (`{ id: "local", kind: "local" }`) and will
 * one day distinguish this machine from a remote runner. This is that
 * location's `directory` — the tree on disk — plus what git says is in it. The
 * two words sit beside each other in the domain and answer different questions:
 * WHERE the process runs, versus WHAT it is standing in.
 *
 * Crosses the IPC boundary (main computes it from git; the empty chat and the
 * Home rail consume it), so the shapes live here — the same argument
 * `change-set.ts` makes for its snapshot.
 */

/**
 * Which kind of checkout this is.
 *
 * Read off the checkout, never off the Session: a Ticket Session whose ticket
 * runs without an isolated worktree is standing in `main-checkout` exactly as a
 * Project Session is, and it must draw the same way. That is what lets one
 * visual serve both scopes honestly.
 */
export type VenueKind = "main-checkout" | "worktree";

/**
 * A file's state in the venue, and the four are DISJOINT by construction —
 * `committed` means changed on this branch and now clean in the tree.
 *
 * That disjointness is load-bearing rather than tidiness. A segmented bar is a
 * claim that its parts partition the whole, so the parts have to actually
 * partition: deriving the committed count from the diff's file list instead
 * double-counts every file that is both committed and dirty, and the prototype
 * printed "14 files" for a worktree holding 7 before this was fixed.
 *
 * `modified` is the honest bucket for every dirty tracked file that is not an
 * addition — edited, deleted, renamed, type-changed, or conflicted. The bar
 * answers "how much of this tree is in play", and each of those is in play.
 */
export type VenueFileState = "committed" | "modified" | "added" | "untracked";

/** The four states' counts. Every changed file in the venue is in exactly one. */
export interface VenueFileCounts {
  committed: number;
  modified: number;
  added: number;
  untracked: number;
}

/** Lines this branch has moved against its base — the hairline track's two numbers. */
export interface VenueLineDiff {
  added: number;
  removed: number;
  /** The base branch the lines are measured against; the caption's `vs <base>`. */
  base: string;
}

/**
 * One venue, as of one reading.
 *
 * `diff` is `null` whenever there is no base to measure against — every main
 * checkout, and a worktree whose base branch is unknown. The visual then DROPS
 * the hairline rather than drawing an empty one: an empty diff track reads as
 * "no work", which is the opposite of what a dirty main checkout means, and the
 * missing hairline does identity work for free.
 */
export interface VenueSnapshot {
  kind: VenueKind;
  /** Absolute path of the checkout. */
  path: string;
  /** The branch checked out there; `null` when HEAD is detached. */
  branch: string | null;
  files: VenueFileCounts;
  diff: VenueLineDiff | null;
}

/** The order segments are drawn in, committed first: progress before exposure. */
export const VENUE_FILE_STATES: readonly VenueFileState[] = [
  "committed",
  "modified",
  "added",
  "untracked",
];

/** Every file this venue has touched, committed or not — the bar's stated total. */
export function venueFileTotal(files: VenueFileCounts): number {
  return files.committed + files.modified + files.added + files.untracked;
}

/** Dirty right now: everything the tree would lose. The rail's loose count. */
export function venueLooseCount(files: VenueFileCounts): number {
  return files.modified + files.added + files.untracked;
}

/** One drawn segment of the file bar. */
export interface VenueSegment {
  state: VenueFileState;
  count: number;
}

/**
 * The bar's segments in draw order, empty states omitted.
 *
 * Omitting the zeroes is what keeps a one-state venue a single solid bar
 * instead of a bar with three invisible neighbours it still has to lay out; the
 * counts that survive still sum to {@link venueFileTotal}, which is the claim
 * the drawing makes.
 */
export function venueSegments(files: VenueFileCounts): readonly VenueSegment[] {
  return VENUE_FILE_STATES.map((state) => ({ state, count: files[state] })).filter(
    (segment) => segment.count > 0,
  );
}
