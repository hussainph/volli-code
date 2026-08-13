import * as React from "react";

import { toastError } from "@renderer/lib/toast";
import { errorMessage } from "@volli/shared";
import { useProjectsStore } from "@renderer/stores/projects";

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
    const paths = useProjectsStore.getState().projects.map((project) => project.path);
    window.api.projects.syncRoots(paths).catch((error: unknown) => {
      toastError(`Couldn't sync project roots: ${errorMessage(error)}`);
    });
  }, [rootsKey]);
}
