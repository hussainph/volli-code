/**
 * Pure presentation for the Changes navigator (decision #53 / monaco-migration §9).
 *
 * The Changes rail is a compact flat list: filename leads, parent path stays muted
 * and secondary, status + line counts trail. Deep repository structure belongs to
 * the project-level Files surface — not here. All formatting and sort rules live
 * in this module so the React panel stays a thin shell.
 */

import { baseNameOf, dirNameOf, type ChangeSetFile, type ChangeSetFileStatus } from "@volli/shared";

const STATUS_LABELS: Record<ChangeSetFileStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
  conflicted: "Conflicted",
};

/** Filename + parent directory for a worktree-relative Change Set path. */
export function splitChangePath(path: string): { filename: string; parentPath: string } {
  return { filename: baseNameOf(path), parentPath: dirNameOf(path) };
}

/** Human label for a Change Set file status (including conflicted). */
export function formatChangeStatus(status: ChangeSetFileStatus): string {
  return STATUS_LABELS[status];
}

/**
 * Line-count presentation for a Change Set row. Binary files must never render
 * as `+0 −0` — they show `"Binary"`. Untracked/empty null counts with no binary
 * flag return `null` so the row can omit the counts entirely.
 */
export function formatChangeCounts(file: ChangeSetFile): string | null {
  if (file.binary) return "Binary";
  if (file.insertions === null || file.deletions === null) return null;
  return `+${file.insertions} −${file.deletions}`;
}
