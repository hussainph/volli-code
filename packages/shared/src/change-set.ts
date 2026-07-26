/**
 * The ticket-scoped Change Set (CONCEPT #47, monaco-migration §9): the worktree's
 * complete current outcome relative to its recorded base — committed, staged,
 * unstaged, and untracked together. Crosses the IPC boundary (main computes it;
 * the Changes rail and Properties summary consume it), so the shapes live here.
 */

import type { DiffFileStat, DiffStat } from "./ticket-events";

/** One file's outcome inside a {@link ChangeSetSnapshot}. */
export type ChangeSetFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  /** Unmerged / conflicted path (git name-status `U`, or an unrecognized code we refuse to drop). */
  | "conflicted";
/**
 * One path in a Change Set. `insertions`/`deletions` are `null` for binary
 * files (`git diff --numstat` prints `-\t-`) and typically for untracked files
 * (no base to count against). `previousPath` is set only for renames.
 */
export interface ChangeSetFile {
  path: string;
  previousPath?: string;
  status: ChangeSetFileStatus;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

/**
 * Ceiling on the `files` a snapshot carries.
 *
 * `git status -uall` expands untracked directories entry by entry, so a single
 * stray `node_modules` or build output an agent forgot to ignore is six figures
 * of paths — an IPC payload and a list render nobody asked for, for a Change
 * Set that is unreadable at that size anyway. Beyond this the list is cut and
 * the snapshot says so; the totals are still counted over everything.
 */
export const CHANGE_SET_FILE_CAP = 1000;

/**
 * A composed Change Set snapshot: the resolved base SHA, current HEAD SHA, the
 * unified file list, text-only line totals, and an opaque `revision` the
 * renderer can use to detect staleness without deep-comparing `files`.
 *
 * `files` is capped at {@link CHANGE_SET_FILE_CAP}. When it was cut,
 * `truncated` is true and `totalCount` is how many paths the Change Set really
 * has — `insertions`/`deletions` always cover all of them, cut or not, so the
 * summary line never disagrees with the diff.
 */
export interface ChangeSetSnapshot {
  baseRevision: string;
  headRevision: string;
  files: ChangeSetFile[];
  insertions: number;
  deletions: number;
  revision: string;
  /** True when `files` is a prefix of the real list (see {@link CHANGE_SET_FILE_CAP}). */
  truncated: boolean;
  /** Total changed paths, which is `files.length` unless `truncated`. */
  totalCount: number;
}

/**
 * Projects a Change Set into the legacy {@link DiffStat} shape so the Details
 * Properties summary and the Changes rail cannot disagree (monaco-migration §9).
 * Binary and untracked entries keep null counts and never contribute to totals.
 */
export function changeSetToDiffStat(snapshot: ChangeSetSnapshot): DiffStat {
  const files: DiffFileStat[] = snapshot.files.map((file) => ({
    path: file.path,
    insertions: file.insertions,
    deletions: file.deletions,
    untracked: file.status === "untracked",
  }));
  return {
    files,
    insertions: snapshot.insertions,
    deletions: snapshot.deletions,
  };
}
