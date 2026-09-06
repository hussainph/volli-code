/**
 * The Activity Island's background shell feed (VC-270): what the island's
 * `shells` cluster reads, as a React hook over `./island-shells-model.ts`.
 *
 * Its own module, built before the island's mount (VC-268) exists, so the
 * mount plugs it in with one import and one spread:
 *
 *     const { shells, flash } = useIslandShells(sessionId);
 *     model = { ...model, shells, flash: flash ?? model.flash };
 *
 * Everything here is a PROJECTION of `stores/background-shells.ts`, which is
 * itself a projection of main's BackgroundShellHost through one push. The
 * island never learns a pid, a cwd or a byte of output; it gets
 * {@link IslandShell}'s four fields and a flash per transition. The flash is
 * derived from TRANSITIONS between two projections, never from the store's
 * events: the island's "now" channel says what changed, and a re-projection
 * that changed nothing must not re-announce.
 */

import * as React from "react";

import type { IslandFlash, IslandShell } from "@volli/session-presentation";

import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { projectIslandShells, shellTransitionFlashes } from "./island-shells-model";

export {
  islandShellActions,
  projectIslandShells,
  shellTransitionFlashes,
} from "./island-shells-model";

const NO_SHELLS: readonly IslandShell[] = [];

/**
 * One Session's island shells and the latest transition among them.
 *
 * The projection is memoized on the Session's own slice of the store, so a
 * push about another Session hands back the same array and the island's
 * spring does not restart. The flash is held in state and replaced only by a
 * newer transition; the island's own hold (`useHeldFlash`) decides how long
 * it reads. What is already in the store on mount is state, not news, so the
 * first projection announces nothing.
 */
export function useIslandShells(sessionId: string): {
  shells: readonly IslandShell[];
  flash: IslandFlash | null;
} {
  const byId = useBackgroundShellsStore((state) => state.byId);
  const shells = React.useMemo(() => {
    const projected = projectIslandShells(Object.values(byId), sessionId);
    return projected.length === 0 ? NO_SHELLS : projected;
  }, [byId, sessionId]);
  // Keyed by identity of the projected rows rather than by the store slice:
  // two projections that read the same are the same for the island.
  const stable = useStableShells(shells);
  const previous = React.useRef<readonly IslandShell[] | null>(null);
  const [flash, setFlash] = React.useState<IslandFlash | null>(null);
  React.useEffect(() => {
    if (previous.current !== null) {
      const latest = shellTransitionFlashes(previous.current, stable).at(-1);
      if (latest !== undefined) setFlash(latest);
    }
    previous.current = stable;
  }, [stable]);
  return { shells: stable, flash };
}

/** The previous array when the projection reads the same, so consumers keyed on identity stay put. */
function useStableShells(next: readonly IslandShell[]): readonly IslandShell[] {
  const held = React.useRef(next);
  if (!sameShells(held.current, next)) held.current = next;
  return held.current;
}

function sameShells(a: readonly IslandShell[], b: readonly IslandShell[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((shell, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      shell.id === other.id &&
      shell.command === other.command &&
      shell.state === other.state &&
      shell.code === other.code
    );
  });
}
