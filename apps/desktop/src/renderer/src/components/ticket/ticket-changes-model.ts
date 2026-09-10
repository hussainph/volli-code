/**
 * Pure presentation for the Changes navigator (decision #53).
 *
 * The Changes rail is a compact flat list: filename leads, parent path stays muted
 * and secondary, status + line counts trail. Deep repository structure belongs to
 * the project-level Files surface — not here. All formatting and sort rules live
 * in this module so the React panel stays a thin shell.
 */

import {
  baseNameOf,
  dirNameOf,
  type ChangeSetFile,
  type ChangeSetFileStatus,
  type ChangeSetSnapshot,
} from "@volli/shared";

import { isChangeUpdated, type ChangeRecencyState } from "./ticket-change-recency";

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
 * as `+0 −0` — they show `"Binary"`. Any unreadable/racing path with null
 * counts and no binary flag returns `null` so the row can omit the counts.
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
  /**
   * Visible passive-awareness copy. Set only by
   * {@link presentChangeRowWithRecency} — the plain {@link presentChangeRow}
   * projection is deliberately recency-free, so a row built without the recency
   * state simply omits it rather than claiming the file is current.
   */
  updatedLabel?: "Updated";
  /** Accessible explanation accompanying {@link updatedLabel}. */
  updatedDescription?: typeof CHANGE_UPDATED_DESCRIPTION;
  /**
   * The activation target's accessible name — one string carrying everything a
   * screen reader must say about the row (VC-311): status, FULL path (the two
   * visible lines truncate), counts in words, rename origin, recency. Composed
   * here rather than in the panel because every word of it is presentation
   * policy, and the panel is a thin shell.
   */
  accessibleName: string;
}

const CHANGE_UPDATED_DESCRIPTION = "Updated since you last opened this file" as const;

/** Counts as words for {@link ChangeRowPresentation.accessibleName}. */
function spokenCounts(file: ChangeSetFile): string | null {
  if (file.binary) return "binary file";
  if (file.insertions === null || file.deletions === null) return null;
  const insertions = `${file.insertions} insertion${file.insertions === 1 ? "" : "s"}`;
  const deletions = `${file.deletions} deletion${file.deletions === 1 ? "" : "s"}`;
  return `${insertions}, ${deletions}`;
}

/** Compose the full row presentation from a Change Set file. */
export function presentChangeRow(file: ChangeSetFile): ChangeRowPresentation {
  const { filename, parentPath } = splitChangePath(file.path);
  const counts = spokenCounts(file);
  return {
    path: file.path,
    filename,
    parentPath,
    statusLabel: formatChangeStatus(file.status),
    countsLabel: formatChangeCounts(file),
    renameFrom: file.previousPath ?? null,
    accessibleName: [
      `${formatChangeStatus(file.status)}: ${file.path}`,
      counts,
      file.previousPath !== undefined ? `renamed from ${file.previousPath}` : null,
    ]
      .filter((part) => part !== null)
      .join(", "),
  };
}

/**
 * Project a Change Set row through passive recency awareness. Kept separate
 * from {@link presentChangeRow} so the latter remains safe as an `Array.map`
 * callback in existing navigator code.
 */
export function presentChangeRowWithRecency(
  file: ChangeSetFile,
  recency: ChangeRecencyState,
): ChangeRowPresentation {
  const row = presentChangeRow(file);
  return {
    ...row,
    ...(isChangeUpdated(recency, file.path)
      ? {
          updatedLabel: "Updated" as const,
          updatedDescription: CHANGE_UPDATED_DESCRIPTION,
          accessibleName: `${row.accessibleName}, ${CHANGE_UPDATED_DESCRIPTION.toLowerCase()}`,
        }
      : {}),
  };
}

/** Stable path-ordered flat list (decision #53 — never a tree). */
export function sortChangeSetFiles(files: readonly ChangeSetFile[]): ChangeSetFile[] {
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Navigator state the panel mirrors: the rows, and the fingerprint that says
 * whether they changed.
 *
 * WHICH ROW IS CURRENT IS NOT HERE, and that is the point (VC-311). It used to
 * be `listFocusPath`, written by a click and never rewritten when the diff it
 * opened was closed — so a row went on announcing itself as the current one
 * long after its tab was gone. The one fact that cannot go stale is the tab the
 * surface is actually showing, so the panel derives the current row from
 * `activeTabId` instead of storing a second copy of it here.
 */
export interface ChangesNavigatorState {
  revision: string | null;
  files: ChangeSetFile[];
  /** Paths the snapshot's cap left out of `files`, so the list can say so. */
  hiddenCount: number;
}

/**
 * Apply a fresh Change Set snapshot to the navigator. Updates rows and the
 * opaque revision fingerprint — and **nothing else**. It holds nothing a tab or
 * a focus ring could be read out of, so a refresh cannot open, close, replace
 * or focus anything (decision #48). A matching `revision` is a no-op (same
 * object identity) so React can skip re-renders.
 */
export function applyChangeSetRefresh(
  state: ChangesNavigatorState,
  snapshot: ChangeSetSnapshot,
): ChangesNavigatorState {
  if (state.revision === snapshot.revision) return state;
  return {
    ...state,
    revision: snapshot.revision,
    files: sortChangeSetFiles(snapshot.files),
    hiddenCount: Math.max(0, snapshot.totalCount - snapshot.files.length),
  };
}
