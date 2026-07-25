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

/** One flat-list row ready for the Changes navigator. */
export interface ChangeRowPresentation {
  path: string;
  filename: string;
  parentPath: string;
  statusLabel: string;
  countsLabel: string | null;
  /** Prior path for renames; null otherwise. */
  renameFrom: string | null;
}

/** Compose the full row presentation from a Change Set file. */
export function presentChangeRow(file: ChangeSetFile): ChangeRowPresentation {
  const { filename, parentPath } = splitChangePath(file.path);
  return {
    path: file.path,
    filename,
    parentPath,
    statusLabel: formatChangeStatus(file.status),
    countsLabel: formatChangeCounts(file),
    renameFrom: file.previousPath ?? null,
  };
}

/** Stable path-ordered flat list (decision #53 — never a tree). */
export function sortChangeSetFiles(files: readonly ChangeSetFile[]): ChangeSetFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
