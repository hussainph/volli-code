import * as React from "react";

import { toastError } from "@renderer/lib/toast";
import { errorMessage } from "@volli/shared";
import { useProjectsStore } from "@renderer/stores/projects";

/** Push the current set of project paths at main's fs-root allowlist. */
async function pushRoots(): Promise<void> {
  await window.api.projects.syncRoots(
    useProjectsStore.getState().projects.map((project) => project.path),
  );
}

/**
 * Wait for main's fs-root allowlist to know this window's projects, then report
 * that browsing may begin.
 *
 * Every fs-browsing surface needs this and none of them can assume AppShell got
 * there first: React runs CHILD effects before parent ones, so a tree or a
 * navigator mounting under the shell issues its first `list-directory` before
 * the shell's own mirror lands, and main rejects it as "outside known
 * projects". `syncRoots` is idempotent, so re-asserting the full set costs one
 * round trip and removes the ordering question entirely.
 *
 * Resolves `true` even when the push FAILED: AppShell mirrors the same roots,
 * so the allowlist may well be current regardless, and a listing that really
 * cannot be read reports its own error where the user is looking. Blocking the
 * surface forever on a sync nobody can see is the worse failure.
 */
export function useProjectRootsReady(): boolean {
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void pushRoots()
      .catch(() => {
        // The listing carries the actionable failure; see the doc above.
      })
      .then(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return ready;
}

/** Mirrors tracked project paths into the main process's fs-root allowlist. */
export function useProjectRootsSync(): void {
  // Key on the SET of paths, not the array identity: a rail reorder churns a
  // fresh projects array on every pointer-cross (live shuffle) yet never
  // changes the allowlist, so an order-independent digest keeps a single drag
  // from firing a burst of redundant syncRoots IPC round-trips.
  const rootsKey = useProjectsStore((state) =>
    state.projects
      .map((project) => project.path)
      .toSorted()
      .join("\n"),
  );

  React.useEffect(() => {
    pushRoots().catch((error: unknown) => {
      toastError(`Couldn't sync project roots: ${errorMessage(error)}`);
    });
  }, [rootsKey]);
}
