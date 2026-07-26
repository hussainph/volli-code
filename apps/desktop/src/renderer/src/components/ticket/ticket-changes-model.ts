/**
 * Pure presentation for the Changes navigator (decision #53 / monaco-migration §9).
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
  /** Visible passive-awareness copy, omitted until recency events are wired. */
  updatedLabel?: "Updated";
  /** Accessible explanation accompanying {@link updatedLabel}. */
  updatedDescription?: "Updated since you last opened this file";
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
          updatedDescription: "Updated since you last opened this file" as const,
        }
      : {}),
  };
}

/** Stable path-ordered flat list (decision #53 — never a tree). */
export function sortChangeSetFiles(files: readonly ChangeSetFile[]): ChangeSetFile[] {
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Navigator state the panel mirrors. `activeTabId` is observed only so refresh
 * can be proven never to touch the main strip; the list keeps its own focus.
 */
export interface ChangesNavigatorState {
  revision: string | null;
  files: ChangeSetFile[];
  /** Main-strip active tab id — refresh must leave this identical. */
  activeTabId: string;
  /** Path whose row holds keyboard focus in the Changes list (decision #48). */
  listFocusPath: string | null;
  /** Paths the snapshot's cap left out of `files`, so the list can say so. */
  hiddenCount: number;
}

/**
 * Apply a fresh Change Set snapshot to the navigator. Updates rows and the
 * opaque revision fingerprint — and **nothing else**. Never opens, closes,
 * replaces, or focuses a main-view tab; never moves list focus. A matching
 * `revision` is a no-op (same object identity) so React can skip re-renders.
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

/**
 * Deliberate row selection. Returns an `openPath` the host should open as a
 * diff tab (`openTicketDiff`). List focus moves to the row; `activeTabId` is
 * intentionally unchanged so initial keyboard focus stays in the Changes list
 * (decision #48).
 */
export function selectChangeRow(
  state: ChangesNavigatorState,
  path: string,
): { state: ChangesNavigatorState; openPath: string } {
  return { state: { ...state, listFocusPath: path }, openPath: path };
}
