import * as React from "react";
import { errorMessage } from "@volli/shared";
import type { DirChangedEvent, DirPathInput } from "../../../ipc/contract";

import { rearmWatch } from "@renderer/editor/rearm-watch";
import { toastError } from "@renderer/lib/toast";

/** `projectId` + `relPath` as one unambiguous listener-map key. */
function dirKey(projectId: string, relPath: string): string {
  return `${projectId} ${relPath}`;
}

type DirChangedListener = () => void;

const dirListeners = new Map<string, Set<DirChangedListener>>();
let dirChangedSubscription: (() => void) | null = null;

function watchLabel(relPath: string): string {
  return relPath === "" ? "the project root" : relPath;
}

function dropWatch(input: DirPathInput): void {
  void window.api.files.unwatchDir(input).catch(() => {});
}

/** Arm one key, and undo a late success when its final listener already left. */
function armWatch(input: DirPathInput): void {
  void window.api.files
    .watchDir(input)
    .then((result) => {
      if (!dirListeners.has(dirKey(input.projectId, input.relPath))) {
        if (result.ok) dropWatch(input);
        return;
      }
      if (!result.ok) {
        toastError(
          `Live updates for ${watchLabel(input.relPath)} are unavailable: ${result.error}`,
        );
      }
    })
    .catch((error: unknown) => {
      if (dirListeners.has(dirKey(input.projectId, input.relPath))) {
        toastError(
          `Live updates for ${watchLabel(input.relPath)} are unavailable: ${errorMessage(error)}`,
        );
      }
    });
}

/**
 * Re-arm a watcher main declared final — ONCE for the level, not once per
 * consumer, which mirrors the single hold {@link subscribeDirChanged} takes.
 */
function rearmFinalWatch(event: DirChangedEvent): void {
  const input: DirPathInput = { projectId: event.projectId, relPath: event.relPath };
  void rearmWatch<DirPathInput>(
    {
      watch: (next) => window.api.files.watchDir(next),
      unwatch: (next) => window.api.files.unwatchDir(next),
    },
    input,
  ).then((result) => {
    if (!dirListeners.has(dirKey(input.projectId, input.relPath))) {
      if (result.ok) dropWatch(input);
      return;
    }
    if (!result.ok) {
      toastError(`Live updates for ${watchLabel(input.relPath)} are unavailable: ${result.error}`);
    }
  });
}

/**
 * One `onDirChanged` IPC subscription for every renderer directory consumer,
 * fanned out by project + level.
 *
 * ONE SUBSCRIPTION because an expanded tree routinely holds a few dozen open
 * levels, and a listener each on the same channel walks straight past Node's
 * max-listeners threshold for a purely bookkeeping reason.
 *
 * ONE HOLD PER LEVEL — the first listener arms main's watcher, the last tears
 * it down — because two surfaces now watch the same directory: the primary
 * file tree's root and Home's Files navigator. Main refcounts (`DirWatchManager.watch`
 * bumps, `unwatch` releases one hold), so a hold each would also be correct;
 * what it would not be is cheap. Counting here spends one `watchDir` round trip
 * per level instead of one per consumer, and leaves exactly one re-arm to run
 * when main declares the watcher final rather than a thundering herd of them.
 */
function subscribeDirChanged(
  projectId: string,
  relPath: string,
  listener: DirChangedListener,
): () => void {
  const key = dirKey(projectId, relPath);
  const listeners = dirListeners.get(key) ?? new Set<DirChangedListener>();
  const first = listeners.size === 0;
  listeners.add(listener);
  dirListeners.set(key, listeners);

  dirChangedSubscription ??= window.api.files.onDirChanged((event) => {
    const eventListeners = dirListeners.get(dirKey(event.projectId, event.relPath));
    if (eventListeners === undefined) return;
    for (const notify of eventListeners) notify();
    if (event.final === true) rearmFinalWatch(event);
  });
  if (first) armWatch({ projectId, relPath });

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    dirListeners.delete(key);
    dropWatch({ projectId, relPath });
    if (dirListeners.size === 0) {
      dirChangedSubscription?.();
      dirChangedSubscription = null;
    }
  };
}

/**
 * Keep one visible Main-checkout directory level live.
 *
 * The watcher is non-recursive; callers arm one hook per visible level and pass
 * `null` while the level is hidden. A final event means main lost the watcher,
 * so the shared subscription re-arms it after refreshing every consumer.
 */
export function useDirectoryWatch(
  projectId: string,
  relPath: string | null,
  refresh: () => void,
): void {
  const refreshRef = React.useRef(refresh);
  refreshRef.current = refresh;

  React.useEffect(() => {
    if (relPath === null) return;
    return subscribeDirChanged(projectId, relPath, () => refreshRef.current());
  }, [projectId, relPath]);
}
