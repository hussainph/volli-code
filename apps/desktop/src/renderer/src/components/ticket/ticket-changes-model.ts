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

/**
 * Where a FILENAME may be cut, so the cut never takes the tail a reader
 * compares filenames by (VC-311).
 *
 * Tail = everything from the first dot, because the audit's indistinguishable
 * pair — `split-view-divider.test.tsx` next to `split-view-divider.tsx` —
 * differs in the whole dotted run, not just the last extension: a cut at the
 * LAST dot would leave both rows ending `.tsx`. A dotfile (`.gitignore`) has
 * no dot after position 0, so it stays whole in the head — its distinguishing
 * characters sit early, which end-truncation already preserves. `tail: ""`
 * means "nothing is protected"; the caller truncates the head alone.
 */
export function splitFilenameForTruncation(filename: string): { head: string; tail: string } {
  const dot = filename.indexOf(".");
  return dot <= 0
    ? { head: filename, tail: "" }
    : { head: filename.slice(0, dot), tail: filename.slice(dot) };
}

/**
 * Where a PARENT PATH may be cut — same rule, one segment down: the last
 * directory survives, because that is the segment that tells two same-named
 * files apart (`components/split/rail.tsx` vs `components/ui/rail.tsx`), while
 * the head's early segments are context the rail can ellipsize first. The
 * separator rides in the TAIL so a truncated head joins it cleanly
 * (`apps/desktop/…` + `/split`); a repo-root file (parent `""`) has nothing to
 * protect.
 */
export function splitParentForTruncation(parentPath: string): { head: string; tail: string } {
  const slash = parentPath.lastIndexOf("/");
  return slash === -1
    ? { head: parentPath, tail: "" }
    : { head: parentPath.slice(0, slash), tail: parentPath.slice(slash) };
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
  updatedDescription?: "Updated since you last opened this file";
  /**
   * The activation target's accessible name — one string carrying everything a
   * screen reader must say about the row (VC-311): status, FULL path (the two
   * visible lines truncate), counts in words, rename origin, recency. Composed
   * here rather than in the panel because every word of it is presentation
   * policy, and the panel is a thin shell.
   */
  accessibleName: string;
}

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
          updatedDescription: "Updated since you last opened this file" as const,
          accessibleName: `${row.accessibleName}, updated since you last opened this file`,
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
