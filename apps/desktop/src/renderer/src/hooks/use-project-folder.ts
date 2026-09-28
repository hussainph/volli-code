/**
 * Whether a project's registered folder is still on disk (VC-430).
 *
 * Nothing on the machine tells Volli that a folder was renamed or moved, so
 * the app has to look. This is the one place it does, for the same reason
 * `use-project-roots-sync.ts` beside it is the one place roots are mirrored:
 * two surfaces asking the same question two ways would eventually disagree
 * about whether a project is reachable.
 *
 * It re-asks whenever the PATH changes, which is what makes a completed
 * relink clear the banner that offered it — the store replaces the row, the
 * path in the dependency list moves, and the check runs again against the new
 * folder without anyone having to remember to invalidate anything.
 */
import * as React from "react";
import type { ProjectFolderState } from "@volli/shared";

/**
 * What a look at the registered folder of `projectId` found; `null` until the
 * first look lands.
 *
 * `path` is never read here — `checkFolder` reads the authoritative row — but
 * it is the dependency that matters: a relink changes it, and that is exactly
 * when this has to look again.
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

  React.useEffect(() => {
    if (projectId === null) {
      setState(null);
      return;
    }
    let live = true;
    void window.api.projects
      .checkFolder(projectId)
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
  }, [projectId, path]);

  return state;
}
