/**
 * Whether a project's registered folder is still on disk (VC-430).
 *
 * Nothing on the machine tells Volli that a folder was renamed or moved, so
 * the app has to look. This is the one place it does, for the same reason
 * `use-project-roots-sync.ts` beside it is the one place roots are mirrored:
 * two surfaces asking the same question two ways would eventually disagree
 * about whether a project is reachable.
 *
 * It re-asks on two occasions, and each one is a way the answer can change
 * without this hook being told:
 *
 *  - the PATH changed, which is what makes a completed relink clear the banner
 *    that offered it — the store replaces the row, the path in the dependency
 *    list moves, and the check runs again against the new folder;
 *  - the window regained FOCUS, which is the occasion that matters for the
 *    fault itself. A folder is renamed in Finder or in a terminal, so it is
 *    renamed while Volli is in the background; asking again on the way back is
 *    what turns "the board looked fine" into "the board says what is wrong".
 *
 * There is no poll and no subscription to data changes. Nothing Volli writes
 * can move a folder, so a ticket mutation is not news here, and the point of a
 * fault surface is that it is there when the person comes back — not that it
 * appears within some number of seconds of a change nobody was watching.
 */
import * as React from "react";
import type { ProjectFolderState } from "@volli/shared";

import { useProjectsStore } from "@renderer/stores/projects";

/**
 * What a look at the registered folder of `projectId` found; `null` until the
 * first look lands.
 *
 * `path` is never read here — the check reads the authoritative row — but it is
 * the dependency that matters: a relink changes it, and that is exactly when
 * this has to look again.
 *
 * A `projectId` of `null` (no project selected) reports `null` and asks
 * nothing. A check that FAILS also reports `null` rather than `"missing"`:
 * "we could not look" and "it is not there" are different facts, and only the
 * second one should ever put a recovery banner on screen.
 */
export function useProjectFolder(
  projectId: string | null,
  path: string | null,
): ProjectFolderState | null {
  const [state, setState] = React.useState<ProjectFolderState | null>(null);
  const checkFolder = useProjectsStore((store) => store.checkFolder);
  // Bumped on the way back into the app, which is when a rename that happened
  // elsewhere becomes visible.
  const [epoch, setEpoch] = React.useState(0);

  React.useEffect(() => {
    const recheck = (): void => setEpoch((previous) => previous + 1);
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, []);

  React.useEffect(() => {
    if (projectId === null) {
      setState(null);
      return;
    }
    let live = true;
    void checkFolder(projectId)
      .then((result) => {
        if (live) setState(result.ok ? result.state : null);
      })
      .catch(() => {
        // A check that could not run is not evidence of a missing folder, and
        // there is nothing here for a person to act on: the surfaces that
        // actually use the folder report their own failures where the user is
        // looking. Staying quiet is the whole handling.
        if (live) setState(null);
      });
    return () => {
      live = false;
    };
  }, [projectId, path, epoch, checkFolder]);

  return state;
}
