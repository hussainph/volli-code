/**
 * The WORKING COPY: the checkout a Session runs in, measured (VC-55).
 *
 * A Board Session runs in the project's own main checkout — the user's
 * working tree — and a Ticket Session runs in a throwaway worktree. That
 * difference is "safe to let it run" against "it is editing my working tree",
 * and nothing on a chat surface used to say which one you were looking at. The
 * answer is not a label: it is this measurement, drawn.
 *
 * NOT the Runner a Session executes on — a `SessionLocation`'s `venue`, a
 * {@link import("./session-ledger").RunnerIdentity} such as
 * {@link import("./session-ledger").LOCAL_RUNNER}. This is that location's
 * `directory` — the tree on disk — plus what git says is in it. The two sit
 * beside each other in the domain and answer different questions: WHERE the
 * process runs, versus WHAT it is standing in. (Formerly the "venue" types;
 * the IPC door was `volli:venue-snapshot`.)
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
 * Board Session is, and it must draw the same way. That is what lets one
 * visual serve both scopes honestly.
 */
export type WorkingCopyKind = "main-checkout" | "worktree";

/**
 * A file's state in the working copy, and the four are DISJOINT by construction —
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
export type WorkingCopyFileState = "committed" | "modified" | "added" | "untracked";

/** The four states' counts. Every changed file in the working copy is in exactly one. */
export interface WorkingCopyFileCounts {
  committed: number;
  modified: number;
  added: number;
  untracked: number;
}

/** Lines this branch has moved against its base — the hairline track's two numbers. */
export interface WorkingCopyLineDiff {
  added: number;
  removed: number;
  /** The base branch the lines are measured against; the caption's `vs <base>`. */
  base: string;
}

/**
 * One working copy, as of one reading.
 *
 * `diff` is `null` whenever there is no base to measure against — every main
 * checkout, and a worktree whose base branch is unknown. The visual then DROPS
 * the hairline rather than drawing an empty one: an empty diff track reads as
 * "no work", which is the opposite of what a dirty main checkout means, and the
 * missing hairline does identity work for free.
 */
export interface WorkingCopySnapshot {
  kind: WorkingCopyKind;
  /** Absolute path of the checkout. */
  path: string;
  /** The branch checked out there; `null` when HEAD is detached. */
  branch: string | null;
  files: WorkingCopyFileCounts;
  diff: WorkingCopyLineDiff | null;
}

/**
 * What one working copy read ANSWERS: a measurement, or the fact that there is not yet
 * a checkout to measure (VC-286).
 *
 * `pending` is the state a ticket is in between "runs in an isolated worktree"
 * and "has one": configured for a worktree that has not materialised, had its
 * worktree removed, or had creation fail. It is deliberately NOT the main
 * checkout. The Session runtime refuses to bind such a ticket anywhere
 * (`session-runtime/location.ts` ensures or fails), so a main-checkout
 * measurement here would be a reading of a tree no Session will run in — two
 * answers on one screen about where the agent works, which is the bug this
 * type exists to make unrepresentable.
 *
 * A ticket that runs in the main checkout BY CONFIGURATION is `measured` like
 * any other: that working copy is true, and it is where its Session really binds.
 */
export type WorkingCopyReading =
  | { state: "measured"; workingCopy: WorkingCopySnapshot }
  | { state: "pending" };

/** The order segments are drawn in, committed first: progress before exposure. */
export const WORKING_COPY_FILE_STATES: readonly WorkingCopyFileState[] = [
  "committed",
  "modified",
  "added",
  "untracked",
];

/** Every file this working copy has touched, committed or not — the bar's stated total. */
export function workingCopyFileTotal(files: WorkingCopyFileCounts): number {
  return files.committed + files.modified + files.added + files.untracked;
}

/** Dirty right now: everything the tree would lose. The rail's loose count. */
export function workingCopyLooseCount(files: WorkingCopyFileCounts): number {
  return files.modified + files.added + files.untracked;
}

/** One drawn segment of the file bar. */
export interface WorkingCopySegment {
  state: WorkingCopyFileState;
  count: number;
}

/**
 * The bar's segments in draw order, empty states omitted.
 *
 * Omitting the zeroes is what keeps a one-state working copy a single solid bar
 * instead of a bar with three invisible neighbours it still has to lay out; the
 * counts that survive still sum to {@link workingCopyFileTotal}, which is the claim
 * the drawing makes.
 */
export function workingCopySegments(files: WorkingCopyFileCounts): readonly WorkingCopySegment[] {
  return WORKING_COPY_FILE_STATES.map((state) => ({ state, count: files[state] })).filter(
    (segment) => segment.count > 0,
  );
}
